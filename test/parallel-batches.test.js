const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/proofreading-core.js');
const turn = () => new Promise(setImmediate);
const limited = () => Object.assign(new Error('limited'), { code: 'MODEL_RATE_LIMITED' });

test('several simultaneous 429 errors at concurrency three or four each retry once in order', async () => {
  for (const concurrency of [3, 4]) {
    const calls = [], items = Array.from({ length: 8 }, (_, index) => index);
    const results = await core.scheduleBatches(items, concurrency, (value, index, attempt, limit) => {
      calls.push([index, attempt, limit]);
      if (index < concurrency && attempt === 1) throw limited();
      return value;
    });
    assert.deepEqual(results, items);
    assert.deepEqual(calls.filter(call => call[1] === 2),
      Array.from({ length: concurrency }, (_, index) => [index, 2, 1]));
    assert.ok(calls.slice(concurrency).every(call => call[2] === 1));
    assert.equal(calls.length, items.length + concurrency);
  }
});

test('batch pool bounds concurrency, returns input order and handles empty input', async () => {
  for (const concurrency of [undefined, 0, 1, 2, 3, 4, 5, 1.5, '2']) {
    let active = 0, peak = 0;
    const items = Array.from({ length: 8 }, (_, index) => index);
    const result = await core.scheduleBatches(items, concurrency, async value => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, value % 2 ? 1 : 15));
      active--; return value;
    });
    assert.equal(peak, Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4 ? concurrency : 1);
    assert.deepEqual(result, items);
  }
  assert.deepEqual(await core.scheduleBatches([], 2, () => assert.fail('empty')), []);
});

test('batch pool cancellation stops queued work and ignores late completion', async () => {
  for (const concurrency of [2, 3, 4]) {
    const controller = new AbortController(), gates = [], started = [];
    const pending = core.scheduleBatches(Array.from({ length: 8 }, (_, index) => index), concurrency, value => {
      started.push(value); return new Promise(resolve => gates.push(resolve));
    }, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await turn(); controller.abort(); await rejected;
    gates.forEach(resolve => resolve()); await turn();
    assert.deepEqual(started, Array.from({ length: concurrency }, (_, index) => index));
    await assert.rejects(core.scheduleBatches([0], 2, () => assert.fail('cancelled'), controller.signal),
      { name: 'AbortError' });
  }
});

test('batch pool propagates the original failure and stops queued work', async () => {
  for (const concurrency of [2, 3, 4]) {
    const failure = new Error('failed'), started = [], gates = [];
    let notified;
    const pending = core.scheduleBatches(Array.from({ length: 8 }, (_, index) => index), concurrency, value => {
      started.push(value);
      if (!value) throw failure;
      return new Promise(resolve => gates.push(resolve));
    }, undefined, error => { notified = error; });
    await assert.rejects(pending, error => error === failure);
    gates.forEach(resolve => resolve()); await turn();
    assert.equal(notified, failure);
    assert.deepEqual(started, Array.from({ length: concurrency }, (_, index) => index));
    await assert.rejects(core.scheduleBatches([0], 1, () => { throw failure; }, undefined,
      () => { throw new Error('cleanup hook failed'); }), error => error === failure);
  }
});

test('429 drains in-flight work then retries once and stays serial for the run', async () => {
  for (const concurrency of [2, 3, 4]) {
    const calls = [], gates = [];
    const items = Array.from({ length: concurrency + 2 }, (_, index) => index);
    const pending = core.scheduleBatches(items, concurrency, (value, index, attempt, limit) => {
      calls.push([index, attempt, limit]);
      if (!index && attempt === 1) throw limited();
      if (index > 0 && index < concurrency) return new Promise(resolve => gates.push(() => resolve(value)));
      return value;
    });
    await turn();
    assert.deepEqual(calls, Array.from({ length: concurrency }, (_, index) => [index, 1, concurrency]));
    for (let index = 0; index < gates.length - 1; index++) {
      gates[index](); await turn(); assert.equal(calls.length, concurrency);
    }
    gates.at(-1)(); assert.deepEqual(await pending, items);
    assert.deepEqual(calls.slice(concurrency), [[0, 2, 1], [concurrency, 1, 1], [concurrency + 1, 1, 1]]);
    let attempts = 0;
    await assert.rejects(core.scheduleBatches(items, concurrency, () => { attempts++; throw limited(); }),
      { code: 'MODEL_RATE_LIMITED' });
    assert.equal(attempts, concurrency + 1, 'initial attempts and one retry before terminal failure');
  }
});

test('cancellation while a 429 retry is queued prevents the retry', async () => {
  for (const concurrency of [2, 3, 4]) {
    const controller = new AbortController(), calls = [], gates = [];
    const pending = core.scheduleBatches(Array.from({ length: 8 }, (_, index) => index), concurrency, value => {
      calls.push(value);
      if (!value) throw limited();
      return new Promise(resolve => gates.push(resolve));
    }, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await turn(); controller.abort(); await rejected;
    gates.forEach(resolve => resolve()); await turn();
    assert.deepEqual(calls, Array.from({ length: concurrency }, (_, index) => index));
  }
});
