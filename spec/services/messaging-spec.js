'use strict';

const messagingModule = require('../../lib/cluster/services/messaging');
const events = require('events');
const Promise = require('bluebird');

const eventEmitter = new events.EventEmitter();

describe('messaging module', () => {
    const logger = {
        error() {},
        info() {},
        warn() {},
        trace() {},
        debug() {},
        flush() {}
    };

    const testExId = '7890';
    eventEmitter.setMaxListeners(40);

    class MyEmitter extends events {
        constructor() {
            super();
        }
    }
    let firstWorkerMsg = null;
    let secondWorkerMsg = null;
    let thirdWorkerMsg = null;

    beforeEach(() => {
        firstWorkerMsg = null;
        secondWorkerMsg = null;
        thirdWorkerMsg = null;
    });
    let clusterFn = () => {};

    class MyCluster extends events {
        constructor() {
            super();
            this.workers = {
                first: {
                    ex_id: testExId,
                    assignment: 'execution_controller',
                    send: msg => firstWorkerMsg = msg,
                    on: (key, fn) => clusterFn = fn
                },
                second: {
                    ex_id: testExId,
                    assignment: 'worker',
                    send: msg => secondWorkerMsg = msg,
                    on: (key, fn) => clusterFn = fn
                },
                third: {
                    ex_id: 'somethingElse',
                    assignment: 'worker',
                    send: msg => thirdWorkerMsg = msg,
                    on: (key, fn) => clusterFn = fn
                }
            };
        }
    }

    let emitMsg = null;
    let socketMsg = null;

    const io = {
        emit: (msg, msgObj) => emitMsg = { message: msg, data: msgObj },
        sockets: {
            in: address => ({
                emit: (msg, msgObj) => socketMsg = { message: msg, data: msgObj, address }
            })
        },
        eio: {
            clientsCount: 2
        }
    };

    const clusterEmitter = new MyCluster();
    clusterEmitter.setMaxListeners(40);

    const context = {
        sysconfig: {
            teraslice: {
                master_hostname: '127.0.0.1',
                port: 47898,
                action_timeout: 5000,
                network_latency_buffer: 10
            }
        },
        apis: {
            foundation: {
                getSystemEvents: () => eventEmitter
            }
        },
        cluster: clusterEmitter
    };
    const childHookFn = () => {};


    function getContext(obj) {
        const emitter = new MyEmitter();
        emitter.setMaxListeners(40);
        const config = Object.assign(emitter, obj);
        return Object.assign({}, context, { __testingModule: config });
    }

    it('can make a hostname', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger);
        const makeHostName = messaging.__test_context()._makeHostName;
        const getHostUrl = messaging.getHostUrl;

        expect(makeHostName('127.0.0.1', 5647)).toEqual('http://127.0.0.1:5647');
        expect(makeHostName('127.0.0.1:', 5647)).toEqual('http://127.0.0.1:5647');

        expect(makeHostName('http://127.0.0.1', 5647)).toEqual('http://127.0.0.1:5647');
        expect(makeHostName('https://127.0.0.1', 5647)).toEqual('https://127.0.0.1:5647');

        expect(makeHostName('127.0.0.1', 5647, 'v1')).toEqual('http://127.0.0.1:5647/v1');
        expect(getHostUrl()).toEqual('http://127.0.0.1:47898');
    });

    it('can detect itself and make configurations', () => {
        function getConfig(type) {
            const config = context.sysconfig.teraslice;
            const job = JSON.stringify({
                slicer_hostname: config.master_hostname,
                slicer_port: config.port
            });
            const testContext = getContext({ env: { assignment: type, job } });
            const testModule = messagingModule(testContext, logger, childHookFn).__test_context();
            return testModule._makeConfigurations();
        }

        expect(getConfig('node_master')).toEqual({
            clients: { networkClient: true, ipcClient: false },
            hostURL: 'http://127.0.0.1:47898',
            assignment: 'node_master'
        });
        expect(getConfig('cluster_master')).toEqual({
            clients: { networkClient: false, ipcClient: true },
            assignment: 'cluster_master'
        });

        expect(getConfig('execution_controller')).toEqual({
            clients: { networkClient: false, ipcClient: true },
            assignment: 'execution_controller'
        });

        expect(getConfig('worker')).toEqual({
            clients: { networkClient: true, ipcClient: true },
            hostURL: 'http://127.0.0.1:47898',
            assignment: 'worker'
        });

        expect(getConfig('assets_loader')).toEqual({
            clients: { networkClient: false, ipcClient: true },
            assignment: 'assets_loader'
        });

        expect(getConfig('assets_service')).toEqual({
            clients: { networkClient: true, ipcClient: true },
            hostURL: 'http://127.0.0.1:47898',
            assignment: 'assets_service'
        });
    });

    it('can be called without errors', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });

        expect(() => messagingModule(testContext, logger, childHookFn)).not.toThrow();
    });

    it('has a router', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger, childHookFn);
        const routing = messaging.__test_context().routing;

        const routingData = {
            cluster_master: { execution_controller: 'network', node_master: 'network', assets_loader: 'ipc' },
            node_master: { cluster_process: 'ipc', cluster_master: 'network', execution_controller: 'ipc', worker: 'ipc', assets_loader: 'ipc', execution: 'ipc' },
            execution_controller: { worker: 'network', cluster_master: 'ipc', node_master: 'ipc' },
            worker: { execution_controller: 'network', cluster_master: 'ipc', node_master: 'ipc' },
            assets_loader: { execution: 'ipc', cluster_master: 'ipc' },
            assets_service: { cluster_master: 'ipc' }
        };

        expect(routing).toEqual(routingData);
    });

    it('can determie path for message', () => {
        const testContext1 = getContext({ env: { assignment: 'node_master' } });
        const messaging1 = messagingModule(testContext1, logger, childHookFn);
        const routerNodeMaster = messaging1.__test_context()._determinePathForMessage;

        const testContext2 = getContext({ env: { assignment: 'cluster_master' } });
        const messaging2 = messagingModule(testContext2, logger, childHookFn);
        const routerClusterMaster = messaging2.__test_context()._determinePathForMessage;

        const testContext3 = getContext({ env: { assignment: 'execution_controller' } });
        const messaging3 = messagingModule(testContext3, logger, childHookFn);
        const routerExecutionController = messaging3.__test_context()._determinePathForMessage;

        const testContext4 = getContext({ env: { assignment: 'assets_service' } });
        const messaging4 = messagingModule(testContext4, logger, childHookFn);
        const routerAssetsService = messaging4.__test_context()._determinePathForMessage;

        const failureMessage1 = { to: 'theUnknown' };
        const failureMessage2 = { to: 'worker' };

        expect(routerNodeMaster({ to: 'cluster_process' })).toEqual('ipc');
        expect(routerNodeMaster({ to: 'cluster_master' })).toEqual('network');
        expect(routerNodeMaster({ to: 'execution' })).toEqual('ipc');
        expect(routerNodeMaster({ to: 'execution_controller' })).toEqual('ipc');
        expect(routerNodeMaster({ to: 'worker' })).toEqual('ipc');

        expect(() => routerNodeMaster(failureMessage1)).toThrow();

        expect(routerExecutionController({ to: 'cluster_master' })).toEqual('ipc');
        expect(routerExecutionController({ to: 'worker' })).toEqual('network');

        expect(routerClusterMaster({ to: 'execution_controller' })).toEqual('network');
        expect(routerClusterMaster({ to: 'node_master' })).toEqual('network');
        expect(routerClusterMaster({ to: 'assets_loader' })).toEqual('ipc');
        // this tests a shutdown message back to the cluster master process itself
        expect(routerClusterMaster({ to: 'node_master', message: 'shutdown' })).toEqual('ipc');
        // this is directed to specific node_master with no cluster_master
        expect(routerClusterMaster({ to: 'node_master', message: 'shutdown', address: 'someAddress' })).toEqual('network');

        expect(routerAssetsService({ to: 'cluster_master' })).toEqual('ipc');
        expect(() => routerAssetsService(failureMessage2)).toThrow();
    });

    it('can send process messages', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger);
        const sendToProcesses = messaging.__test_context()._sendToProcesses;
        const firstMsg = { to: 'execution_controller', ex_id: testExId, message: 'execution:stop' };
        const secondMsg = { to: 'worker', ex_id: testExId, message: 'execution:stop' };
        const thirdMsg = { to: 'worker', message: 'worker:shutdown' };
        const executionMsg = { to: 'execution', meta: 'someData', ex_id: testExId, message: 'worker:shutdown' };

        expect(firstWorkerMsg).toEqual(null);
        expect(secondWorkerMsg).toEqual(null);
        expect(thirdWorkerMsg).toEqual(null);

        sendToProcesses(firstMsg);

        expect(firstWorkerMsg).toEqual(firstMsg);
        expect(secondWorkerMsg).toEqual(null);
        expect(thirdWorkerMsg).toEqual(null);

        sendToProcesses(secondMsg);

        expect(firstWorkerMsg).toEqual(firstMsg);
        expect(secondWorkerMsg).toEqual(secondMsg);
        expect(thirdWorkerMsg).toEqual(null);

        sendToProcesses(thirdMsg);

        expect(firstWorkerMsg).toEqual(firstMsg);
        expect(secondWorkerMsg).toEqual(thirdMsg);
        expect(thirdWorkerMsg).toEqual(thirdMsg);

        sendToProcesses(executionMsg);

        expect(firstWorkerMsg).toEqual(executionMsg);
        expect(secondWorkerMsg).toEqual(executionMsg);
        expect(thirdWorkerMsg).toEqual(thirdMsg);
    });

    it('can forward/broadcast messages', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger);
        const forwardMessage = messaging.__test_context(io)._forwardMessage;
        const workerMsg = { to: 'worker', ex_id: testExId, message: 'execution:stop' };

        forwardMessage({ to: 'cluster_master', message: 'someEvent' });
        // should be a network emit msg
        expect(emitMsg).toEqual({
            message: 'someEvent',
            data: {
                to: 'cluster_master',
                message: 'someEvent'
            }
        });

        messaging.broadcast('someEvent', { some: 'data' });
        expect(emitMsg).toEqual({
            message: 'networkMessage',
            data: {
                some: 'data',
                message: 'someEvent'
            }
        });

        forwardMessage(workerMsg);
        // should be a process msg
        expect(secondWorkerMsg).toEqual(workerMsg);

        const testContext2 = getContext({ env: { assignment: 'cluster_master' } });
        const messaging2 = messagingModule(testContext2, logger);
        const clusterMasterForwarding = messaging2.__test_context(io)._forwardMessage;

        clusterMasterForwarding({
            to: 'execution_controller',
            message: 'execution:stop',
            address: 'someNodeMaster'
        });
        // should be a network socket msg, sent to a specific node
        expect(socketMsg).toEqual({
            message: 'networkMessage',
            address: 'someNodeMaster',
            data: {
                to: 'execution_controller',
                message: 'execution:stop',
                address: 'someNodeMaster'
            }
        });

        let sentProcessMsg = null;
        const sentToProcess = msg => sentProcessMsg = msg;
        const testContext3 = getContext({
            env: {
                assignment: 'execution_controller'
            },
            send: sentToProcess
        });
        const messaging3 = messagingModule(testContext3, logger);
        const executionControllerForwarding = messaging3.__test_context(io)._forwardMessage;

        executionControllerForwarding({
            to: 'worker',
            message: 'slicer:slice:new',
            address: 'someSpecificWorker'
        });
        // should be a network socket msg, sent to a specific node
        expect(socketMsg).toEqual({
            message: 'slicer:slice:new',
            address: 'someSpecificWorker',
            data: {
                to: 'worker',
                message: 'slicer:slice:new',
                address: 'someSpecificWorker'
            }
        });

        executionControllerForwarding({
            to: 'cluster_master',
            message: 'cluster:slicer:analytics'
        });
        // should be a ipc msg, sent to a specific node
        expect(sentProcessMsg).toEqual({
            to: 'cluster_master',
            message: 'cluster:slicer:analytics'
        });
    });

    it('can work with messaging:response messages', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger, childHookFn);
        const handleResponse = messaging.__test_context()._handleResponse;
        const msgId = 'someId';
        const nodeMsg = { __source: 'node_master', __msgId: msgId, message: 'someMessage' };
        const workerMsg = { to: 'worker', ex_id: testExId, message: 'execution:stop' };

        let emittedData = null;

        eventEmitter.on(msgId, data => emittedData = data);

        handleResponse(nodeMsg);
        expect(emittedData).toEqual(nodeMsg);

        handleResponse(workerMsg);
        // should be a process msg
        expect(secondWorkerMsg).toEqual(workerMsg);
    });

    it('can getClientCounts', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger, childHookFn);

        expect(messaging.getClientCounts()).toEqual(0);
        messaging.__test_context(io);

        expect(messaging.getClientCounts()).toEqual(2);
    });

    it('can send transactional and non-transactional messages', (done) => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger, childHookFn);
        const workerMsg = { to: 'worker', ex_id: testExId, message: 'execution:stop' };
        const transactionalMsg = Object.assign({}, workerMsg, { response: true });
        const transactionalErrorMsg = Object.assign(
            {},
            workerMsg,
            { response: true, error: 'someError' }
        );
        const transactionalTimeoutErrorMsg = Object.assign(
            {},
            workerMsg,
            { response: true, error: 'someError', timeout: 30 }
        );

        function sendEvent(timer) {
            return new Promise((resolve) => {
                setTimeout(() => {
                    let msgId;
                    if (secondWorkerMsg) {
                        msgId = secondWorkerMsg.__msgId;
                    } else {
                        msgId = '12345';
                    }
                    eventEmitter.emit(msgId, secondWorkerMsg);
                    resolve();
                }, timer);
            });
        }

        // this is technically a sync message, but a promise is returned for composability
        // and to act similiar to its transactional counterpart
        messaging.send(workerMsg)
            .then((bool) => {
                expect(bool).toEqual(true);
                expect(secondWorkerMsg).toEqual(workerMsg);
                return Promise.all([messaging.send(transactionalMsg), sendEvent(20)]);
            })
            .spread((results) => {
                expect(results).toEqual(secondWorkerMsg);
                // testing error scenario
                return Promise.all([messaging.send(transactionalErrorMsg), sendEvent(20)])
                    .catch((err) => {
                        expect(err).toEqual('Error: someError occurred on node: node_master');
                        return Promise.all([
                            messaging.send(transactionalTimeoutErrorMsg),
                            sendEvent(100)
                        ])
                            .catch((error) => {
                                const messageSent = secondWorkerMsg;
                                expect(error).toEqual(`timeout error while communicating with ${messageSent.to}, msg: ${messageSent.message}, data: ${JSON.stringify(messageSent)}`);
                                return true;
                            });
                    });
            })
            .catch(fail)
            .finally(done);
    });

    it('can respond', (done) => {
        let sentProcessMsg = null;
        const sentToProcess = msg => sentProcessMsg = msg;
        const testContext = getContext({
            env: {
                assignment: 'execution_controller'
            },
            send: sentToProcess
        });
        const messaging = messagingModule(testContext, logger, childHookFn);
        const workerMsg = {
            to: 'execution_controller',
            ex_id: testExId,
            message: 'execution:stop',
            __msgId: 1234,
            __source: 'cluster_master'
        };

        messaging.respond(workerMsg, { some: 'data' })
            .then(() => {
                expect(sentProcessMsg).toEqual({
                    some: 'data',
                    __msgId: 1234,
                    __source: 'cluster_master',
                    message: 'messaging:response',
                    to: 'cluster_master'
                });
            })
            .catch(fail)
            .finally(done);
    });

    it('can register callbacks and attach them to socket/io', () => {
        const testContext = getContext({ env: { assignment: 'node_master' } });
        const messaging = messagingModule(testContext, logger, childHookFn);
        const getRegistry = messaging.__test_context()._getRegistry;
        const registerFns = messaging.__test_context()._registerFns;
        let exitIsCalled = false;
        const socketSettings = [];

        messaging.register({
            event: 'network:connect',
            identifier: 'node_id',
            callback: (msg, id, identifier) => {
                socketSettings.push({ msg, id, identifier });
                return true;
            }
        });

        messaging.register({
            event: 'cluster:node:get_port',
            callback: () => 3452
        });

        messaging.register({
            event: 'child:exit',
            callback: () => exitIsCalled = true
        });

        expect(() => messaging.register({
            event: 'some:event',
            callback: () => exitIsCalled = true
        })).toThrow();

        const results = getRegistry();

        expect(results['cluster:node:get_port']).toBeDefined();
        expect(typeof results['cluster:node:get_port']).toEqual('function');
        expect(results['cluster:node:get_port']()).toEqual(3452);

        // it internally maps 'network:connect' to connect
        expect(results.connect).toBeDefined();
        expect(typeof results.connect).toEqual('function');
        expect(results.connect()).toEqual(true);
        expect(results.connect.__socketIdentifier).toEqual('node_id');

        // node master sets the event on the cluster obj
        context.cluster.emit('exit');
        expect(exitIsCalled).toEqual(true);

        socketSettings.shift();

        const socketList = {};
        const joinList = {};
        const socket = {
            on: (key, fn) => socketList[key] = fn,
            join: id => joinList[id] = id
        };

        registerFns(socket);
        socketList.connect({ node_id: 'someId' });
        expect(socketSettings[0]).toEqual({
            msg: { node_id: 'someId' },
            id: 'someId',
            identifier: 'node_id'
        });
    });

    it('can listen and setup server', () => {
        const testContext1 = getContext({ env: { assignment: 'node_master' } });
        const messaging1 = messagingModule(testContext1, logger, childHookFn);

        const testContext2 = getContext({ env: { assignment: 'cluster_master' } });
        const messaging2 = messagingModule(testContext2, logger, childHookFn);

        const testContext3 = getContext({ env: { assignment: 'execution_controller' } });
        const messaging3 = messagingModule(testContext3, logger, childHookFn);

        expect(() => messaging1.listen()).not.toThrow();
        expect(() => messaging2.listen({ port: 45645, server: {} })).not.toThrow();
        expect(() => messaging3.listen({ port: 45647 })).not.toThrow();
    });

    it('sets up listerns', () => {
        const testContext1 = getContext({ env: { assignment: 'node_master' } });
        const messaging1 = messagingModule(testContext1, logger, childHookFn);
        messaging1.__test_context(io);

        context.cluster.emit('online', { id: 'first' });
        clusterFn({ to: 'cluster_master' });
        clusterFn({ to: 'node_master' });
        clusterFn({ to: 'worker' });

        const testContext2 = getContext({ env: { assignment: 'execution_controller' } });
        const messaging2 = messagingModule(testContext2, logger, childHookFn);
        messaging2.__test_context(io);
        testContext2.__testingModule.emit('message', {
            to: 'cluster_master',
            message: 'cluster:slicer:analytics'
        });
    });
});
