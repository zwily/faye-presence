var RedisEngine = require('./lib/redis_engine');
var _ = require('underscore');

exports.setup = function(server, client, options) {
  var self = this;

  self.engine = options.engine || RedisEngine.create(options.servers);
  self.channelRe = options.channelRe || /^\/presence\//;

  server.addExtension({
    incoming: function(message, callback) {
      if (message.channel !== '/meta/subscribe' ||
          !message.subscription.match(self.channelRe)) {
        return callback(message);
      }

      if (!message.ext || !message.ext.presence || !message.ext.presence.id) {
        message.error = 'No presence id specified in presence subscription';
        return callback(message);
      }

      var data = message.ext.presence.data;
      if (data) {
        data = JSON.stringify(data);
      }

      self.engine.addClient(
        message.subscription,
        message.clientId,
        message.ext.presence.id,
        data,
        function(err, isNew) {
          if (err) {
            message.error = 'An error occurred subscribing to presence channel';
            console.log('error adding client to channel', err, message);
            return callback(message);
          }

          if (isNew) {
            var publish = {
              subscribe: {}
            };
            publish.subscribe[message.ext.presence.id] = message.ext.presence.data;

            client.publish(message.subscription, publish);
          }

          return callback(message);
        }
      );
    },

    outgoing: function(message, callback) {
      if (message.channel !== '/meta/subscribe' ||
          !message.subscription.match(self.channelRe)) {
        return callback(message);
      }

      self.engine.getSubscribers(message.subscription, function(err, subscribers) {
        subscribers = _.mapObject(subscribers, function(val) {
          return JSON.parse(val);
        });
        message.ext = message.ext || {};
        message.ext.presence = { subscribe: subscribers };
        return callback(message);
      });
    }
  });

  server.on('unsubscribe', function(clientId, channel) {
    if (!channel.match(self.channelRe)) {
      return;
    }

    self.engine.unsubscribe(channel, clientId, function(err, presenceId, isLast) {
      if (err) {
        console.log('error unsubscribing', clientId, channel, err);
        return;
      }

      if (isLast) {
        var publish = { unsubscribe: {} };
        publish.unsubscribe[presenceId] = null;

        client.publish(channel, publish);
      }
    });
  });
}
