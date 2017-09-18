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
 * @param {boolean} shouldReturnObject If the command should return object (convert it to a JS object)
 * @param {Callback} cb
 * @return {string|int|Object}
 */
function loadRESP(redisClient, shouldReturnObject, cb) {
    // Wait for a line from socket
    redisClient._readLine((raw) => {
        if (raw === false) return cb('Protocol error!');

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
                cb(raw.substr(1));
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
                if (length === 0) redisClient._readLine((line) => { cb(null, line) });
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
                        }, true); // Bulk strings can have multiple lines, so we need to preserve line separators
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
                        if (length % 2 != 0) cb("The value cannot be converted into an object!");
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
            default: return cb('Protocol error!');
        }
    });
}


/**
 * Create redis client connection
 * @param {int|string=6379} port Redis port (default is 6379)
 * @param {string=} host Redis host (default is 127.0.0.01)
 * @param {{connectionTimeout: int|undefined=,
 *          autoReconnectAfter: number|undefined=,
 *          autoCloseTransaction: boolean|undefined=}=} options RedisClient options
 *                  connectionTimeout -- Timeout for a successfull conenction is seconds (default is 10sec)
 *                  autoReconnectAfter -- If disconnected, after how many seconds we try to reconnect, if false, no reconnect
 *                  autoCloseTransaction -- call EXEC automatically in a pipeline (pmulti)
 * @constructor
 * @extends EventEmitter
 */
function RedisClient(port, host, options) {
    this.port = port ? parseInt(port) : 6379;
    this.host = host || '127.0.0.1';

    // Options
    this.options = options || {};

    this.options.connectionTimeout = this.options.connectionTimeout || 15;
    // If socket is disconnected, it will reconnect after this amount of seconds. Set to false for no auto reconnections.
    this.options.autoReconnectAfter = this.options.autoReconnectAfter !== undefined ? this.options.autoReconnectAfter : 3;
    // Set to false if you don't want automatic transaction close on send
    this.options.autoCloseTransaction = this.options.autoCloseTransaction !== undefined ? this.options.autoCloseTransaction : true;

    /** @type {net.Socket} */
    this._sock = null;

    this._connected = false;
    this._enableReconnect = true;

    // It is true if a command has been sent and waiting for answer (every Redis command has an answer)
    this._waitingForAnswer = false;
    // If a redis transaction is opened with MULTI and not closed with EXEC
    this._transactionOpened = false;

    // The line reader callback
    this._lineReader = null;

    // We need to listen for answers while another command is pending
    this.setMaxListeners(100);

    this._poolIndex = 0;
}

// noinspection JSUnusedGlobalSymbols
RedisClient.prototype = {
    /**
     * @return {number} The index of the client in the pool (if it is in pool, otherwise it is always 0)
     */
    get poolIndex() {return this._poolIndex },

    /**
     * Connect to redis server
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    connect(cb) {
        var sock = new net.Socket(),
            lineBuff = '', cto = null;
        // Setup communication
        sock.setNoDelay();
        // noinspection JSUnresolvedFunction
        sock.setEncoding('utf8');
        // Handle connection error
        var connErrorFunc = (exception) => {
            clearTimeout(cto);
            cb && cb.call(this, exception, null);
            this.emit('connect_error', exception);
            if (this._enableReconnect) this.reconnectAfter();
        };
        sock.once('error', connErrorFunc);
        // Connect to Redis
        sock.connect(this.port, this.host, () => {
            clearTimeout(cto);
            // From here we enable reconnect
            this._connected = true;
            // Remove connection error handler
            this.removeListener('error', connErrorFunc);
            // Handle errors
            sock.on('error', (exception) => {
                this.emit('error', exception);
                if (this._enableReconnect) this.reconnectAfter();
                else this.destroy();
            });
            // Notify caller about successfull connection
            cb && cb.call(this, null, true);
            // Emit connection event
            this.emit('connected');
            // Process data received
            sock.on('data', (data) => {
                lineBuff += data;
                // Process full lines
                while (true) {
                    let i = lineBuff.indexOf("\r\n");
                    if (i == -1) break;
                    i += 2;
                    let line = lineBuff.substr(0, i);
                    lineBuff = lineBuff.substr(i);
                    // If we get the max number of clients error, we need to close this connection
                    if (line == '-ERR max number of clients reached\r\n') {
                        this.disconnect()
                    } else {
                        // Notify listeners about new line
                        this._lineReader && this._lineReader(line);
                    }
                }
                if (lineBuff.length > MAX_LINE_BUFF_LENGTH) lineBuff = lineBuff.substr(-MAX_LINE_BUFF_LENGTH);
            });
            // Detect connection end
            sock.on('end', (had_error) => {
                // Notify subscribers about connection close
                this.emit('disconnected', had_error);
                // Reconnect
                if (this._enableReconnect) this.reconnectAfter();
                else this.destroy();
            });
        });
        // Connection timeout
        cto = setTimeout(() => {
            let exception = new Error('Connection timeout!');
            exception.name = 'RedisClientError';
            cb && cb.call(this, exception, null);
            // Reconnect
            if (this._enableReconnect) this.reconnectAfter();
            else this.destroy();
        }, this.options.connectionTimeout * 1000);
        this._sock = sock;
        // Return self to be chainable
        return this;
    },

    /**
     * True if the client is connected
     * @return {boolean}
     */
    get connected() {
        return this._connected;
    },

    /**
     * Destroy connection immediately, it should not be called directly
     */
    destroy() {
        this._connected = false;
        if (!this._enableReconnect) this.removeAllListeners();
        if (this._sock) {
            this._sock.removeAllListeners();
            this._sock.destroy();
        }
        this._sock = null;
    },

    /**
     * Disconnect gracefully from Redis
     * @param {Callback=} cb
     */
    disconnect(cb) {
        if (!this._sock) {
            cb && cb.call(this, new Error("Not connected!", 'RedisClientDisconnectError'));
        }
        else {
            this._enableReconnect = false;
            let onClose = () => {
                this.destroy();
                cb && cb.call(this, null, true);
            };
            this._sock.on('close', onClose);
            this._sock.on('end', onClose);
            this._sock.end();
        }
    },

    /**
     * Shortcut to disconnect
     * @see disconnect
     * @param {Callback=} cb
     */
    close(cb) { this.disconnect(cb) },

    /**
     * Destroy active conenction (if any) then reconnect
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    reconnect(cb) {
        if (this._sock) this.destroy();
        return this.connect(cb);
    },

    /**
     * Destroy active conenction (if any) then reconnect after the timeout specified in connection options
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    reconnectAfter(cb) {
        if (this._sock) this.destroy();
        // Reconnect after specified timeout if enabled
        if (this.options.autoReconnectAfter !== false) {
            setTimeout(() => { this.reconnect(cb) }, this.options.autoReconnectAfter * 1000);
        } else cb && cb.call(this, new Error("Reconnection is not enabled"));
        return this;
    },

    /**
     * If connected, callback is called immediately, if not, wait for connection event
     * @param {Callback} cb
     * @return {RedisClient}
     */
    ensureConnected(cb) {
        // this means not started connecting or destroyed
        if (!this._sock) cb && cb.call(this, null, false);
        else {
            if (this._connected) {
                cb && cb(null, true);
            } else {
                this.once('connected', () => {
                    cb && cb.call(this, null, true);
                });
            }
        }
        return this;
    },

    /**
     * Read line from redis
     * Lines are separated by "\r\n", which is included if needLineSeparator is true
     * Only one callback can be waiting for a line!
     * @param {function(string|boolean)} cb Called when a line has received
     * @param {boolean=false} needLineSeparator If it is true, new line separator will be included
     */
    _readLine(cb, needLineSeparator) {
        if (!this._connected || this._lineReader) cb.call(this, false);
        else this._lineReader = (line) => {
            // Remove line separator if not needed
            if (!needLineSeparator) line = line.substr(0, line.length - 2);
            this._lineReader = null;
            cb.call(this, line)
        };
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
            if (this._connected) {
                this._waitingForAnswer = true;
                this._sock.write(msg);
                // Create Error object here to get better stack trace
                var errObj = new Error();
                errObj.name = 'RedisClientError';
                loadRESP(this, shouldReturnObject, (err, resp) => {
                    // Convert error string to error object
                    if (err && !(err instanceof Error)) {
                        // noinspection JSValidateTypes
                        errObj.message = err;
                        err = errObj;
                    }
                    this._waitingForAnswer = false;
                    this.emit('result', msg, resp);
                    cb && cb.call(this, err, resp);
                    if (err) this.emit('redis_error', err);
                });
            }
            // We need to wait for connection until we can send
            else this.once('connected', () => {
                this.callRedisRaw(msg, shouldReturnObject, cb)
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
        if (this._transactionOpened) cb && cb.call(this, new Error('MULTI calls can not be nested!'));
        else {
            this._transactionOpened = true;
            this.callRedis('MULTI', (err, resp) => {
                if (err) cb && cb.call(this, err);
                else if (resp != "OK") cb && cb.call(this, new Error("MULTI call error: %s", resp));
                else cb && cb.call(this, null, this);
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
     * @param {{ex: int=, px: int=, nx: boolean=, xx: boolean=}|function=} otherParams
     *              If spetified, the following extra parameters can be set:
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
            if (typeof otherParams === 'function') {
                cb = otherParams;
            } else {
                if (otherParams.ex) { params.push('ex'); params.push(otherParams.ex) }
                if (otherParams.px) { params.push('px'); params.push(otherParams.px) }
                if (otherParams.nx) params.push('nx');
                if (otherParams.xx) params.push('xx');
            }
        }
        return this.callRedis('SET', cb, key, value, ...params);
    },

    /**
     * Shortcut for set with options "ex"
     * @param {string} key
     * @param {string|number} value
     * @param {int} ex Expiration in seconds
     * @param {Callback=} cb resp Should be "OK"
     * @return {RedisClient}
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
     * @param {int|number=} incrBy If specified, the value will be incremented by this
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
     * @param {int|number=} decrBy If specified, the value will be decrement by this
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

    /**
     * Insert all the specified values at the head of the list stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} value Value(s) to push
     * @param {Callback=} cb resp will be the new length of list
     * @return {RedisClient}
     */
    lpush(key, value, cb) {
        if (!Array.isArray(value)) value = [value];
        return this.callRedis('LPUSH', cb, key, ...value)
    },

    /**
     * Insert all the specified values at the tail of the list stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} value Value(s) to push
     * @param {Callback=} cb resp will be the new length of list
     * @return {RedisClient}
     */
    rpush(key, value, cb) {
        if (!Array.isArray(value)) value = [value];
        return this.callRedis('RPUSH', cb, key, ...value)
    },

    /**
     * Removes and returns the first element of the list stored at key.
     * @param {string} key
     * @param {Callback=} cb resp will be the the value of the first element, or nil when key does not exist.
     * @return {RedisClient}
     */
    lpop(key, cb) { return this.callRedis('LPOP', cb, key) },

    /**
     * Removes and returns the last element of the list stored at key.
     * @param {string} key
     * @param {Callback=} cb resp will be the value of the last element, or nil when key does not exist.
     * @return {RedisClient}
     */
    rpop(key, cb) { return this.callRedis('RPOP', cb, key) },

    /**
     * Returns the specified elements of the list stored at key.
     * @param {string} key
     * @param {int} startOffset
     * @param {int} endOffset
     * @param {Callback=} cb resp will be the list of elements in the specified range
     * @return {RedisClient}
     */
    lrange(key, startOffset, endOffset, cb) { return this.callRedis('LRANGE', cb, key, startOffset, endOffset) },

    /**
     * Removes the first count occurrences of elements equal to value from the list stored at key.
     * @param {string} key
     * @param {int} count   count > 0: Remove elements equal to value moving from head to tail.
                            count < 0: Remove elements equal to value moving from tail to head.
                            count = 0: Remove all elements equal to value.
     * @param {string|int} value Value to remove
     * @param {Callback=} cb resp will be the number of removed elements
     * @return {RedisClient}
     */
    lrem(key, count, value, cb) { return this.callRedis('LREM', cb, key, count, value) },

    /**
     * Trim an existing list so that it will contain only the specified range of elements.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @param {Callback=} cb resp should be "OK"
     * @return {RedisClient}
     */
    ltrim(key, start, stop, cb) { return this.callRedis('LTRIM', cb, key, start, stop) },

    /**
     * Returns the length of the list stored at key.
     * @param {string} key
     * @param {Callback=} cb resp will be the the length of the list
     * @return {RedisClient}
     */
    llen(key, cb) { return this.callRedis('LLEN', cb, key) },

    /* Sets */

    /**
     * Add the specified value to the set stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} member Member(s) to add
     * @param {Callback=} cb resp will be the number of elements that were added to the set (1 or 0)
     * @return {RedisClient}
     */
    sadd(key, member, cb) {
        if (!Array.isArray(member)) member = [member];
        return this.callRedis('SADD', cb, key, ...member);
    },

    /**
     * Removes and returns one or more random elements from the set value store at key.
     * @param {string} key
     * @param {int|Callback=} count The number of elements to return
     *                              If not needed, it can be the callback instead
     * @param {Callback=} cb resp will be the number of elements that were added to the set
     * @return {RedisClient}
     */
    spop(key, count, cb) {
        var params = [];
        // If no count specified then callback can be that position
        if (typeof count == 'function') {
            cb = count;
            count = null;
        }
        if (count) params.push(count);
        return this.callRedis('SPOP', cb, key, ...params)
    },

    /**
     * Remove the specified members from the set stored at key
     * @param {string} key
     * @param {string|int|(string|int)[]} member Member(s) to remove
     * @param {Callback=} cb
     * @return {RedisClient}
     */
    srem(key, member, cb) {
        if (!Array.isArray(member)) member = [member];
        return this.callRedis('SREM', cb, key, member)
    },

    /**
     * Returns the set cardinality (number of elements) of the set stored at key.
     * @param {string} key
     * @param {Callback=} cb resp will be the number of elements
     * @return {RedisClient}
     */
    scard(key, cb) { return this.callRedis('SCARD', cb, key) },

    /* Hashes */

    /**
     * Sets field in the hash stored at key to value.
     * If key does not exist, a new key holding a hash is created. If field already exists in the hash, it is overwritten.
     * @param {string} key
     * @param {string} field
     * @param {string|int} value
     * @param {Callback=} cb resp will be 1 if field is new, 0 if field is already exists
     * @return {RedisClient}
     */
    hset(key, field, value, cb) { return this.callRedis('HSET', cb, key, field, value) },

    /**
     * Sets the specified fields to their respective values in the hash stored at key.
     * @param {string} key
     * @param {{}} object The key-value JS object to store as hash
     * @param {Callback=} cb resp should be "OK"
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
     * @param {Callback=} cb resp will be the value
     * @return {RedisClient}
     */
    hget(key, field, cb) { return this.callRedis('HGET', cb, key, field)},

    /**
     * Returns all fields and values of the hash stored at key.
     * Returns with JS key-value object
     * @param {string} key
     * @param {Callback=} cb resp will be the list of fields and their values stored in the hash, or an empty list when key does not exist
     * @return {RedisClient}
     */
    hgetall(key, cb) { return this.callRedisGetObject('HGETALL', cb, key)},


    /**
     * Increments the number stored at field in the hash stored at key by incrBy
     * @param {string} key
     * @param {string} field
     * @param {number|int=1} incrBy
     * @param {Callback=} cb resp will be the value at field after the increment operation
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
     * @param {Callback=} cb resp will be the number of fields that were removed from the hash
     * @return {RedisClient}
     */
    hdel(key, field, cb) { return this.callRedis('HDEL', cb, key, field)},

    /**
     * Returns the number of fields contained in the hash stored at key.
     * @param {string} key
     * @param {Callback=} cb resp will be the number of fields in the hash, or 0 when key does not exist
     * @return {RedisClient}
     */
    hlen(key, cb) { return this.callRedis('HLEN', cb, key) },

    /* Sorted sets */

    /**
     * Increments the score of member in the sorted set stored at key by increment.
     * @param {string} key
     * @param {int} incrBy
     * @param {int|string} member
     * @param {Callback=} cb resp will be the new score of member
     * @return {RedisClient}
     */
    zincrby(key, incrBy, member, cb) { return this.callRedis('ZINCRBY', cb, key, incrBy, member) },

    /**
     * Returns the specified range of elements in the sorted set stored at key.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @param {Callback=} cb resp will be the list of elements in the specified range
     * @return {RedisClient}
     * TODO: withscores support
     */
    zrange(key, start, stop, cb) { return this.callRedis('ZRANGE', cb, key, start, stop) },

    /**
     * Removes all elements in the sorted set stored at key with rank between start and stop.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @param {Callback=} cb resp will be the number of elements removed.
     * @return {RedisClient}
     */
    zremrangebyrank(key, start, stop, cb) { return this.callRedis('ZREMRANGEBYRANK', cb, key, start, stop) },
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
    this.pipelineClass = pipelineClass || RedisPipelineAsync;
}

/**
 * Convert callback based methods to promise based
 * @param {function|string} func The method to convert, or the name of the method of the proxified object
 * @param {int=} ensureArgumentsLength  Ensure the function has this many arguments before the callback
 *                                      If not specified we detect it
 * @return {function} The promise creator function
 */
function proxyfy(func, ensureArgumentsLength) {
    // We need all optional arguments sent as "undefined" before the callback
    if (ensureArgumentsLength === undefined && typeof func != 'string') ensureArgumentsLength = func.length - 1;
    return function(...args) {
        return new Promise((resolve, reject) => {
            if (typeof func == 'string') {
                // We need to find function runtime, but this runs only once
                func = this.proxified[func];
                if (ensureArgumentsLength === undefined) ensureArgumentsLength = func.length - 1;
            }
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
     * Disconnect gracefully from Redis
     * @return {Promise}
     */
    disconnect: proxyfy('disconnect'),

    /**
     * Shortcut to disconnect
     * @see disconnect
     */
    close: proxyfy(RedisClient.prototype.close),

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

    // Event handlers
    on(type, listener) { this.proxified.on(type, listener) },
    once(type, listener) { this.proxified.once(type, listener) },
    removeListener(type, listener) { this.proxified.removeListener(type, listener) },
    removeAllListeners(type) { this.proxified.removeAllListeners(type) },

    /**
     * Wait for an event and it's result
     * @param {string} type The event type
     * @return {Promise} Returns with the result of the event listener
     */
    waitForEvent(type) {
        return new Promise((resolve) => {
            this.proxified.once(type, (...params) => {
                resolve(params);
            });
        });
    },

    /* Maintenance */

    /**
     * Create a pipeline object which can concatenate multiple redis commands and send at once
     * @return {RedisPipelineAsync}
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
     * @return {RedisPipelineAsync}
     */
    pmulti: function() { return this.pipeline().multi() },

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
     * @return {Promise.<string>} Should be "OK"
     */
    set: proxyfy(RedisClient.prototype.set),

    /**
     * Shortcut for set with options "ex"
     * @param {string} key
     * @param {string|number} value
     * @param {int} ex Expiration in seconds
     * @return {Promise.<string>} Should be "OK"
     */
    setex: proxyfy(RedisClient.prototype.setex),

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
     * @param {int|number=} incrBy If specified, the value will be incremented by this
     * @return {Promise.<int|number>} The new value
     */
    incr: proxyfy(RedisClient.prototype.incr),

    /**
     * Decrement a number
     * @param {string} key
     * @param {int|number=} decrBy If specified, the value will be decrement by this
     * @return {Promise.<int|number>} The new value
     */
    decr: proxyfy(RedisClient.prototype.decr),

    /* Lists */

    /**
     * Insert all the specified values at the head of the list stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} value Value(s) to push
     * @return {Promise.<int>} the new length of list
     */
    lpush: proxyfy(RedisClient.prototype.lpush),

    /**
     * Insert all the specified values at the tail of the list stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} value Value(s) to push
     * @return {Promise.<int>} the new length of list
     */
    rpush: proxyfy(RedisClient.prototype.rpush),

    /**
     * Removes and returns the first element of the list stored at key.
     * @param {string} key
     * @return {Promise.<string|int|null>} the the value of the first element, or nil when key does not exist.
     */
    lpop: proxyfy(RedisClient.prototype.lpop),

    /**
     * Removes and returns the last element of the list stored at key.
     * @param {string} key
     * @return {Promise.<string|int|null>} the value of the last element, or nil when key does not exist.
     */
    rpop: proxyfy(RedisClient.prototype.rpop),

    /**
     * Returns the specified elements of the list stored at key.
     * @param {string} key
     * @param {int} startOffset
     * @param {int} endOffset
     * @return {Promise.<(string|int)[]>} the list of elements in the specified range
     */
    lrange: proxyfy(RedisClient.prototype.lrange),

    /**
     * Removes the first count occurrences of elements equal to value from the list stored at key.
     * @param {string} key
     * @param {int} count   count > 0: Remove elements equal to value moving from head to tail.
                            count < 0: Remove elements equal to value moving from tail to head.
                            count = 0: Remove all elements equal to value.
     * @param {string|int} value Value to remove
     * @return {Promise.<int>} the number of removed elements
     */
    lrem: proxyfy(RedisClient.prototype.lrem),

    /**
     * Trim an existing list so that it will contain only the specified range of elements.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @return {Promise.<string>} should be "OK"
     */
    ltrim: proxyfy(RedisClient.prototype.ltrim),

    /**
     * Returns the length of the list stored at key.
     * @param {string} key
     * @return {Promise.<int>} the length of the list
     */
    llen: proxyfy(RedisClient.prototype.llen),

    /* Sets */

    /**
     * Add the specified value to the set stored at key.
     * @param {string} key
     * @param {string|int|(string|int)[]} member Member(s) to add
     * @return {Promise.<int>} the number of elements that were added to the set
     */
    sadd: proxyfy(RedisClient.prototype.sadd),

    /**
     * Removes and returns one or more random elements from the set value store at key.
     * @param {string} key
     * @param {int=} count The number of elements to return
     * @return {Promise.<int>} the number of elements that were added to the set
     */
    spop: proxyfy(RedisClient.prototype.spop),

    /**
     * Remove the specified members from the set stored at key
     * @param {string} key
     * @param {string|int|(string|int)[]} member Member(s) to remove
     * @return {Promise.<int>} the number of elements removed from the set
     */
    srem: proxyfy(RedisClient.prototype.srem),

    /**
     * Returns the set cardinality (number of elements) of the set stored at key.
     * @param {string} key
     * @return {Promise.<int>} the number of elements
     */
    scard: proxyfy(RedisClient.prototype.scard),

    /* Hashes */

    /**
     * Sets field in the hash stored at key to value.
     * If key does not exist, a new key holding a hash is created. If field already exists in the hash, it is overwritten.
     * @param {string} key
     * @param {string} field
     * @param {string|int} value
     * @return {Promise.<int>} 1 if field is new, 0 if field is already exists
     */
    hset: proxyfy(RedisClient.prototype.hset),

    /**
     * Sets the specified fields to their respective values in the hash stored at key.
     * @param {string} key
     * @param {{}} object The key-value JS object to store as hash
     * @return {Promise.<string>} should be "OK"
     */
    hmset: proxyfy(RedisClient.prototype.hmset),

    /**
     * Returns the value associated with field in the hash stored at key.
     * @param {string} key
     * @param {string} field
     * @return {Promise.<string|int>} the value
     */
    hget: proxyfy(RedisClient.prototype.hget),

    /**
     * Returns all fields and values of the hash stored at key.
     * Returns with JS key-value object
     * @param {string} key
     * @return {Promise.<(string|int)[]>} the list of fields and their values stored in the hash, or an empty list when key does not exist
     */
    hgetall: proxyfy(RedisClient.prototype.hgetall),

    /**
     * Increments the number stored at field in the hash stored at key by incrBy
     * @param {string} key
     * @param {string} field
     * @param {number|int=1} incrBy
     * @return {Promise.<int>} the value at field after the increment operation
     */
    hincr: proxyfy(RedisClient.prototype.hincr),

    /**
     * Removes the specified fields from the hash stored at key.
     * @param {string} key
     * @param {string} field
     * @return {Promise.<int>} the number of fields that were removed from the hash
     */
    hdel: proxyfy(RedisClient.prototype.hdel),

    /**
     * Returns the number of fields contained in the hash stored at key.
     * @param {string} key
     * @return {Promise.<int>} number of fields in the hash, or 0 when key does not exist
     */
    hlen: proxyfy(RedisClient.prototype.hlen),

    /* Sorted sets */

    /**
     * Increments the score of member in the sorted set stored at key by increment.
     * @param {string} key
     * @param {int} incrBy
     * @param {int|string} member
     * @param {Callback=} cb resp will be the new score of member
     * @return {Promise.<number>} the new score of member
     */
    zincrby: proxyfy(RedisClient.prototype.zincrby),

    /**
     * Returns the specified range of elements in the sorted set stored at key.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @return {Promise.<(string|int)[]>} list of elements in the specified range
     */
    zrange: proxyfy(RedisClient.prototype.zrange),

    /**
     * Removes all elements in the sorted set stored at key with rank between start and stop.
     * @param {string} key
     * @param {int} start
     * @param {int} stop
     * @return {Promise.<int>} the number of elements removed.
     */
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
            if (typeof returnIndex == 'function') {
                send_cb = returnIndex;
                returnIndex = null;
            }

            // Support for negative index
            if (returnIndex < 0 && !(this._multiStart && this._execLast)) returnIndex = l + returnIndex;

            // Create an Error object here to get better stack trace
            let errObj = new Error();
            errObj.name = 'RedisClientError';

            // Read next expected data
            let readNextData = (i) => {
                var shouldReturnObject = this._cbShouldReturnObject[i],
                    cb = this._callbacks[i];
                loadRESP(this.rclient, shouldReturnObject, (err, resp) => {
                    // Convert error string to error object
                    if (err && !(err instanceof Error)) {
                        // noinspection JSValidateTypes
                        errObj.message = err;
                        err = errObj;
                    }
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
                    cb && cb.call(this, err, resp);
                    if (err) this.emit('redis_error', err);
                    // Read next data or send callback if no more data
                    if (++i < l) readNextData(i);
                    else {
                        send_cb && send_cb.call(this, null, send_resp);
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
    RedisPipeline.prototype.destroy =
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
        rclient._poolIndex = i;
        this.clients.push(rclient);
    }
    this._connected = false;
    this.options = options;
}

// noinspection JSUnusedGlobalSymbols
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
                cb.call(this, null, client);
                break;
            }
        }
        // If no available clients found we subscribe for result events to get the 1st ready client
        if (!found) {
            let result_cb = () => {
                // Remove other listeners
                for (let i = 0; i < this.poolSize; i++) {
                    let client = this.clients[i];
                    client.removeListener('result', result_cb);
                    client.removeListener('connected', result_cb);

                }
                this.getAvailableClient(cb);
            };
            for (let i = 0; i < this.poolSize; i++) {
                let client = this.clients[i];
                client.once('result', result_cb);
                client.once('connected', result_cb);
            }
        }
        return this;
    },

    get numberOfClients() {
        var noc = 0;
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            if (client && client._connected) noc++;
        }
        return noc;
    },

    connect(cb) {
        var connected = false;
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i];
            if (!client) continue;
            client.on('connect_error', (err) => { this.emit('connect_error', err, client) });
            // Connect to client
            client.connect((err, resp) => {
                this._connected = true;
                // The 1st connection response will be used as pool connect response,
                //  we can immediately send commands if we have one client
                cb && cb.call(this, err, resp);
                cb = null;
                if (!err) {
                    // Emit connected event if not emitted
                    if (!connected) {
                        this.emit('connected');
                        connected = true;
                    }
                    // Emit client_connection event
                    this.emit("client_connected", client);
                    // Forward client events
                    client.on('error', (err) => {
                        this.emit('client_error', err, client)
                    });
                    client.on('disconnected', (had_error) => {
                        this.emit('client_disconnected', had_error, client)
                    });
                    // Handle redis errors
                    client.on('redis_error', (err) => {
                        console.error('redis error:', err);
                    });
                }
            });
        }
    },

    callRedisRaw(msg, shouldReturnObject, cb) {
        this.getAvailableClient((err, client) => {
            if (err) cb && cb.call(this, err);
            else client.callRedisRaw(msg, shouldReturnObject, cb);
        });
        return this;
    },

    disconnect(cb) {
        this._connected = false;
        var toDisconnect = this.poolSize;
        for (let i = 0; i < this.poolSize; i++) {
            let client = this.clients[i],
                lastErr = null;
            if (client._connected) {
                client.disconnect((err, resp) => {
                    if (err) lastErr = err;
                    if (--toDisconnect == 0) cb && cb.call(this, lastErr, resp);
                });
            } else if (--toDisconnect == 0) cb && cb.call(this, lastErr, !lastErr);
        }
    },

    pipeline() { return new RedisClientPoolPipeline(this) },

    /**
     * Start a transaction on an available client. This will block the client until EXEC is called
     * Use .pmulti() instead of this if possible, which creates a pipeline object then send everything at once.
     * @param {Callback=} cb
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
            if (err) send_cb && send_cb.call(this, err);
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
exports.rclient_async = null;


/**
 * Create redis connection objects
 * exports.rclient will be the callback based client
 * exports.rclient_async will be the promise based client
 * @param {int=6379} port Default is 6379
 * @param {string=} host Default is 127.0.0.1
 * @param {{}=} options
 * @param {Callback=} cb Called when connection established
 * @return {RedisClient|null}
 */
function createClient(port, host, options, cb) {
    port = port || 6379;
    host = host || '127.0.0.1';
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
 * @param {int=6379} port Default is 6379
 * @param {string=} host Default is 127.0.0.1
 * @param {{}=} options
 * @param {int=5} poolSize Size of client pool
 * @param {Callback=} cb Called when connection established
 * @return {RedisClient|null}
 */
function createClientPool(port, host, options, poolSize, cb) {
    port = port || 6379;
    host = host || '127.0.0.1';
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
    let options = global.REDIS_OPTIONS !== undefined ? REDIS_OPTIONS : {};
    // If we have global pool size config, we create a pool
    // noinspection JSUnresolvedVariable
    if (global.REDIS_POOL_SIZE) {
        // noinspection JSUnresolvedVariable
        createClientPool(REDIS_PORT, REDIS_HOST, options, REDIS_POOL_SIZE, function(err) {
            if (!err) {
                // noinspection JSUnresolvedVariable
                console.log('Redis client pool connected to %s:%i, pool size: %i', REDIS_HOST, REDIS_PORT, REDIS_POOL_SIZE);
            }

        });
    }
    // If not we just create a client
    else {
        // noinspection JSUnresolvedVariable
        createClient(REDIS_PORT, REDIS_HOST, options, function(err) {
            if (!err) {
                // noinspection JSUnresolvedVariable
                console.log('Redis client connected to %s:%i', REDIS_HOST, REDIS_PORT);
            }
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
