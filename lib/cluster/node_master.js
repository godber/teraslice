'use strict';

//TODO look into dynamic validations with convict based on lifecycles
//TODO for master shutdown, need to empty newWorkerQueue so no restarts happen
var Queue = require('../utils/queue');
var newWorkerQueue = new Queue;
var makeHostName = require('../utils/cluster').makeHostName;
var _ = require('lodash');

function getNodeState(context) {
    var state = {
        node_id: context.sysconfig._nodeName,
        total: context.sysconfig.terafoundation.workers,
        hostname: context.sysconfig.teraslice.hostname
    };
    var clusterWorkers = context.cluster.workers;
    var active = [];

    for (var childID in clusterWorkers) {
        var child = {
            worker_id: clusterWorkers[childID].id,
            assignment: clusterWorkers[childID].assignment,
            pid: clusterWorkers[childID].process.pid
        };

        if (clusterWorkers[childID].job_id) {
            child.job_id = clusterWorkers[childID].job_id
        }

        active.push(child);
    }

    state.active = active;
    state.available = state.total - active.length;

    return state;
}

module.exports = function(context) {
    var cluster = context.cluster;
    var logger = context.logger;
    var configWorkers = context.sysconfig.terafoundation.workers;
    var workerCount = configWorkers ? configWorkers : require('os').cpus().length;
    var sendProcessMessage = require('../utils/config').sendProcessMessage;

    //temporary
    var processDone = 0;

    if (workerCount === 0) {
        throw new Error(' Number of workers specified in terafoundtion configuration need to be set to greater than zero')
    }

    if (context.sysconfig.teraslice.cluster.master) {
        context.foundation.startWorkers(1, {assignment: 'cluster_master'});
    }

    var config = context.sysconfig.teraslice;
    var host = makeHostName(config.cluster.master_hostname, config.cluster.port);

    logger.info("node " + context.sysconfig._nodeName + " is attempting to connect to: " + host);

    var socket = require('socket.io-client')(host, {reconnect: true});


    function messageWorkers(context, clusterMsg, processMsg, filterFn, resultsFn) {
        var workers = context.cluster.workers;

        var allWorkersForJob = _.filter(workers, filterFn);

        _.each(allWorkersForJob, function(worker) {
            if (resultsFn) {
                resultsFn(worker)
            }
            worker.send(processMsg)
        });

        socket.emit('message processed', clusterMsg)
    }

    socket.on('connect', function() {
        logger.info('node has successfully connected to: ' + host);
        socket.emit('node online', getNodeState(context))
    });

    socket.on('disconnect', function() {
        logger.info('node has disconnected from: ' + host)
    });

    socket.on('create slicer', function(msg) {
        var slicerContext = {assignment: 'slicer', job: msg.job, job_id: msg.job_id};
        //used to retry a job on startup after a stop command
        if(msg.jobRetry){
            slicerContext.jobRetry = true;
        }

        context.foundation.startWorkers(1, slicerContext);
        socket.emit('message processed', msg);
        socket.emit('node state', getNodeState(context));

        workerCount--;
    });

    socket.on('create workers', function(msg) {
        context.foundation.startWorkers(msg.workers, {assignment: 'worker', job: msg.job, job_id: msg.job_id});
        socket.emit('message processed', msg);
        socket.emit('node state', getNodeState(context));
    });

    socket.on('get node state', function() {
        socket.emit('node state', getNodeState(context));
    });

    socket.on('terminate job', function(data) {
        //context, clusterMsg, fn, processMsg
        messageWorkers(context, data, {message: 'shutdown'}, function(worker) {
            return worker.job_id === data.job_id
        });

        socket.emit('node state', getNodeState(context));
    });

//TODO verify if we can combine terminate job and stop job calls, they seem to do the same things
    socket.on('stop job', function(data) {
        messageWorkers(context, data, {message: 'shutdown'}, function(worker) {
            return worker.job_id === data.job_id
        });
        socket.emit('node state', getNodeState(context));
    });

    socket.on('pause slicer', function(data) {
        messageWorkers(context, data, {message: 'pause'}, function(worker) {
            return worker.job_id === data.job_id && worker.assignment === 'slicer'
        });
    });

    socket.on('resume slicer', function(data) {
        messageWorkers(context, data, {message: 'resume'}, function(worker) {
            return worker.job_id === data.job_id && worker.assignment === 'slicer'
        });
    });

    socket.on('restart slicer', function(data) {
        messageWorkers(context, data, {message: 'exit for retry'},
            function(worker) {
                return worker.job_id === data.job_id && worker.assignment === 'slicer'
            },
            function(worker) {
                newWorkerQueue.enqueue({
                    assignment: worker.assignment,
                    job: worker.job,
                    job_id: worker.job_id,
                    jobRetry: true
                });
            });
    });


    function messageHandler(msg) {

        if (msg.message === 'shutdown') {
            processDone++;
            cluster.workers[msg.id].kill('SIGINT');
            //temporary

            if (Object.keys(cluster.workers).length === processDone) {
                process.exit()
            }
        }
        else if (msg.message === 'job finished') {
            //sending job finished notification to cluster_master
            socket.emit('job finished', msg.job_id);
        }
    }

    cluster.on('online', function(worker) {
        cluster.workers[worker.id].on('message', messageHandler);
    });

    cluster.on('exit', function(worker) {

        //used to catch slicer shutdown to allow retry, allows to bypass the jobRequest requestedWorkers
        if (worker.assignment === 'slicer' && newWorkerQueue.size()) {
            context.foundation.startWorkers(1, newWorkerQueue.dequeue());
            socket.emit('node state', getNodeState(context));
        }
        else {
            //look into maybe debouncing this to create less chatter for cluster_master
            socket.emit('node state', getNodeState(context));
        }
    })

};