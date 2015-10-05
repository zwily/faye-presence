var RedisEngine = require('../lib/redis_engine');

var engine = RedisEngine.create([ 'redis:6379' ]);

describe('RedisEngine', function() {
  it('should perform the basic operations', function(done) {
    engine.addClient('channel', 'clientid', 'user1', 'user1-data', function(err, isNew) {
      (err === null).should.be.true;
      isNew.should.be.true;

      engine.getSubscribers('channel', function(err, subscribers) {
        (err === null).should.be.true;

        Object.keys(subscribers).length.should.equal(1);
        subscribers['user1'].should.equal('user1-data');

        engine.getPresenceInfo('channel', 'clientid', function(err, data) {
          (err === null).should.be.true;

          data.should.equal('user1-data');

          engine.unsubscribe('channel', 'clientid', function(err, allGone) {
            (err === null).should.be.true;

            allGone.should.be.true;

            engine.getSubscribers('channel', function(err, subscribers) {
              Object.keys(subscribers).length.should.equal(0);
              done();
            });
          });
        });
      });
    });
  });

  it('should still return a channel user if at least one clientid exists', function(done) {
    engine.addClient('channel', 'clientid1', 'user1', 'user1-data', function(err, isNew) {
      (err === null).should.be.true;
      isNew.should.be.true;

      engine.addClient('channel', 'clientid2', 'user1', 'user1-data', function(err, isNew) {
        isNew.should.be.false;

        engine.getSubscribers('channel', function(err, subscribers) {
          (err === null).should.be.true;

          Object.keys(subscribers).length.should.equal(1);
          subscribers['user1'].should.equal('user1-data');

          engine.unsubscribe('channel', 'clientid1', function(err, allGone) {
            (err === null).should.be.true;

            allGone.should.be.false;

            engine.getSubscribers('channel', function(err, subscribers) {
              Object.keys(subscribers).length.should.equal(1);

              engine.unsubscribe('channel', 'clientid2', function(err, allGone) {
                (err === null).should.be.true;

                allGone.should.be.true;

                engine.getSubscribers('channel', function(err, subscribers) {
                  Object.keys(subscribers).length.should.equal(0);
                  done();
                });
              });
            });
          });
        });
      });
    });
  });
});
