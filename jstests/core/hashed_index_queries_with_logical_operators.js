/**
 * Test to verify the behaviour of compound hashed indexes when the queries use logical operators
 * like $or, $not etc.
 * For $not, we test two case
 *  1. When hashed field is a prefix, we cannot use index because the index could
 * incorrectly filter out matching documents which collide with the same hash value as the one given
 * in the query predicate.
 * 2. When non-hashed field is prefix, we can always use index for $not, but we currently don't.
 * SERVER-44011 is intended to address that.
 *
 * @tags: [requires_fcv_44]
 */
(function() {
"use strict";

load("jstests/aggregation/extras/utils.js");  // For arrayEq().
load("jstests/libs/analyze_plan.js");         // For assertStagesForExplainOfCommand().

const coll = db.hashed_index_queries_with_logical_operators;
coll.drop();

assert.commandWorked(coll.insert({}));
assert.commandWorked(coll.insert({a: null}));
assert.commandWorked(coll.insert({a: 12, b: 12}));
assert.commandWorked(coll.insert({b: 12}));
assert.commandWorked(coll.insert({a: null, b: 12}));

/**
 * Run find command with the 'filter' and projection' provided in the input, then validates
 * that the output returned matches 'expectedOutput'. Also runs explain() command on the same find
 * command, validates that all the 'expectedStages' are present in the plan returned and all the
 * 'stagesNotExpected' are not present in the plan.
 */
function validateFindCmdOutputAndPlan({
    filter,
    projection = {
        _id: 0
    },
    expectedOutput,
    expectedStages,
    stagesNotExpected
}) {
    const cmdObj = {find: coll.getName(), filter: filter, projection: projection};
    if (expectedOutput) {
        const res = assert.commandWorked(coll.runCommand(cmdObj));
        const ouputArray = new DBCommandCursor(coll.getDB(), res).toArray();

        // We ignore the order since hashed index order is not predictable.
        assert(arrayEq(expectedOutput, ouputArray), ouputArray);
    }

    assertStagesForExplainOfCommand({
        coll: coll,
        cmdObj: cmdObj,
        expectedStages: expectedStages,
        stagesNotExpected: stagesNotExpected
    });
}

/**
 * Tests when hashed field is a prefix.
 */
assert.commandWorked(coll.createIndex({a: "hashed", b: 1}));

// Verify that sub-queries of $or opertor can use index.
validateFindCmdOutputAndPlan({
    filter: {$or: [{a: null}, {a: 12, b: 12}]},
    expectedOutput: [{a: null, b: 12}, {a: null}, {a: 12, b: 12}, {b: 12}, {}],
    expectedStages: ["OR"],
    stagesNotExpected: ["COLLSCAN"]
});

// Verify that query cannot use index for $exists=true (which internally generate a $not query)
// query.
validateFindCmdOutputAndPlan({
    filter: {a: {$exists: true}, b: 12},
    expectedOutput: [{a: 12, b: 12}, {a: null, b: 12}],
    expectedStages: ["COLLSCAN"]
});

// Verify that query can use index for matching 'null'.
validateFindCmdOutputAndPlan({
    filter: {a: null, b: 12},
    expectedOutput: [{b: 12}, {a: null, b: 12}],
    expectedStages: ["FETCH", "IXSCAN"]
});

// Verify that query cannot use index for $not queries on hashed field.
validateFindCmdOutputAndPlan({filter: {a: {$not: {$eq: 12}}, b: 12}, expectedStages: ["COLLSCAN"]});

// Currently $exists:false predicates cannot use a hashed index.
// TODO SERVER-44011: Allow $exists:false predicates to use a hashed index.
validateFindCmdOutputAndPlan({filter: {a: {$exists: false}, b: 12}, expectedStages: ["COLLSCAN"]});

/**
 * Tests when hashed field is not a prefix.
 */
assert.commandWorked(coll.dropIndexes());
assert.commandWorked(coll.createIndex({a: 1, b: "hashed", c: -1}));

// Verify that sub-queries of $or opertor can use index. The first element of $or should not require
// a FETCH.
validateFindCmdOutputAndPlan({
    filter: {$or: [{a: 1}, {a: 12, b: 12}]},
    projection: {a: 1, c: 1, _id: 0},
    expectedOutput: [{a: 12}],
    expectedStages: ["OR", "FETCH"],
    stagesNotExpected: ["COLLSCAN"],
});

// Verify that can use index for $exists:true query and differentiate null from missing.
validateFindCmdOutputAndPlan({
    filter: {a: {$exists: true}, b: 12},
    expectedOutput: [{a: 12, b: 12}, {a: null, b: 12}],
    expectedStages: ["FETCH", "IXSCAN"]
});

// Verify that query can use index for matching 'null' on non-hashed prefixes.
validateFindCmdOutputAndPlan({
    filter: {a: null, b: 12},
    expectedOutput: [{b: 12}, {a: null, b: 12}],
    expectedStages: ["FETCH", "IXSCAN"]
});

// Verify that query can use index for matching 'null' on hashed field.
validateFindCmdOutputAndPlan(
    {filter: {a: 12, b: null}, expectedOutput: [], expectedStages: ["FETCH", "IXSCAN"]});

// Currently $not queries on non-hashed prefixes cannot use a hashed index.
// TODO SERVER-44011: Allow $not queries on non-hashed prefixes to use index.
validateFindCmdOutputAndPlan({filter: {a: {$not: {$gt: 12}}, b: 12}, expectedStages: ["COLLSCAN"]});
validateFindCmdOutputAndPlan({filter: {a: {$exists: false}, b: 12}, expectedStages: ["COLLSCAN"]});
})();
