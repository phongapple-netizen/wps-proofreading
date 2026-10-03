const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture() {
  const storage = new Map(), window = { localStorage: {
    getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value)
  } };
  const context = vm.createContext({ window, URL });
  for (const file of ['settings-store.js', 'proofreading-timing.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context);
  }
  return { window, storage, timing: window.WpsProofreadingTiming, settings: window.WpsSettingsStore };
}

test('performance settings default to two requests and logging off; older settings migrate safely', () => {
  const { settings, storage } = fixture();
  assert.equal(settings.defaultSettings().concurrency, 2);
  assert.equal(settings.defaultSettings().timingLogs, false);
  storage.set(settings.SETTINGS_KEY, JSON.stringify({ provider: 'ollama', deep: true }));
  assert.equal(settings.loadSettings().concurrency, 2);
  assert.equal(settings.loadSettings().timingLogs, false);
  settings.updateSettings({ concurrency: 1, timingLogs: true });
  settings.updateSettings({ deep: false });
  assert.equal(settings.loadSettings().concurrency, 1);
  assert.equal(settings.loadSettings().timingLogs, true);
  for (const invalid of [0, 4, '1', -1, null]) {
    settings.saveSettings({ concurrency: invalid, timingLogs: 'true' });
    assert.equal(settings.loadSettings().concurrency, 2);
    assert.equal(settings.loadSettings().timingLogs, false);
  }
});

test('timing is opt-in, whitelists numeric fields and never writes records to storage', () => {
  const { timing, storage } = fixture();
  const initialStorage = Array.from(storage);
  assert.equal(timing.start({ kind: 1 }), null);
  timing.setEnabled(true);
  const token = timing.start({ kind: 1, run: 1, characters: 25,
    prompt: 'private body', password: 'secret', endpoint: 'private URL' });
  timing.finish(token, { createSessionMs: 2, messageMs: 3, cleanupMs: 4, pollCount: 1,
    pollMs: 1, error: 'private error', response: 'private response', batch: 'private string' });
  const entries = timing.entries();
  assert.equal(entries.length, 1);
  assert.ok(Object.values(entries[0]).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.doesNotMatch(JSON.stringify(entries), /private|secret/);
  assert.deepEqual(Array.from(storage), initialStorage);
  entries[0].characters = 999;
  assert.equal(timing.entries()[0].characters, 25);
  timing.finish(token, {}); assert.equal(timing.entries().length, 1);
});

test('timing memory is bounded and clearing or disabling suppresses in-flight tokens', () => {
  const { timing } = fixture(); timing.setEnabled(true);
  for (let batch = 0; batch < timing.maxRecords + 5; batch++) timing.finish(timing.start({ kind: 2, batch }));
  assert.equal(timing.entries().length, timing.maxRecords);
  assert.equal(timing.entries()[0].batch, 5);
  const stale = timing.start({ kind: 1 }); timing.clear(); timing.finish(stale);
  assert.equal(timing.entries().length, 0);
  const disabled = timing.start({ kind: 1 }); timing.setEnabled(false); timing.setEnabled(true);
  timing.finish(disabled); assert.equal(timing.entries().length, 0);
});
