'use strict';

const
    assert = require('chai').assert,
    redisServer = require('./node_modules/redisServer'),
    noderis = require('../noderis');

/** @type RedisClient */
let rclient;
/** @type RedisClientAsyncProxy */
let arclient;

describe('Command tests', function() {
    this.bail(true);

    describe("Connect", function() {
        it('start server', async function() {
            await redisServer.startRedis({port: 63790, maxclients: 5});
        });

        it('connect', function(done) {
            noderis.createClient(63790, '127.0.0.1', {}, function(err) {
                assert.isTrue(this.connected);
                assert.isNull(err);
                rclient = noderis.rclient;
                arclient = noderis.rclient_async;
                done();
            });
        });
    });

    describe('Strings', function() {
        it('set', function(done) {
            rclient.set('__test__', 1, function(err, resp) {
                assert.isNull(err);
                assert.equal(resp, 'OK');
                done();
            });
        });
        it('set async', async function() {
            assert.equal(await arclient.set('__test__', 1), 'OK');
        });

        it('get', function(done) {
            rclient.get('__test__', function(err, resp) {
                assert.isNull(err);
                assert.equal(resp, '1');
                done();
            });
        });
        it('get async', async function () {
            assert.equal(await arclient.get('__test__'), '1');
        });

        it('del', function(done) {
            rclient.del('__test__', function(err, resp) {
                assert.isNull(err);
                assert.equal(resp, 1);
                assert.typeOf(resp, 'number');
                done();
            });
        });
        it('del async', async function() {
            assert.strictEqual(await arclient.del('__test__'), 0);
        });
    });

    describe('Disconnect', function() {
        it('disconnect', function(done) {
            rclient.disconnect(done);
        });

        it('stop server', async function() {
            await redisServer.stopRedis();
        });
    });
});