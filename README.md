# Noderis
A standalone Node.js client for Redis

## Features

- No external dependencies, it uses only standard Node.js modules.
- Can be used with standard **callback**, **Promises/A** and **async-await** syntaxes.
- Support for pipelines and transactions with MULTI-EXEC (shortcut: pmulti).
- The callback based functions and pipelines are chainable.
- Pipeline results emmitted to the commands callbacks.
- MSET can accept JS objects as well.
- Connection pools to handle more commands at the same time. If all clients in the pool are busy, commands are waiting for a free client.
- Connection pool is transparent, it is just a proxy for the 1st available connection. So you even don't notice that you use a pool. 
- Clear, understandable, not too complicated code. Redis commands are real functions, IDEs (like PHPStorm or Webstorm) can understand it.
- Methods and commands have a JSDoc comment with types specified.
- Good stack trace on redis error.

Maybe it's not as fast as a C++ based parser, but still very fast though. Official Node-redis has no connection pool feature, 
so only one command can be run at a time (or there would be collisions). So if you have 100 users at the same time, they
need to wait for each other. Connecting to Redis each time a client is connected still not a good solution beacause of the 
overhead of connecting. Because of overcomplicated design of Node-redis, it is hard to implement a connection pool with it 
(and would be much slower).
So this is why we implemeted the pool feature which I think may make Noderis faster than most clients.

### Cons

It is string based API, so no support for binary data (which I don't need, I store all binary data in base64). Although it
should not be hard to change it to use buffer instead of utf-8 strings. If you need it, please implement it and send a pull request.

## Usage

### Initialize

You can start using the module in several ways

#### Config by global variables

The easiest (IMO) is to create global config variables:
```javascript
global.REDIS_HOST = 'redis-server'; // The host of Redis server
global.REDIS_PORT = 6379; // The port of Redis server
global.REDIS_OPTIONS = {}; // Other Redis options (see in source code)
global.REDIS_POOL_SIZE = 10; // How many connections we need (5 is default)
```
This way we can use module level *rclient* and *rclient_async* objects to communicate with Redis.
If global.REDIS_POOL_SIZE is specified, connection pool is created instead of a single RedisClient object

#### Calling *createClient* or *createClientPool*

```javascript
createClient(REDIS_PORT, REDIS_HOST, options, function() {
    console.log('Redis client connected to %s:%i', REDIS_HOST, REDIS_PORT);
});
``` 

#### By creating objects

```javascript
let rclient = new RedisClient(port, host, options);
let rclient_async = new RedisClientAsyncProxy(rclient);
rclient.connect(() => {
    console.log('Redis client connected.');
});
```

### Calling commands

#### Callback based API

You can call any Redis commands with *callRedis* method like this:
```javascript
rclient.callRedis('SET', 'testKey', 'testValue', (err, resp) => {
    if (err) _handleError(err);
    else {
        console.log(resp);
    }
});
```
 
Though we created preprocessors/shortcuts for some (the goal is to create for all) commands:
```javascript
rclient.set('testKey', 'testValue', (err, resp) => {
    //...
});
```

#### Promise / async-await API

The same in async way:

```javascript
try {
    let resp = await rclient_async.callRedis('SET', 'testKey', 'testValue');
    let resp = await rclient_async.set('testKey, testValue');
} catch(err) {
    _handleError(err);
}
```

### Events

- `connected`: Emitted when connection is ready. It is called once. If you use pool, emmitted when 1st client is connected.
- `disconnected`: When the client is disconnected. In pool emitted if all clients are disconnected. 
- `connect_error`: When error occured while connecting, or connection timeout occured.
- `error`: Errors in connection and communication with Redis server.
- `redis_error`: Errors from Redis server and protocol errors.

**ConnectionPool**

All events are the same (because pool is transparent), but you can listen on the following client events if you want:

- `client_connected`: When a client is connected in the pool.
- `client_disconnected`: When any client is disconnected in the pool.


### Pipeline and (MULTI-EXEC) transaction 

Creating pipeline is very easy, then you can chain every command:
```javascript
// Callback based
rclient.pipeline()
    .set('test', 'val')
    .get('test', (err, resp) => {
        // this is optional to have callback here
        // resp will be the emmitted result of answer from pipeline 
    })
    .send((err, resp) => {
        // Here resp is an array of all comands results 
    });
```
At the end of the pipeline, you need to send it. It will send all commands at once to Redis, which is faster because of no 
send-receive overhead.

You can specify an index to the send() method, to get only one command's result. If it is negative we can get the result from bottom:
```javascript
    // ...
    .send(-1, (err, resp) => {
        // resp will be the result of the last command of the pipeline 
    });
    
``` 

Async await based example:
```javascript
let resp = await rclient_async.pipeline()
    .set('test', 'val')
    .get('test', (err, resp) => {
        // this is optional to have callback here
        // resp will be the emmitted result of answer from pipeline 
    })
    .send(-1);
console.log("Result of the last command before send():", resp);
```

#### Transaction

Transactions in Redis implemented by calling MULTI, then at the end EXEC. Though it is not very useful without pipeline
it can have problems as well:
- MULTI calls cannot be nested!
- If you start a MULTI transaction and other users start commands, it will be included in the same transaction until EXEC is called
- If you use clientPool, it is handled there, but that client will be marked busy until EXEC is called. 

So we suggest to use our pmulti() method which starts a pipeline then put a MULTI as 1st command in it. It even closes the MULTI
automatically with EXEC on send() (if not disabled in options).

Example:
```javascript
let resp = await rclient_async.pmulti()
    .set('test', 'val')
    .get('test', (err, resp) => {
        // this is optional to have callback here
        // resp will be the emmitted result of answer from EXEC 
    })
    .send(-1);
```

Our pipeline implementation uses the results of EXEC - if it is the 1st command in the pipeline -, not the whole pipeline, where
every additional command returns with a "QUEUED" response. Instead we will get the real results. 

## Further goals

- Implement all Redis commands
- Create documentation for every command
- Not blindly implement all, but if it ispossible, make it more JS and programmer friendly (e.g. SET, MSET... in source code)
- Create benchmarks

## Status

Currently the base of the module is done, but not all commands have shortcut and comments.

If you use this module and need to use commands which are not supported, or simply want to help, 
it is very easy to add new commands. 
If you extend Noderis, please send pull request!

### Adding new commands

All commands should have doc comments in JSDoc standard.
You need to add the implementation in the prototype of RedisClient:

```javascript
RedisClient.prototype = {
    // ...
    /**
     * Command description 
     * @param {string} param1
     * @param {string} param2
     * @param {Callback=} cb resp will be ... (document what resp will be in the callback)
     * @return {RedisClient}
     */
    command(param1, param2, cb) {
        return this.callRedis('COMMAND', cb, param1, param2);
    }
    //...
}
``` 
Then you need to add it to the Promise based proxy:
```javascript
RedisClientAsyncProxy.prototype = {
    // ...
    /**
     * Command description 
     * @param {string} param1
     * @param {string} param2
     * @param {Callback} cb resp will be ... (document what resp will be in the callback)
     * @return {Promise.<string>} Should be documented which type and meaning
     */
    command: proxyfy(RedisClient.prototype.command)
    // ...
}
```

## Unit tests

Unit tests use Mocha. If you have mocha and redis server installed on your local machine you can simple run
`mocha`. If not, you need Docker to test with dockunit-plus. Simple run `npm test` to start test in a docker 
container.
