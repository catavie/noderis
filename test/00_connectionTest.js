'use strict';

const
    assert = require('chai').assert,
    redisServer = require('./node_modules/redisServer'),
    unloadModule = require('./node_modules/unloadModule'),
    timeout = require('./node_modules/timeout');

require('./node_modules/filterLogs')(['RedisClient']);


describe('Connection tests', function() {
    this.bail(true);

    it('start server', async function() {
        try {
            await redisServer.startRedis({port: 63790, maxclients: 5});
        } catch (e) {
            console.error(e);
            throw e;
        }
    });

    it('connect with createclient', function(done) {
        let noderis = require('../noderis');
        let cbOK = false;
        let client = noderis.createClient(63790, '127.0.0.1', {}, function(err) {
            assert.isTrue(this.connected);
            assert.isNull(err);
            cbOK = true;
        });
        assert.isObject(noderis.rclient);
        assert.isObject(noderis.rclient_async);
        client.on('connected', function() {
            assert(cbOK, true, 'Callback must be invoked 1st');
            assert.isTrue(this.connected);
            this.destroy();
            done();
        });
    });

    it('connect with globals', function(done) {
        // Start from scratch
        unloadModule('../noderis');

        // Set global variables
        global.REDIS_PORT = 63790;
        global.REDIS_HOST = '127.0.0.1';
        // Load noderis, it should automatically connect and create rclient(s)
        let noderis = require('../noderis');
        assert.isObject(noderis.rclient);
        assert.isObject(noderis.rclient_async);
        // We can still check connection
        noderis.rclient.on('connected', function() {
            assert.isTrue(this.connected);
            // Clean global variables
            delete global.REDIS_PORT;
            delete global.REDIS_HOST;
        });
        // Ensure connect test
        noderis.rclient.ensureConnected(function() {
            this.destroy();
            done();
        });
    });

    it('wrong port should emit connect_error event', function(done) {
        this.timeout(500);
        // Start from scratch
        unloadModule('../noderis');

        let noderis = require('../noderis'),
            cbErr = null;
        let client = noderis.createClient(63791, '127.0.0.1', {}, function(err) {
            assert.isNotNull(err, 'We should have an error object here.');
            cbErr = err;
        });
        client.on('connect_error', function(err) {
            assert.isFalse(this.connected);
            assert.isNotNull(err, 'We should have an error object here.');
            assert.equal(cbErr, err, 'The callback should called 1st and must have the same error object as the event');
            this.disconnect(done);
        });
    });

    it('clientPool 5 clients (5 max) -> should have 5 available clients', function(done) {
        // Start from scratch
        unloadModule('../noderis');

        let CLIENTS = 5,
            noderis = require('../noderis'),
            cbOK = false,
            connectedEvent = false;

        noderis.createClientPool(63790, '127.0.0.1', {}, CLIENTS, function(err) {
            assert.isNull(err);
            assert.isTrue(this.connected);
            cbOK = true;
        });
        noderis.rclient.on('connected', function() {
            assert.isTrue(this.connected);
            assert.isTrue(cbOK);
            connectedEvent = true;
        });

        noderis.rclient.on('client_connected', function() {
            if (--CLIENTS == 0) {
                assert.isTrue(this.connected);
                assert.isTrue(cbOK);
                assert.isTrue(connectedEvent);
                this.disconnect(done);
            }
        });
    });

    it('clientPool 10 clients (5 max) -> should have 5 available clients', function(done) {
        this.timeout(500);
        // Start from scratch
        unloadModule('../noderis');

        let clients = 10,
            noderis = require('../noderis'),
            cbOK = false,
            connectedEvent = false;

        noderis.createClientPool(63790, '127.0.0.1', {}, clients, function(err) {
            assert.isNull(err);
            assert.isTrue(this.connected);
            cbOK = true;
        });
        noderis.rclient.on('connected', function() {
            assert.isTrue(this.connected);
            assert.isTrue(cbOK);
            connectedEvent = true;
        });

        noderis.rclient.on('client_connected', function() {
            if (--clients == 0) {
                assert.isTrue(this.connected);
                assert.isTrue(cbOK);
                assert.isTrue(connectedEvent);
                setTimeout(() => {
                    assert.equal(noderis.rclient.numberOfClients, 5);
                    this.disconnect(done);
                }, 50);
            }
        });
    });

    it('stop server', async function() {
        await redisServer.stopRedis();
    });

    it('client wait for server, queue until connection', async function() {
        this.timeout(3000);
        unloadModule('../noderis');
        let noderis = require('../noderis');
        noderis.createClient(63790, '127.0.0.1', {autoReconnectAfter: 0.5});
        noderis.rclient.set('__test__', '__test__');
        let getPromise = noderis.rclient_async.get('__test__');
        await timeout(1000);
        await redisServer.startRedis({port: 63790, maxclients: 5});
        await noderis.rclient_async.waitForEvent('connected');
        try {
            let resp = await getPromise;
            assert.equal(resp, '__test__');
            await noderis.rclient_async.del('__test__');
            await noderis.rclient_async.disconnect();
            await redisServer.stopRedis();
        } catch (e) {
            throw e;
        }
    });

    it ('client should reconnect', async function () {
        this.timeout(3000);
        unloadModule('../noderis');
        let noderis = require('../noderis');
        await redisServer.startRedis({port: 63790, maxclients: 5});
        noderis.createClient(63790, '127.0.0.1', {autoReconnectAfter: 0.5});
        assert.equal(await noderis.rclient_async.ping(), 'PONG');
        await redisServer.stopRedis();
        // Start redis after timeout
        setTimeout(() => { redisServer.startRedis({port: 63790, maxclients: 5}) }, 1000);
        assert.equal(await noderis.rclient_async.ping(), 'PONG');
        await noderis.rclient_async.disconnect();
        await redisServer.stopRedis();
    });

    it ('pool should reconnect', async function () {
        this.timeout(3000);
        unloadModule('../noderis');
        let noderis = require('../noderis');
        await redisServer.startRedis({port: 63790, maxclients: 15});
        noderis.createClientPool(63790, '127.0.0.1', {autoReconnectAfter: 0.5}, 5);
        await noderis.rclient_async.waitForEvent('connected');
        assert.equal(await noderis.rclient_async.ping(), 'PONG');
        await redisServer.stopRedis();
        // Start redis after timeout
        setTimeout(() => { redisServer.startRedis({port: 63790, maxclients: 5}) }, 1000);
        assert.equal(await noderis.rclient_async.ping(), 'PONG');
        await noderis.rclient_async.disconnect();
        await redisServer.stopRedis();
    });
});

