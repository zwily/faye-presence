# Faye Presence [![Build Status](https://travis-ci.org/zwily/faye-presence.svg?branch=master)](https://travis-ci.org/zwily/faye-presence)

Presence channels are an addition to Faye implemented via an extension and
monitoring Faye events.

## Getting Started

Install `faye-presence`:

```
$ npm install faye-presence --save
```

After creating your Faye server, install the `faye-presence plugin`:

```javascript
var presence = require('faye-presence');

//...

var faye = new Faye.NodeAdapter(options);
presence.setup(faye, faye.getClient(), {
  servers: [ 'localhost:6379' ]
});
```

`servers` is an array of redis hostname/ports to use for storing presence data.

When a user subscribes to a channel starting with `/presence/`, they should also
include in the message some presence information. (This is done using a Faye client
plugin.) The outgoing subscription message should include an `ext` field that looks
like this:

```javascript
{
  ext: {
    presence: {
      id: 'username',
      data: {
        name: 'John Doe',
        avataur: 'http://example.com/avatar.png'
      }
    }
  }
}
```

The `data` field is optional and can be a javscript object with whatever information
you want. It is persisted in Redis as long as that client is subscribed to that
channel.

The subscription confirmation message from the server will then include a list of
everyone current subscribed to that channel. Again, this needs to be intercepted
using a client plugin:

```javascript
{
  ext: {
    presence: {
      subscribe: {
        $id: $data,
        $id: $data,
        ...
      }
    }
  }
}
```

Whenever somebody new subscribes or unsubscribes from the channel, a message will
be posted to the channel and delivered to all subscribers:

```javascript
{
  subscribe: {
    $id: $data,
    ...
  },
  unsubscribe: {
    $id: null,
    ...
  }
}
```

The presence id is used instead of the internal Faye client id because it can
more accurately identify an entity, where the Faye client id identifies a connection.
A user can be subscribed concurrently on several browsers, and will not show as
unsubscribed until all connections are closed.

## Running tests:

Using docker-compose:

```docker-compose run node npm test```
