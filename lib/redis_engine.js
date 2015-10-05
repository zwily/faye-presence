var ShardManager = require('shard-manager');
var redis = require('redis');
var _ = require('underscore');

var RedisEngine = function(addresses) {
  var shards = _.map(addresses, function(address, index) {
    var components = address.split(':');
    var hostname = components[0];
    var port = components[1];

    return {
      shardName: 'node' + index,
      shard: {
        redis: redis.createClient(port, hostname)
      }
    };
  });

  this._shardManager = new ShardManager(shards);
}

RedisEngine.create = function(server, options) {
  return new RedisEngine(server, options);
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
    var client = self._shardManager.getShard(channel).redis;

    var isNew = true;

    client.multi()
      .exists(key('data', channel, presenceId), function(err, exists) {
        if (exists == 1) {
          isNew = false;
        }
      })
      .set(key('data', channel, presenceId), data)
      .set(key('pid', channel, clientId), presenceId)
      .zadd(key('cids', channel, presenceId), Date.now(), clientId)
      .zadd(key('pids', channel), Date.now(), presenceId)
      .exec(function(err) {
        if (err) {
          console.log('redis error: ', err);
          done(err);
          return;
        }

        done(null, isNew);
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
      if (err) {
        console.log('error loading client presenceId', err);
        done(err);
        return;
      }

      var isLast = false;

      client.multi()
        .del(key('pid', channel, clientId), channel)
        .zrem(key('cids', channel, presenceId), clientId)
        .exists(key('cids', channel, presenceId), function(err, exists) {
          if (err) {
            console.log('error removing client subscription', err);
            return;
          }

          if (exists == 0) {
            isLast = true;
          }
        })
        .exec(function(err) {
          if (err) {
            console.log('error removing client subscription', err);
            done(err);
            return;
          }

          if (!isLast) {
            done(null, presenceId, false);
          } else {
            client.multi()
              .zrem(key('pids', channel), presenceId)
              .del(key('data', channel, presenceId))
              .exec(function(err) {
                if (err) {
                  console.log('error removing client subscription', err);
                  done(err);
                  return;
                }

                done(null, presenceId, true);
              });
          }
        });
    });
  }
};

module.exports = RedisEngine;
