const test = require('node:test');
const assert = require('node:assert/strict');
test('local configuration is complete', () => {
  const app = require('../index');

  assert.equal(app.pulseConfig.envOk, true);
  assert.deepEqual(app.pulseConfig.configurationIssues, []);
});
