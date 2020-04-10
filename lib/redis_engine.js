var ShardManager = require('shard-manager');
var redis = require('redis');
var Shavaluator = require('redis-evalsha');
var _ = require('underscore');

var RedisEngine = function(server, addresses, options) {
  var shards = _.map(addresses, function(address, index) {
    var components = address.split(':');
    var hostname = components[0];
    var port = components[1];

    var client = redis.createClient(port, hostname);
    var evalsha = new Shavaluator(client);

    /*
      ARGV[1] = clientId
      ARGV[2] = channel
      ARGV[3] = data
      ARGV[4] = presenceId
      ARGV[5] = currentDate
      KEYS[1] = data
      KEYS[2] = pid
      KEYS[3] = cids
      KEYS[4] = pids
    */
    evalsha.add('subscribe_presence', `
      local exists = redis.call('EXISTS', KEYS[1])

      redis.call('SET', KEYS[1], ARGV[3])
      redis.call('SET', KEYS[2], ARGV[4])
      redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
      redis.call('ZADD', KEYS[4], ARGV[5], ARGV[4])

      return exists
    `);

    /*
      ARGV[1] = clientId
      ARGV[2] = presenceId
      KEYS[1] = data
      KEYS[2] = pid
      KEYS[3] = cids
      KEYS[4] = pids
    */
    evalsha.add('unsubscribe_presence', `
      redis.call('DEL', KEYS[2])
      redis.call('ZREM', KEYS[3], ARGV[1])

      if redis.call('EXISTS', KEYS[3]) == 1 then
        return 1
      end

      redis.call('ZREM', KEYS[4], ARGV[2])
      redis.call('DEL', KEYS[1], ARGV[2])

      return 0
    `);

    return {
      shardName: 'node' + index,
      shard: {
        evalsha: evalsha,
        redis: client
      }
    };
  });

  this._logger = options.logger;
  this._server = server;
  this._shardManager = new ShardManager(shards);
}

RedisEngine.create = function(server, addresses, options) {
  return new RedisEngine(server, addresses, options);
}

function key() {
  // convert arguments into an array, in a way that won't screw up
  // the optimizer.
  var args = new Array(arguments.length);
  for(var i = 0; i < args.length; ++i) {
    args[i] = arguments[i];
  }

  return [ 'presence' ].concat(args).join(':');
}

/* Data structures in redis:

data:$channel:$presenceId = $presenceData
  Key/Value: stores the presenceData for the given presenceId and channel.

pid:$channel:$clientId = $presenceId
  Key/Value: stores the presenceId for the given channel and clientId.

cids:$channel:$presenceId -> [ $clientId, $clientId, ... ]
  Sorted Set: stores the list of client ids associated with a given channel
  and presenceId. Used to determine when all the clients for a given presenceId
  are gone. Sorted by addition time, possibly for future gc purposes.

pids:$channel -> [ $presenceId, $presenceId, ... ]
  Sorted Set: stores the list of presenceIds currently associated with a channel.
  This is the actual presence data for the channel. Sorted by "last subscription"
  time, which may be useful.

*/

RedisEngine.prototype = {
  // done will be called with (null, true) if this this presenceId is new,
  // and (null, false) otherwise.
  addClient: function(channel, clientId, presenceId, data, done) {
    // EXISTS cids:$channel:$presenceId
    // SET data:$channel:$presenceId $presenceData
    // SET pid:$channel:$clientId $presenceId
    // ZADD cids:$channel:$presenceId $now $clientId
    // ZADD pids:$channel $now $presenceId
    var self = this;

    self._logger('Registering client ? for presence channel ? ?', clientId, channel, presenceId);

    self._server._server._engine.clientExists(clientId, function (existsResult) {
      if(!existsResult) {
        self._logger('Will not register client ? for presence channel ? ?', clientId, channel, presenceId);

        return;
      }

      self._shardManager.getShard(channel).evalsha.exec('subscribe_presence', [
        key('data', channel, presenceId),
        key('pid', channel, clientId),
        key('cids', channel, presenceId),
        key('pids', channel),
      ], [
        clientId,
        channel,
        data,
        presenceId,
        Date.now(),
      ], function (err, results) {
        self._server._server._engine.clientExists(clientId, function (existsResult) {
          if(!existsResult) {
            self._logger('Client ? disappeared while registering for presence channel ? ?', clientId, channel, presenceId);

            self.unsubscribe(channel, clientId);

            return;
          } else if(results === 1) {
            self._logger('Registered new client ? for presence channel ? ? ?', clientId, channel, presenceId);

            done(null, false);
          } else if(results === 0) {
            self._logger('Registered initial client ? for presence channel ? ? ?', clientId, channel, presenceId);

            done(null, true);
          } else {
            self._logger('Failed to register client ? for presence channel ? ? ? ?', clientId, channel, presenceId, err, results);
          }
        });
      });
    });
  },

  getSubscribers: function(channel, done) {
    // ZSCAN 0 pids:$channel
    // (get $presenceIds)
    // MGET data:$channel:$presenceId ...
    // (loop until we have all, or up to MAX_PRESENCE)
    var self = this;
    var client = self._shardManager.getShard(channel).redis;

    var cursor = 0;

    function getNextBatch(presenceIdsToLoad, cursor, results, done) {
      var newPresenceIdsToLoad = null;

      var multi = client.multi();

      if (presenceIdsToLoad && presenceIdsToLoad.length > 0) {
        var presenceIdsWithChannel = _.map(presenceIdsToLoad, function(pid) {
          return key('data', channel, pid);
        });
        multi.mget(presenceIdsWithChannel, function(err, responses) {
          if (err) {
            console.log('redis error loading presence id data', err);
            return;
          }

          for (var i = 0; i < presenceIdsToLoad.length; i++) {
            results[presenceIdsToLoad[i]] = responses[i];
          }
        });
      }

      if (cursor >= 0) {
        multi.zscan(key('pids', channel), cursor, function(err, results) {
          if (err) {
            console.log('redis error iterating presence ids', err);
            return;
          }

          cursor = results[0];
          if (cursor === '0') {
            // we're done iterating, set to negative
            cursor = -1;
          }

          // strip out the scores which we don't need right now
          newPresenceIdsToLoad = _.filter(results[1], function(val, idx) { return idx % 2 == 0; });
        });
      }

      multi.exec(function(err) {
        if (err) {
          console.log('redis error loading presence ids for channel', err);
        }

        if (cursor > 0 || newPresenceIdsToLoad) {
          getNextBatch(newPresenceIdsToLoad, cursor, results, done);
        } else {
          done(err, results);
        }
      });
    }

    getNextBatch(null, 0, {}, function(err, results) {
      if (err) {
        console.log('error loading presence data batch', err);
        done(err, null);
        return;
      }

      done(null, results);
    });
  },

  getPresenceInfo: function(channel, clientId, done) {
    // $presenceId = GET pid:$channel:$clientId
    // $presenceData = GET data:$channel:presenceId
    var self = this;
    var client = self._shardManager.getShard(channel).redis;

    client.get(key('pid', channel, clientId), function(err, presenceId) {
      if (err) {
        console.log('error loading client presenceId', err);
        done(err);
        return;
      }
      client.get(key('data', channel, presenceId), function(err, presenceData) {
        if (err) {
          console.log('error loading presence data', err);
          done(err);
          return;
        }

        done(null, presenceData);
      });
    });
  },

  // done(null, presenceId, false) if the presenceId still exists after removing the
  // clientId. done(null, presenceId, true) if not, and the user is completely gone.
  unsubscribe: function(channel, clientId, done) {
    // $presenceId = GET pid:$channel:$clientId
    // DEL pid:$channel:$clientId
    // ZREM cids:$channel:$presenceId $clientId
    // $exists = EXISTS ids:$channel:$presenceId
    // if ($exists == 0) {
    //   # all client ids are gone, this user is actually unsubscribed
    //   ZREM pids:$channel $presenceId
    //   DEL data:$channel:$presenceId
    //   publish($channel, { event: 'unsubscribed', id: $presenceId, data: $presenceData })
    // }
    var self = this;
    var client = self._shardManager.getShard(channel).redis;

    client.get(key('pid', channel, clientId), function(err, presenceId) {
      self._logger('Deregistering client ? for presence channel ? ?', clientId, channel, presenceId);

      self._shardManager.getShard(channel).evalsha.exec('unsubscribe_presence', [
        key('data', channel, presenceId),
        key('pid', channel, clientId),
        key('cids', channel, presenceId),
        key('pids', channel),
      ], [
        clientId,
        presenceId,
      ], function (err, results) {
        if(results === 1) {
          self._logger('Deregistered client ? for presence channel ? ?', clientId, channel, presenceId);

          done(null, presenceId, false);
        } else if(results === 0) {
          self._logger('Deregistered final client ? for presence channel ? ?', clientId, channel, presenceId);

          done(null, presenceId, true);
        } else {
          self._logger('Failed to deregister client ? for presence channel ? ? ? ?', clientId, channel, presenceId, err, results);
        }
      });
    });
  }
};

module.exports = RedisEngine;
