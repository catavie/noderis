"use strict";

const MAX_LINE_BUFF_LENGTH = 65535;

const
    net = require('net'),
    events = require('events'),
    util = require('util');

/** region ** RedisClient */

/**
 * Serialize a list into RESP string
 * For sending redis commands and parameters
 * @param {Array} input The values to serialize
 * @return {string}
 */
function seraializeInputRESP(input) {
    var res = '*' + input.length + "\r\n";
    // Serialize input
    for (let i = 0, l = input.length; i < l; i++) {
        // Convert it to string
        let d = "" + input[i];
        // String
        res += '$' + d.length + "\r\n";
        res += d + "\r\n";
    }
    return res;
}


/**
 * Load and parse RESP answer from Redis recursively
 * @param {RedisClient} redisClient Socket object
 * @param {boolean=false} shouldReturnObject If the command should return object (convert it to a JS object)
 * @param {Callback} cb
 * @return {string|int|Object}
 */
function loadRESP(redisClient, shouldReturnObject, cb) {
    // Wait for a line from socket
    redisClient._readLine((raw) => {
        if (raw === false) cb(new Error('Protocol error!'));

        var fb = raw.substr(0, 1),
            data, length;

        // Process 1st byte of the response (RESP protocol)
        switch (fb) {
            // Simple Strings
            case '+':
                cb(null, raw.substr(1));
                break;

            // Errors
            case '-':
                cb(new Error(raw.substr(1)));
                break;

            // Integers
            case ':':
                cb(null, parseInt(raw.substr(1), 10));
                break;

            // Bulk Strings
            case '$':
                // The 1st is the length of the string
                length = parseInt(raw.substr(1), 10);
                // Empty string
                if (length === 0) redisClient._readLine((line) => {
                    cb(null, line)
                });
                // Null string
                else if (length == -1) cb(null, null);
                // Normal string
                else if (length > 0) {
                    data = '';
                    // Read from socket until we get the needed amount of data
                    let readNextLine = () => {
                        redisClient._readLine((line) => {
                            let ll = line.length;
                            length -= ll;
                            if (length < 0) line = line.substr(0, ll + length);
                            data += line;
                            if (length > 0 && ll > 0) readNextLine();
                            else cb(null, data);
                        });
                    };
                    readNextLine();
                }
                break;

            // Arrays
            case '*':
                // The 1st is the length of the array
                length = parseInt(raw.substr(1), 10);
                // Empty array
                if (length === 0) cb(null, []);
                // Normal array
                else if (length > 0) {
                    // If we need simple array
                    if (!shouldReturnObject) {
                        data = [];
                        let readNextData = () => {
                            loadRESP(redisClient, false, (err, resp) => {
                                if (err) cb(err, null);
                                else data.push(resp);
                                if (--length > 0) readNextData();
                                else cb(null, data);
                            });
                        };
                        readNextData();
                    }
                    // If we need key value pairs
                    else {
                        if (length % 2 != 0) cb(new Error("The value cannot be converted into an object!"), null);
                        else {
                            data = {};
                            let key = '';
                            let readNextData = () => {
                                loadRESP(redisClient, false, (err, resp) => {
                                    if (err) cb(err, null);
                                    else if (length % 2 == 0) key = resp;
                                    else data[key] = resp;
                                    if (--length > 0) readNextData();
                                    else cb(null, data);
                                });
                            };
                            readNextData();
                        }
                    }
                }
                // Null array
                else cb(null, null);
                break;

            // Unknown
            default: return cb(new Error('Protocol error!'));
        }
    });
}


/**
 * Create redis client connection
 * @param {int|string=6379} port Redis port (default is 6379)
 * @param {string=} host Redis host (default is 127.0.0.01)
 * @param {{autoReconnectAfter: int|undefined=,
 *          autoCloseTransaction: boolean|undefined=}=} options RedisClient options
 * @constructor
 * @extends EventEmitter
 */
function RedisClient(port, host, options) {
    this.port = port ? parseInt(port) : 6379;
    this.host = host || '127.0.0.1';

    // Options
    this.options = options || {};
    // If socket is disconnected, it will reconnect after this amount of seconds. Set to false for no auto reconnections.
    this.options.autoReconnectAfter = this.options.autoReconnectAfter !== undefined ? this.options.autoReconnectAfter : 3;
    // Set to false if you don't want automatic transaction close on send
    this.options.autoCloseTransaction = this.options.autoCloseTransaction !== undefined ? this.options.autoCloseTransaction : true;

    /** @type {net.Socket} */
    this._sock = null;

    // It is true if a command has been sent and waiting for answer (every Redis command has an answer)
    this._waitingForAnswer = false;
    // If a redis transaction is opened with MULTI and not closed with EXEC
    this._transactionOpened = false;

    // The line reader callback
    this._lineReader = null;

    // We need to listen for answers while another
    this.setMaxListeners(100);
}

RedisClient.prototype = {
    /**
     * Connect to redis server
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    connect(cb) {
        var sock = new net.Socket(),
            dataBuf = '';
        // Setup communication
        sock.setNoDelay();
        // noinspection JSUnresolvedFunction
        sock.setEncoding('utf8');
        // Connect to Redis
        sock.connect(this.port, this.host, () => {
            // From here we enable reconnect
            this._enableReconnect = true;
            this._connected = true;
            // Process data received
            sock.on('data', (data) => {
                dataBuf += data;
                // Process full lines
                while (true) {
                    let i = dataBuf.indexOf("\r\n");
                    if (i == -1) break;
                    let line = dataBuf.substr(0, i);
                    dataBuf = dataBuf.substr(i + 2);
                    // Notify listeners about new line
                    this._lineReader && this._lineReader(line);
                }
                if (dataBuf.length > MAX_LINE_BUFF_LENGTH) dataBuf = dataBuf()
            });
            // Detect connection end
            sock.on('end', (had_error) => {
                this.destroy();
                // Notify subscribers about connection close
                this.emit('close', had_error);
                // Reconnect
                if (this._enableReconnect) this.reconnectAfter();
            });
            // Handle errors
            sock.on('error', (exception) => {
                this.emit('error', exception);
                if (this._enableReconnect) this.reconnectAfter();
                else this.destroy();
            });
            // Notify caller about successfull connection
            cb && cb(null, true);
        });
        // Handle connection error
        sock.once('error', (exception) => {
            cb && cb(exception, null);
            this.emit('connect_error', exception);
            if (this._enableReconnect) this.reconnectAfter();
        });
        this._sock = sock;
        // Return self to be chainable
        return this;
    },

    /**
     * Destroy connection immediately, it should not be called directly
     */
    destroy() {
        this._connected = false;
        if (this._sock) this._sock.destroy();
        this._sock = null;
    },

    /**
     * Disconnect gracefully from Redis
     * @param {Callback=} cb
     */
    disconnect(cb) {
        if (!this._sock) cb(new Error("Not connected!"));
        else {
            this._enableReconnect = false;
            this._sock.once('close', () => {
                this.destroy();
                cb && cb(null, true);
            });
            this._sock.end();
        }
    },

    /**
     * Destroy active conenction (if any) then reconnect
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    reconnect(cb) {
        if (this._connected) this.destroy();
        return this.connect(cb);
    },

    /**
     * Destroy active conenction (if any) then reconnect after the timeout specified in connection options
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    reconnectAfter(cb) {
        if (this._connected) this.destroy();
        // Reconnect after specified timeout if enabled
        if (this.options.autoReconnectAfter !== false) {
            setTimeout(() => { this.reconnect(cb) }, this.options.autoReconnectAfter);
        } else {
            cb(new Error("Reconnection is not enabled"));
        }
        return this;
    },

    /**
     * If connected, callback is called immediately, if not, wait for connection event
     * @param {Callback} cb
     * @return {RedisClient}
     */
    ensureConnected(cb) {
        // this means not started connecting
        if (!this._enableReconnect) cb && cb(null, false);
        else {
            if (this._connected) {
                cb && cb(null, true);
            } else {
                this.once('connected', () => {
                    cb && cb(null, true);
                });
            }
        }
        return this;
    },

    /**
     * Read line from redis
     * Lines are separated by "\r\n", which is not found in the returned string
     * Only one callback can be waiting for a line!
     * @param {function(string|boolean)} cb Called when a line has received
     */
    _readLine(cb) {
        if (!this._connected || this._lineReader) cb(false);
        else this._lineReader = (line) => { this._lineReader = null; cb(line) };
    },


    /**
     * Send already serialized message to redis
     * Then wait for answer. The answer is automatically unserialized.
     * Normally this function should not be called directly.
     * @param {string} msg The message to send to Redis
     * @param {boolean} shouldReturnObject If true, the result array should be converted to key-value pair
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    callRedisRaw(msg, shouldReturnObject, cb) {
        // If no other commands in progress
        if (!this._waitingForAnswer) {
            this._sock.write(msg);
            this._waitingForAnswer = true;
            loadRESP(this, shouldReturnObject, (err, resp) => {
                this._waitingForAnswer = false;
                this.emit('result', msg, resp);
                cb && cb(err, resp);
            });
        }
        // We need to wait until the other command finished (got result)
        else this.once('result', () => { this.callRedisRaw(msg, shouldReturnObject, cb) });
        return this;
    },

    /**
     * Send commands to redis
     * @param {string} command Command to call
     * @param {Callback=} cb
     * @param {(string|number)...} params Command parameteres
     * @return {RedisClient}
     */
    callRedis(command, cb, ...params) {
        return this.callRedisRaw(seraializeInputRESP([command, ...params]), false, cb);
    },

    /**
     * Send commands to redis getting object back instead of list with keys and values
     * @param {string} command Command to call
     * @param {Callback=} cb
     * @param {(string|number)...} params Command parameteres
     * @return {RedisClient}
     */
    callRedisGetObject(command, cb, ...params) {
        return this.callRedisRaw(seraializeInputRESP([command, ...params]), true, cb);
    },

    /**
     * Create a pipeline object which can concatenate multiple redis commands and send at once
     * @return {RedisPipeline}
     */
    pipeline() { return new RedisPipeline(this) },

    /* Maintenance */

    /**
     * Test the communication
     * @param {Callback=} cb resp should be PONG
     * @return {RedisClient}
     */
    ping(cb) { return this.callRedis('PING', cb) },

    /**
     * Save database dump to disk
     * @param {boolean=true} background If it should save in the background (default)
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    save(background, cb) {
        if (typeof background == 'undefined') background = true;
        if (background) return this.callRedis('BGSAVE', cb);
        return this.callRedis('SAVE', cb);
    },

    /**
     * Save database dump to disk in the background
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    bgsave(cb) { return this.save(true, cb) },

    /**
     * Start a Redis transaction
     * After this, all commands are executed at the same time (atomically) only after EXEC command is called.
     * @param {Callback=} cb resp will be the client object itself if everything ok
     * @return {RedisClient}
     */
    multi(cb) {
        if (this._transactionOpened) cb && cb(new Error('MULTI calls can not be nested!'));
        else {
            this._transactionOpened = true;
            this.callRedis('MULTI', (err, resp) => {
                if (err) cb && cb(err);
                else if (resp != "OK") cb && cb(new Error("MULTI call error: %s", resp));
                else cb && cb(null, this);
            });
        }
        return this;
    },

    /**
     * Execute the Redis transaction opened by MULTI command
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    exec(cb) {
        this._transactionOpened = false;
        return this.callRedis('EXEC', cb);
    },

    /**
     * Start a Redis "transaction" with pipeline (so all commands are sent at the same time)
     * It is a shortcut to .pipeline.multi()
     * It can be end with send. You don't need to close it with .exec.
     * @param {Callback=} cb
     * @return {RedisPipeline}
     */
    pmulti(cb) { return this.pipeline().multi(cb) },

    /* Global */

    /**
     * Delete data by key
     * It can be any type
     * @param {string} key
     * @param {Callback=} cb resp will be 1 if successfull 0 if already deleted
     * @return {RedisClient}
     */
    del(key, cb) { return this.callRedis('DEL', cb, key) },

    /**
     * Check if a key exists or not
     * @param {string} key
     * @param {Callback=} cb resp will be 1 if exists 0 otherwise
     * @return {RedisClient}
     */
    exists(key, cb) { return this.callRedis('EXISTS', cb, key) },

    /**
     * Returns with the type(name) of the given key
     * @param {string }key
     * @param {Callback=} cb resp will be the type of the key
     * @return {RedisClient}
     */
    type(key, cb) { return this.callRedis('TYPE', cb, key) },

    /**
     * Set expiration in seconds to the given key.
     * If the time elapsed, the key will be deleted automatically
     * @param {string} key
     * @param {int} seconds
     * @param {Callback=} cb    resp will be 1 if successfull
     * @return {RedisClient}
     */
    expire(key, seconds, cb) { return this.callRedis('EXPIRE', cb, key, seconds) },

    /**
     * Returns with the time (to live), how long the key is alive
     * @param {string} key
     * @param {Callback=} cb    resp will be
     *                          -2 -- if not exists
     *                          -1 -- if no expiration specified
     *                          >= 0 -- the remaining TTL of the key
     * @return {RedisClient}
     */
    ttl(key, cb) { return this.callRedis('TTL', cb, key) },

    /* Strings */

    /**
     * Set value into key
     * @param {string} key
     * @param {string|number} value Value to be stored under the key
     * @param {{ex: int=, px: int=, nx: boolean=, xx: boolean=}=} otherParams If spetified, the following extra parameters can be set:
     *               ex seconds -- Set the specified expire time, in seconds.
     *               px milliseconds -- Set the specified expire time, in milliseconds.
     *               nx -- Only set the key if it does not already exist.
     *               xx -- Only set the key if it already exists.
     * @param {Callback=} cb resp Should be "OK"
     * @return {RedisClient}
     */
    set(key, value, otherParams, cb) {
        var params = [];
        if (otherParams !== undefined) {
            if (otherParams.ex) { params.push('ex'); params.push(otherParams.ex) }
            if (otherParams.px) { params.push('px'); params.push(otherParams.px) }
            if (otherParams.nx) params.push('nx');
            if (otherParams.xx) params.push('xx');
        }
        return this.callRedis('SET', cb, key, value, ...params);
    },

    /**
     * Shortcut for set with options "ex"
     * @param {string} key
     * @param {string|number} value
     * @param {int} ex Expiration in seconds
     * @param {Callback=} cb resp Should be "OK"
     * @return {*|RedisClient}
     */
    setex(key, value, ex, cb) { return this.set(key, value, {ex: ex}, cb) },

    /**
     * Set multiple key-values at once
     * @param {{}} object Key-value object to set
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    mset(object, cb) {
        var params = [];
        for (var key in object) {
            if (object.hasOwnProperty(key)) {
                params.push(key);
                params.push(object[key]);
            }
        }
        return this.callRedis('MSET', cb, ...params)
    },

    /**
     * Get value from key
     * @param {string} key
     * @param {Callback=} cb resp will be the value of the key
     * @return {RedisClient}
     */
    get(key, cb) { return this.callRedis('GET', cb, key) },

    /**
     * Increment a number
     * @param {string} key
     * @param {int|float=} incrBy If specified, the value will be incremented by this
     * @param {Callback=} cb resp will be the new value
     * @return {RedisClient}
     */
    incr(key, incrBy, cb) {
        return incrBy !== undefined && incrBy !== null
            ? this.callRedis(Number(incrBy) === incrBy && incrBy % 1 !== 0 ? 'INCRBYFLOAT' : 'INCRBY', cb, key, incrBy)
            : this.callRedis('INCR', cb, key);
    },

    /**
     * Decrement a number
     * @param {string} key
     * @param {int|float=} decrBy If specified, the value will be decrement by this
     * @param {Callback=} cb resp will be the new value
     * @return {RedisClient}
     */
    decr(key, decrBy, cb) {
        var isFloatValue = Number(decrBy) === decrBy && decrBy % 1 !== 0;
        return decrBy !== undefined && decrBy !== null
            ? this.callRedis(Number(decrBy) === decrBy && decrBy % 1 !== 0 ? 'INCRBYFLOAT' : 'DECRBY', cb, key, isFloatValue ? -decrBy : decrBy)
            : this.callRedis('DECR', cb, key);
    },

    /* Lists */

    lpush(key, value, cb) { return this.callRedis('LPUSH', cb, key, value) },
    rpush(key, value, cb) { return this.callRedis('RPUSH', cb, key, value) },
    lpop(key, cb) { return this.callRedis('LPOP', cb, key) },
    rpop(key, cb) { return this.callRedis('RPOP', cb, key) },
    lrange(key, startOffset, endOffset, cb) { return this.callRedis('LRANGE', cb, key, startOffset, endOffset) },
    lrem(key, number, value, cb) { return this.callRedis('LREM', cb, key, number, value) },
    ltrim(key, start, end, cb) { return this.callRedis('LTRIM', cb, key, start, end) },

    /* Sets */

    sadd(key, value, cb) { return this.callRedis('SADD', cb, key, value) },
    spop(key, cb) { return this.callRedis('SPOP', cb, key) },
    srem(key, value, cb) { return this.callRedis('SREM', cb, key, value) },
    scard(key, cb) { return this.callRedis('SCARD', cb, key) },

    /* Hashes */

    /**
     * Sets field in the hash stored at key to value.
     * If key does not exist, a new key holding a hash is created. If field already exists in the hash, it is overwritten.
     * @param {string} key
     * @param {string} field
     * @param {string|int} value
     * @param {Callback} cb resp will be 1 if field is new, 0 if field is already exists
     * @return {RedisClient}
     */
    hset(key, field, value, cb) { return this.callRedis('HSET', cb, key, field, value) },

    /**
     * Sets the specified fields to their respective values in the hash stored at key.
     * @param {string} key
     * @param {Object} object The key-value JS object to store as hash
     * @param {Callback} cb
     * @return {RedisClient}
     */
    hmset(key, object, cb) {
        var params = [];
        if (typeof object === 'object') {
            for (let field in object) {
                if (object.hasOwnProperty(field)) {
                    params.push(field);
                    params.push(object[field]);
                }
            }
        }
        // Support for key value list instead of object
        else {
            for (let i = 1, arg; i < arguments.length && typeof (arg = arguments[i]) != 'function'; i++) params.push(arg);
            cb = arguments[arguments.length - 1];
            if (typeof cb != 'function') cb = null;
        }
        return this.callRedis('HMSET', cb, key, ...params);
    },

    /**
     * Returns the value associated with field in the hash stored at key.
     * @param {string} key
     * @param {string} field
     * @param {Callback} cb
     * @return {RedisClient}
     */
    hget(key, field, cb) { return this.callRedis('HGET', cb, key, field)},

    /**
     * Returns all fields and values of the hash stored at key.
     * Returns with JS key-value object
     * @param {string} key
     * @param {Callback} cb
     * @return {RedisClient}
     */
    hgetall(key, cb) { return this.callRedisGetObject('HGETALL', cb, key)},


    /**
     * Increments the number stored at field in the hash stored at key by incrBy
     * @param {string} key
     * @param {string} field
     * @param {number|int=1} incrBy
     * @param {Callback} cb
     * @return {RedisClient}
     */
    hincr(key, field, incrBy, cb) {
        if (incrBy === undefined) incrBy = 1;
        return this.callRedis(Number(incrBy) === incrBy && incrBy % 1 !== 0 ? 'HINCRBYFLOAT' : 'HINCRBY',
            cb, key, field, incrBy);
    },

    /**
     * Removes the specified fields from the hash stored at key.
     * @param {string} key
     * @param {string} field
     * @param {Callback} cb
     * @return {RedisClient}
     */
    hdel(key, field, cb) { return this.callRedis('HDEL', cb, key, field)},

    /* Sorted sets */

    zincrby(key, incrBy, value, cb) { return this.callRedis('ZINCRBY', cb, key, incrBy, value) },
    zrange(key, startOffset, endOffset, cb) { return this.callRedis('ZRANGE', cb, key, startOffset, endOffset) },
    zremrangebyrank(key, startOffset, endOffset, cb) { return this.callRedis('ZREMRANGEBYRANK', cb, key, startOffset, endOffset) },
};

// It is an event emitter
util.inherits(RedisClient, events.EventEmitter);

/** endregion */

/** region ** RedisClientAsyncProxy */

/**
 * Async proxy for redis client
 * All methods call the same RedisClient object's promisified methods
 * @param {RedisClient|RedisClientPool} rclient
 * @param {Function=RedisPipeline} pipelineClass Tha class using for pipeline
 * @constructor
 */
function RedisClientAsyncProxy(rclient, pipelineClass) {
    this.proxified = rclient;
    this.pipelineClass = pipelineClass || RedisPipeline;
}

/**
 * Convert callback based methods to promise based
 * @param {function} func The method to convert
 * @param {int=} ensureArgumentsLength  Ensure the function has this many arguments before the callback
 *                                      If not specified we detect it
 * @return {function} The promise creator function
 */
function proxyfy(func, ensureArgumentsLength) {
    // We need all optional arguments sent as "undefined" before the callback
    if (ensureArgumentsLength === undefined) ensureArgumentsLength = func.length - 1;
    return function(...args) {
        return new Promise((resolve, reject) => {
            // Ensure we have enough arguments before the callback
            while (args.length < ensureArgumentsLength) args.push(undefined);
            // The last argument is the callback
            args.push((err, resp) => {
                if (err !== null) reject(err);
                else resolve(resp);
            });
            func.apply(this.proxified, args);
        });
    }
}


RedisClientAsyncProxy.prototype = {
    /**
     * Send already serialized message to redis
     * Then wait for answer. The answer is automatically unserialized.
     * Normally this function should not be called directly.
     * @param {string} msg
     * @param {boolean} shouldReturnObject If true, the result array should be converted to key-value pair
     * @return {Promise.<string|int|[]|{}>}
     */
    callRedisRaw: proxyfy(RedisClient.prototype.callRedisRaw),

    /**
     * Send commands to Redis
     * @param {string} command The command to execute
     * @param {(string|number)...} params
     * @return {Promise.<string|int|[]|{}>}
     */
    callRedis: function(command, ...params) {
        return new Promise((resolve, reject) => {
            this.proxified.callRedis(command, (err, resp) => {
                if (err !== null) reject(err);
                else resolve(resp);
            }, ...params);
        });
    },

    /**
     * Send commands to redis getting object back instead of list with keys and values
     * @param {string} command The command to execute
     * @param {(string|number)...} params
     * @return {Promise.<string|int|[]|{}>}
     */
    callRedisGetObject: function(command, ...params) {
        return new Promise((resolve, reject) => {
            this.proxified.callRedisGetObject(command, (err, resp) => {
                if (err !== null) reject(err);
                else resolve(resp);
            }, ...params);
        });
    },

    /* Maintenance */

    /**
     * Create a pipeline object which can concatenate multiple redis commands and send at once
     * @return {RedisPipeline}
     */
    pipeline() { return new this.pipelineClass(this.proxified) },

    /**
     * Test the communication
     * @return {Promise.<string>} Should be "PONG"
     */
    ping: proxyfy(RedisClient.prototype.ping),

    /**
     * Save database dump to disk
     * @param {boolean=true} background If it should save in the background (default)
     * @return {Promise.<string>}
     */
    save: proxyfy(RedisClient.prototype.save),

    /**
     * Save database dump to disk in background
     * @return {Promise.<string>}
     */
    bgsave: proxyfy(RedisClient.prototype.bgsave),

    /**
     * Start a Redis transaction
     * After this, all commands will be executed at the same time (atomically) after EXEC command is called.
     * @return {Promise.<RedisClientAsyncProxy>}    If it was successfull, the result will be the client object to be
     *                                              able to send commands to the same transaction
     */
    multi() {
        return new Promise((resolve, reject) => {
            this.proxified.multi((err, resp) => {
                if (err) reject(err);
                else resolve(new RedisClientAsyncProxy(resp));
            });
        });
    },

    /**
     * Execute the Redis transaction opened by MULTI command
     * @return {Promise.<[]>} resp is a list of the results one by one
     */
    exec: proxyfy(RedisClient.prototype.exec),

    /**
     * Start a Redis "transaction" with pipeline (so all commands are sent at the same time)
     * It is a shortcut to .pipeline.multi()
     * It can be end with send. You don't need to close it with .exec if autoCloseTransaction option is true (default)
     * @param {Callback=} cb
     * @return {RedisPipeline}
     */
    pmulti: RedisClient.prototype.pmulti,

    /* Global */

    /**
     * Delete data by key
     * It can be any type
     * @param {string} key
     * @return {Promise.<int>} 1 if succesfull 0 if already deleted
     */
    del: proxyfy(RedisClient.prototype.del),

    /**
     * Check if a key exists or not
     * @param {string} key
     * @return {Promise.<int>} 1 if exists 0 otherwise
     */
    exists: proxyfy(RedisClient.prototype.exists),

    /**
     * Returns with the type(name) of the given key
     * @param {string} key
     * @return {Promise.<string>} the type of the key
     */
    type: proxyfy(RedisClient.prototype.type),

    /**
     * Set expiration in seconds to the given key.
     * If the time elapsed, the key will be deleted automatically
     * @param {string} key
     * @param {int} seconds
     * @return {Promise.<int>} 1 if successfull
     */
    expire(key, seconds) { return this.callRedis('EXPIRE', key, seconds) },

    /**
     * Returns with the time (to live), how long the key is alive
     * @param {string} key
     * @return {Promise.<int>}  -2 -- if not exists
     *                          -1 -- if no expiration specified
     *                          >= 0 -- the remaining TTL of the key
     */
    ttl(key) { return this.callRedis('TTL', key) },

    /* Strings */

    /**
     * Set value into key
     * @param {string} key
     * @param {string|int} value Value to be stored under the key
     * @param {{ex: int, px: int, nx: boolean, xx: boolean}=} otherParams If spetified, the following extra parameters can be set:
     *               EX seconds -- Set the specified expire time, in seconds.
     *               PX milliseconds -- Set the specified expire time, in milliseconds.
     *               NX -- Only set the key if it does not already exist.
     *               XX -- Only set the key if it already exists.
     * @return {Promise.<String>} Should be "OK"
     */
    set: proxyfy(RedisClient.prototype.set),

    /**
     * Set multiple key-values at once
     * @param {{}} object Key-value object to set
     * @return {Promise.<String>} Should be "OK"
     */
    mset: proxyfy(RedisClient.prototype.mset),

    /**
     * Get value from key
     * @param {string} key
     * @return {Promise.<string|int>} The value stored under the key
     */
    get: proxyfy(RedisClient.prototype.get),

    /**
     * Increment a number
     * @param {string} key
     * @param {int|float=} incrBy If specified, the value will be incremented by this
     * @return {Promise.<int|float>} The new value
     */
    incr: proxyfy(RedisClient.prototype.incr),

    /**
     * Decrement a number
     * @param {string} key
     * @param {int|float=} decrBy If specified, the value will be decrement by this
     * @return {Promise.<int|float>} The new value
     */
    decr: proxyfy(RedisClient.prototype.decr),

    /* Lists */

    lpush: proxyfy(RedisClient.prototype.lpush),
    rpush: proxyfy(RedisClient.prototype.rpush),
    lpop: proxyfy(RedisClient.prototype.lpop),
    rpop: proxyfy(RedisClient.prototype.rpop),
    lrange: proxyfy(RedisClient.prototype.lrange),
    lrem: proxyfy(RedisClient.prototype.lrem),
    ltrim: proxyfy(RedisClient.prototype.ltrim),

    /* Sets */

    sadd: proxyfy(RedisClient.prototype.sadd),
    spop: proxyfy(RedisClient.prototype.spop),
    srem: proxyfy(RedisClient.prototype.srem),
    scard: proxyfy(RedisClient.prototype.scard),

    /* Hashes */

    hset: proxyfy(RedisClient.prototype.hset),
    hmset: proxyfy(RedisClient.prototype.hmset),
    hget: proxyfy(RedisClient.prototype.hget),
    hgetall: proxyfy(RedisClient.prototype.hgetall),
    hincr: proxyfy(RedisClient.prototype.hincr),
    hdel: proxyfy(RedisClient.prototype.hdel),

    /* Sorted sets */

    zincrby: proxyfy(RedisClient.prototype.zincrby),
    zrange: proxyfy(RedisClient.prototype.zrange),
    zremrangebyrank: proxyfy(RedisClient.prototype.zremrangebyrank),
};

/** endregion */

/** region ** RedisPipeline */

/**
 * A redis command concatenator
 * @constructor
 * @extends {RedisClient}
 */
function RedisPipeline(rclient) {
    this.rclient = rclient;

    this._pipeline = '';
    this._cbShouldReturnObject = [];
    this._callbacks = [];

    this._empty = true;
    this._multiStart = false;
    this._execLast = false;
    this.__execLast = false;
}

RedisPipeline.prototype = {
    /**
     * Add new command to the pipeline
     * The pipeline object understands all commands the client have. You can call methods the same way, but they won't be
     * sent to Redis immediately, just when you call the .send() method. The callbacks are called after all methods are
     * processed by Redis. You can get each pipelined results one by one with the original callbacks or you can have a
     * result object with all of the data or filtered data with the callback of the send method.
     * @param {string} msg
     * @param {boolean=false} shouldReturnObject
     * @param {Callback=} cb
     * @return {RedisPipeline}
     */
    callRedisRaw(msg, shouldReturnObject, cb) {
        if (!this.rclient || !this.rclient._connected) throw "Redis is not connected!";
        //noinspection PointlessBooleanExpressionJS - it is not pointless!! It converts it to boolean
        shouldReturnObject = !!shouldReturnObject;

        // Save message for later sending
        this._pipeline += msg + '\r\n';
        // Store if the actual method should return object or not
        this._cbShouldReturnObject.push(shouldReturnObject);
        // Store callbacks for later use
        this._callbacks.push(cb || null);

        // If exec called last before send
        if (this.__execLast) {
            this._execLast = true;
            this.__execLast = false;
        } else this._execLast = false;

        // Make it chainable
        return this;
    },

    /**
     * Send the pipeline to Redis server, get the results and parse them.
     * The results will be sent to the appropriate callbacks one by one too.
     * @param {int|null|Callback=} returnIndex  if null or not defined it will return all results of the pipeline as an array
     *                                          if negative, it will return the nth result from the last one
     *                                          if positive or 0, it will return the nth result from the 1st one (1st is 0)
     *                                          If it is a callback type, returnindex is treated as null and it will be used as send_cb
     * @param {Callback=} send_cb
     * @return {Array|int|string}               The result will be an array containing the results one by one of the pipelined commands,
     *                                          or if returnIndex is specified, then only the indexed value will be returned
     */
    send(returnIndex, send_cb) {
        if (!this._pipeline.length) send_cb(null, []);

        // If no other commands in progress (the client is ready)
        else if (!this.rclient._waitingForAnswer) {
            // Close unclosed transaction
            if (this._transactionOpened && this.rclient.options.autoCloseTransaction) this.exec();

            // Send message
            this.rclient._sock.write(this._pipeline);
            this.rclient._waitingForAnswer = true;

            // No longer needed, can be GC-ed
            this._pipeline = null;

            // Declare needed variables
            let send_resp = [],
                l = this._callbacks.length,
                i = 0;

            // If no returnIndex but callback is specified,
            if (typeof(returnIndex) == 'function') {
                send_cb = returnIndex;
                returnIndex = null;
            }

            // Support for negative index
            if (returnIndex < 0 && !(this._multiStart && this._execLast)) returnIndex = l + returnIndex;

            // Read next expected data
            let readNextData = (i) => {
                var shouldReturnObject = this._cbShouldReturnObject[i],
                    cb = this._callbacks[i];
                loadRESP(this.rclient, shouldReturnObject, (err, resp) => {
                    // If it starts with multi (it is a pmulti), then the result array should be the multi's result
                    if (this._multiStart && this._execLast) {
                        if (i == l - 1) {
                            send_resp = resp;
                            if (returnIndex !== undefined && returnIndex !== null) {
                                if (returnIndex < 0) returnIndex = send_resp.length + returnIndex;
                                send_resp = send_resp[returnIndex];
                            }
                        }
                    } else if (returnIndex !== undefined && returnIndex !== null) {
                        if (i == returnIndex) send_resp = resp;
                    } else send_resp.push(resp);
                    cb && cb(err, resp);
                    // Read next data or send callback if no more data
                    if (++i < l) readNextData(i);
                    else {
                        send_cb && send_cb(null, send_resp);
                        this.rclient._waitingForAnswer = false;
                    }
                });
            };
            readNextData(i);
        }
        // We need to wait until the other command(s) finished (got result)
        else this.once('result', () => { this.send(returnIndex, send_cb) });
    },

    /**
     * Start a Redis transaction
     * After this, all command is executed only after EXEC command is called.
     * @param {Callback=} cb
     * @return {RedisPipeline}
     */
    multi(cb) {
        if (this._empty) this._multiStart = true;
        return RedisClient.prototype.multi.call(this, cb);
    },

    /**
     * Execute the Redis transaction opened by MULTI command
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    exec(cb) {
        this.__execLast = true;
        return RedisClient.prototype.exec.call(this, cb);
    },
};

// noinspection JSCheckFunctionSignatures
RedisPipeline.prototype.connect =
RedisPipeline.prototype.disconnect =
RedisPipeline.prototype.reconnect =
RedisPipeline.prototype.reconnectAfter = () => {
    throw "Use the RedisClient's own function instead of the pipeline!"
};

// All other methods inherited from RedisClient
util.inherits(RedisPipeline, RedisClient);

/** endregion */

/** region ** RedisPipelineAsync */

/**
 * Same as RedisPipeLine, just can send the pipeline in promisified way instead of callbacks
 * All intermediate commands are still callback based to be able to get results one by one
 * @param {RedisClient} rclient
 * @extends RedisPipeline
 * @constructor
 */
function RedisPipelineAsync(rclient) {
    this.proxified = this;
    // Super
    RedisPipeline.call(this, rclient);
}

/**
 * Send the pipeline to Redis server, get the results and parse them.
 * The results will be sent to the appropriate callbacks one by one too.
 * @param {int|null=} returnIndex           if null or not defined it will return all results of the pipeline as an array
 *                                          if negative, it will return the nth result from the last one
 *                                          if positive or 0, it will return the nth result from the 1st one (1st is 0)
 * @return {Array|int|string}               The result will be an array containing the results one by one of the pipelined commands,
 *                                          or if returnIndex is specified, then only the indexed value will be returned
 * @function
 */
RedisPipelineAsync.prototype.send = proxyfy(RedisPipeline.prototype.send);

// All others inherited form RedisPipeline
util.inherits(RedisPipelineAsync, RedisPipeline);

/** endregion */

/** region ** RedisClientPool */

/**
 * Create multiple clients for paralell commands.
 * If a command already in progress, we use another client from the pool.
 * Basically it is a proxy for multiple clients.
 * @param {int|string=6379} port Redis port (default is 6379)
 * @param {string=} host Redis host (default is 127.0.0.01)
 * @param {{autoReconnectAfter: int|undefined=,
 *          autoCloseTransaction: boolean|undefined=}=} options RedisClient options
 * @param {int=5} poolSize Size of the pool
 * @constructor
 */
function RedisClientPool(port, host, options, poolSize) {
    this.clients = [];
    this.poolSize = poolSize || 5;
    for (let i = 0; i < poolSize; i++) {
        let rclient = new RedisClient(port, host, options);
        this.clients.push(rclient);
    }

    this._connected = false;
    this.options = options;
}

RedisClientPool.prototype = {
    /**
     * Find a ready client in the pool
     * @param {Callback} cb
     */
    getAvailableClient(cb) {
        var found = false;
        // Try to find an available client
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            // If we can use this client for communication
            if (client._connected && !client._waitingForAnswer && !client._transactionOpened) {
                // Use this client
                found = true;
                cb(null, client);
                break;
            }
        }
        // If not found an available client we subscribe for result events to get the 1st ready client
        if (!found) {
            let result_cb = () => {
                // Remove other listeners
                for (let i = 0; i < this.poolSize; i++) {
                    let client = this.clients[i];
                    client.removeListener('result', result_cb);
                }
                this.getAvailableClient(cb);
            };
            for (let i = 0; i < this.poolSize; i++) {
                let client = this.clients[i];
                client.once('result', result_cb);
            }
        }
        return this;
    },

    connect(cb) {
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            client.connect((err, resp) => {
                this._connected = true;
                // The 1st connection response will be used as pool connect response,
                //  we can immediately send commands if we have one client
                cb && cb(err, resp);
                cb = null;
            });
        }
    },

    callRedisRaw(msg, shouldReturnObject, cb) {
        this.getAvailableClient((err, client) => {
            if (err) cb && cb(err);
            else client.callRedisRaw(msg, shouldReturnObject, cb);
        });
        return this;
    },

    disconnect(cb) {
        this._connected = false;
        var toDisconnect = this.poolSize;
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            client.disconnect((err, resp) => {
                if (--toDisconnect == 0) cb && cb(err, resp);
            });
        }
    },

    pipeline() { return new RedisClientPoolPipeline(this) },

    /**
     * Start a transaction on an available client. This will block the client until EXEC is called
     * Use .pmulti() instead of this if possible, which creates a pipeline object then send everything at once.
     * @param {Callback} cb
     * @return {RedisClient}
     */
    multi(cb) {
        var found = false;
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            // If we can use this client for communication
            if (client._connected && !client._waitingForAnswer && !client._transactionOpened) {
                // Use this client
                found = true;
                // From now the chain is the client. Because we need to ensure all transaction calls are on the same client
                return client.multi(cb);
            }
        }
        // If not found an available client we subscribe for result events to get the 1st ready client
        if (!found) new Error('No available client found. MULTI calls can only be started on an available client! Use pipeline with MULTI if possible.');
    }
};

util.inherits(RedisClientPool, RedisClient);

/** endregion */

/** region ** RedisClientPoolPipeline */

/**
 * @param {RedisClientPool} clientPool
 * @extends RedisPipeline
 * @constructor
 */
function RedisClientPoolPipeline(clientPool) {
    RedisPipeline.call(this, clientPool);
}

RedisClientPoolPipeline.prototype = {
    /**
     * Send the pipeline to Redis server, get the results and parse them.
     * The results will be sent to the appropriate callbacks one by one too.
     * @param {int|null|Callback=} returnIndex  if null or not defined it will return all results of the pipeline as an array
     *                                          if negative, it will return the nth result from the last one
     *                                          if positive or 0, it will return the nth result from the 1st one (1st is 0)
     *                                          If it is a callback type, returnindex is treated as null and it will be used as send_cb
     * @param {Callback=} send_cb   resp will be an array containing the results one by one of the pipelined commands,
     *                              or if returnIndex is specified, then only the indexed value will be returned
     */
    send(returnIndex, send_cb) {
        this.rclient.getAvailableClient((err, client) => {
            if (err) send_cb && send_cb(err);
            else {
                this.rclient = client;
                RedisPipeline.prototype.send.call(this, returnIndex, send_cb);
            }
        });
    },
};

util.inherits(RedisClientPoolPipeline, RedisPipeline);

/** endregion */

/** region ** RedisClientPoolPipelineAsync */

/**
 * This is a the async pipeline for the client pools
 * @param {RedisClientPoolPipelineAsync} rclient
 * @constructor
 */
function RedisClientPoolPipelineAsync (rclient) { RedisPipelineAsync.call(this, rclient); }
RedisClientPoolPipelineAsync.prototype.send = proxyfy(RedisClientPoolPipeline.prototype.send);
util.inherits(RedisClientPoolPipelineAsync, RedisPipelineAsync);

/** endregion */


/* ****************************************************************************************************************** */

/** @type RedisClient|null **/
exports.rclient = null;

/** @type RedisClientAsyncProxy|null */
exports.async_rclient = null;


/**
 * Create redis connection objects
 * exports.rclient will be the callback based client
 * exports.rclient_async will be the promise based client
 * @param {int|string} port
 * @param {string} host
 * @param {{}=} options
 * @param {Callback=} cb Called when connection established
 * @return {RedisClient|null}
 */
function createClient(port, host, options, cb) {
    exports.rclient = new RedisClient(port, host, options);
    exports.rclient_async = new RedisClientAsyncProxy(exports.rclient);
    exports.rclient.connect(cb);
    return exports.rclient;
}


/**
 * Create redis connection pool
 * It always tries to use the 1st free client. If there is no free client, it waits for the 1st to be ready.
 * exports.rclient will be the callback based client pool
 * exports.rclient_async will be the promise based client pool
 * @param {int|string} port
 * @param {string} host
 * @param {{}=} options
 * @param {int=5} poolSize Size of client pool
 * @param {Callback=} cb Called when connection established
 * @return {RedisClient|null}
 */
function createClientPool(port, host, options, poolSize, cb) {
    exports.rclient = new RedisClientPool(port, host, options, poolSize);
    exports.rclient_async = new RedisClientAsyncProxy(exports.rclient, RedisClientPoolPipelineAsync);
    exports.rclient.connect(cb);
    return exports.rclient;
}


/* Auto connection */

// Connect automatically if params specified globally
// noinspection JSUnresolvedVariable
if (global.REDIS_HOST && global.REDIS_PORT) {
    // noinspection JSUnresolvedVariable
    let options = REDIS_OPTIONS || {};
    // If we have global pool size config, we create a pool
    // noinspection JSUnresolvedVariable
    if (global.REDIS_POOL_SIZE) {
        // noinspection JSUnresolvedVariable
        createClientPool(REDIS_PORT, REDIS_HOST, options, REDIS_POOL_SIZE, function() {
            // noinspection JSUnresolvedVariable
            console.log('Redis client pool connected to %s:%i, pool size: %i', REDIS_HOST, REDIS_PORT, REDIS_POOL_SIZE);
        });
    }
    // If not we just create a client
    else {
        // noinspection JSUnresolvedVariable
        createClient(REDIS_PORT, REDIS_HOST, options, function() {
            // noinspection JSUnresolvedVariable
            console.log('Redis client connected to %s:%i', REDIS_HOST, REDIS_PORT);
        });
    }
}

/* Exports */

exports.createClient = createClient;

exports.RedisClient = RedisClient;
exports.RedisClientAsyncProxy = RedisClientAsyncProxy;

exports.createClientPool = createClientPool;
exports.RedisClientPool = RedisClientPool;


/**
 * Promisify compatible callback definition
 * @callback Callback
 * @param {object|null} err Error object
 * @param {string|int|[]|{}|boolean|RedisClient=} resp Result object
 */
