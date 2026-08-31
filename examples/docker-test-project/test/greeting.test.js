'use strict';

const assert = require('node:assert/strict');
const { greet } = require('../src/greeting.js');

assert.equal(greet('Docker'), 'Hello, Docker!');
console.log('Example project test passed.');
