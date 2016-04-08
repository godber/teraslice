'use strict';

var _ = require('lodash');
var Promise = require('bluebird');

var Queue = require('../../utils/queue');

// Queue of jobs pending processing
var pendingJobsQueue;

/*
    Job Life Cycle for _status
        pending -> scheduling -> running -> [ paused -> running ] -> [ stopped | finished ]
    Exceptions
        rejected - when a job is rejected prior to scheduling
        failed - when there is an error while the job is running
        aborted - when a job was running at the point when the cluster shutsdown
 */
var VALID_STATUS = ['pending', 'scheduling', 'running', 'paused', 'stopped', 'rejected', 'failed', 'aborted'];

// Maps job notification to Job states
var STATE_MAPPING = {
    'stop': 'stopped',
    'pause': 'paused',
    'resume': 'running'
}

// Maps job control messages into cluster control messages.
var MESSAGE_MAPPING = {
    'pause': 'pause slicer',
    'resume': 'resume slicer',
    'restart': 'restart slicer',
    'stop': 'stop job'
}

var initializing = true;

module.exports = function(context, cluster_service) {
    var logger = context.logger;

    var job_store = require('../storage/jobs')(context);

    _initialize(); // Load the initial pendingJobs state.

    var pendingJobsScheduler = setInterval(function() {
        _allocateJobs();
    }, 1000);

    function submitJob(job_spec) {
        _validateJob(job_spec);

        // Default status for jobs is pending
        return _setStatus(job_spec, 'pending')
            .then(function(job) {
                pendingJobsQueue.enqueue(job);
                return job.job_id;
            });
    }

    // Updates the job but does not automatically start it.
    function updateJob(job_id, job_spec) {
        return getJob(job_id)
            .then(function(job) {
                if (job._status == 'pending' || job._status == 'scheduling') {
                    throw new Error("Job's can not be updated when in pending or scheduling state");
                }

                if (job._status == 'running' || job._status == 'paused') {
                    throw new Error("Job must be stopped before it can be updated.");
                }

                return job_store.update(job_id, job_spec);
            })
    }

    // Valid notifications: stop, pause, resume
    function notify(job_id, state) {
        var status = STATE_MAPPING[state];

        return _signalJobStateChange(job_id, state, status);
    }

    function startJob(job_id) {
        // This will require the job to be scheduled as new.
        return getJob(job_id)
            .then(function(job_spec) {
                return submitJob(job_spec);
            });
    }

    function getJob(job_id) {
        return job_store.get(job_id)
            .then(function(job_spec) {
                return job_spec;
            });
    }

    function jobStatus(job_id) {
        return getJob(job_id)
            .then(function(job_spec) {
                return job_spec.status;
            });
    }

    function getJobs(status, from, size) {
        // This is looking at persistent storage. In some scenarios the in memory
        // queue may differ.
        return job_store.getJobs(status, from, size);
    }

    // Checks the queue of pending jobs and will allocate any workers required.
    function _allocateJobs() {
        function allocateJob() {
            if (pendingJobsQueue.size() > 0) {
                if (cluster_service.availableWorkers() > 0) {
                    var job = pendingJobsQueue.dequeue();

                    logger.info("JobsService: Scheduling job: " + job.job_id)
                    _setStatus(job, 'scheduling').then(function() {
                        cluster_service.allocateSlicer(job).then(function() {
                            var workers = [];
                            for (var i = 0; i < job.workers; i++) {
                                workers.push(cluster_service.allocateWorker(job));
                            }
// TODO: error conditions here. not allocating all workers.
                            return Promise.all(workers).then(function() {
                                _setStatus(job, 'running');

                                allocateJob();
                            });
                        })
                        .error(function(err) {
                            _setStatus(job, 'failed');
                            throw err;
                        });
                    });
                }
            }
        }

        allocateJob();
    }

    function _signalJobStateChange(job_id, notice, state) {
        return _notifyCluster(job_id, notice)
            .then(function() {
                return job_store.get(job_id)
                    .then(function(job_spec) {
                        return _setStatus(job_spec, state);
                    });
            })
            .then(function(job) {
                return true;
            });
    }

// TODO: this will need to send a notification to all workers for the job in the cluster.
    function _notifyCluster(job_id, notice) {
        var slicerOnly = false;
        if (notice === 'pause' || notice === 'resume') slicerOnly = true;

        if (MESSAGE_MAPPING.indexOf(notice) == -1) {
            throw new Error("JobsService: invalid notification message");
        }

        var message = MESSAGE_MAPPING[notice];

        return cluster_service.findNodesForJob(job_id, slicerOnly)
            .then(function(nodes) {
                var requests = [];
                nodes.forEach(function(node) {
// TODO: this doesn't actually work yet. pending re-examination of the node_master
                    message = cluster_service.notifyNode(node.node_id, message, '');
                    requests.push(message);
                });

                return Promise.all(requests)
                    .then(function() { return true });
            })
    }

    function _setStatus(job_spec, status) {
        if (VALID_STATUS.indexOf(status) != -1) {
            if (job_spec.job_id) {
                return job_store.update(job_spec.job_id, {
                    _status: status
                });
            }
            else {
                job_spec._status = status;

                return job_store.create(job_spec);
            }
        }
        else {
            throw new Error("Invalid Job status: " + status);
        }
    }

    function _validateJob(job_spec) {
        if (! job_spec.workers) job_spec.workers = 5;
    }

    function _initialize() {
        if (initializing) {
            pendingJobsQueue = new Queue;

            // Reschedule any persistent jobs that were running.
            // There may be some additional subtlety required here.
            getJobs('running').each(function(job) {
// TODO: For this restarting to work correctly we need to check the job on the running
// cluster to make sure it's not still running after a cluster_master restart.
                if (job.lifecycle === 'persistent') {
                    //pendingJobsQueue.enqueue(job);
                }
                else {
                    //_setStatus(job, 'aborted');
                }
            })
            .then(function() {
                // Loads the initial pending jobs queue from storage.
                // Currently this will not preserve the order.
                getJobs('pending').each(function(job) {
                    pendingJobsQueue.enqueue(job);
                })
                .then(function() {
                    logger.info("JobsService: Pending Jobs initialization complete.");
                    initializing = false;
                })
            })
            .error(function(err) {
                logger.error("JobsService: initialization failed loading state from Elasticsearch: " + err);
            });
        }
    }

    return {
        submitJob: submitJob,
        updateJob: updateJob,
        notify: notify,
        getJob: getJob,
        getJobs: getJobs,
        startJob: startJob
    }
}