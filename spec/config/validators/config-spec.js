'use strict';

var configValidator = require('../../../lib/config/validators/config')();

describe('system_schema', function() {
    it('schema has defaults', function() {
        var context = {
            sysconfig: {
                teraslice: {
                    ops_directory: ''
                }
            }
        };

        var jobSchema = require('../../../lib/config/schemas/job').jobSchema(context);
        var jobSpec = {
            'operations': [{
                    '_op': 'noop'
                },
                {
                    '_op': 'noop'
                }
            ]
        };
        var validJob = {
            name: 'Custom Job',
            lifecycle: 'once',
            analytics: true,
            max_retries: 3,
            slicers: 1,
            operations: [
                {_op: 'noop'},
                {_op: 'noop'}
            ],
            assets: null,
            moderator: null
        };

        var jobConfig = configValidator.validateConfig(jobSchema, jobSpec);
        delete jobConfig.workers;
        expect(jobConfig).toEqual(validJob);
    });
});
