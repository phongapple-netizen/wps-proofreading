const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/proofreading-core.js');
const turn = () => new Promise(setImmediate);
const limited = () => Object.assign(new Error('limited'), { code: 'MODEL_RATE_LIMITED' });

test('batch pool bounds concurrency, returns input order and handles empty input', async () => {
  for (const concurrency of [undefined, 0, 1, 2, 4, '2']) {
    let active = 0, peak = 0;
    const result = await core.scheduleBatches([0, 1, 2, 3], concurrency, async value => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, value % 2 ? 1 : 15));
      active--; return value;
    });
    assert.equal(peak, concurrency === 2 ? 2 : 1);
    assert.deepEqual(result, [0, 1, 2, 3]);
  }
  assert.deepEqual(await core.scheduleBatches([], 2, () => assert.fail('empty')), []);
});

test('batch pool cancellation stops queued work and ignores late completion', async () => {
  const controller = new AbortController(), gates = [], started = [];
  const pending = core.scheduleBatches([0, 1, 2, 3], 2, value => {
    started.push(value); return new Promise(resolve => gates.push(resolve));
  }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); controller.abort(); await rejected;
  gates.forEach(resolve => resolve()); await turn();
  assert.deepEqual(started, [0, 1]);
  await assert.rejects(core.scheduleBatches([0], 2, () => assert.fail('cancelled'), controller.signal),
    { name: 'AbortError' });
});

test('batch pool propagates the original failure and stops queued work', async () => {
  const failure = new Error('failed'), started = [], gates = [];
  let notified;
  const pending = core.scheduleBatches([0, 1, 2], 2, value => {
    started.push(value);
    if (!value) throw failure;
    return new Promise(resolve => gates.push(resolve));
  }, undefined, error => { notified = error; });
  await assert.rejects(pending, error => error === failure);
  gates.forEach(resolve => resolve()); await turn();
  assert.equal(notified, failure); assert.deepEqual(started, [0, 1]);
  await assert.rejects(core.scheduleBatches([0], 1, () => { throw failure; }, undefined,
    () => { throw new Error('cleanup hook failed'); }), error => error === failure);
});

test('429 drains in-flight work then retries once and stays serial for the run', async () => {
  const calls = [], gates = [];
  const pending = core.scheduleBatches([0, 1, 2, 3], 2, (value, index, attempt, limit) => {
    calls.push([index, attempt, limit]);
    if (!index && attempt === 1) throw limited();
    if (index === 1) return new Promise(resolve => gates.push(() => resolve(value)));
    return value;
  });
  await turn(); assert.deepEqual(calls, [[0, 1, 2], [1, 1, 2]]);
  gates[0](); assert.deepEqual(await pending, [0, 1, 2, 3]);
  assert.deepEqual(calls.slice(2), [[0, 2, 1], [2, 1, 1], [3, 1, 1]]);
  let attempts = 0;
  await assert.rejects(core.scheduleBatches([0, 1], 2, () => { attempts++; throw limited(); }),
    { code: 'MODEL_RATE_LIMITED' });
  assert.equal(attempts, 3, 'two initial attempts and one retry before terminal failure');
});

test('cancellation while a 429 retry is queued prevents the retry', async () => {
  const controller = new AbortController(), calls = [], gates = [];
  const pending = core.scheduleBatches([0, 1, 2], 2, value => {
    calls.push(value);
    if (!value) throw limited();
    return new Promise(resolve => gates.push(resolve));
  }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); controller.abort(); await rejected;
  gates[0](); await turn(); assert.deepEqual(calls, [0, 1]);
});
