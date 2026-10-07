const test = require('node:test');
const assert = require('node:assert/strict');

function storage() {
  return {
    data: Object.create(null),
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; }
  };
}

function loadStore(local, plugin) {
  global.localStorage = local;
  global.WpsNativeDocument = {
    getPluginStorage() { return plugin || null; }
  };
  delete require.cache[require.resolve('../js/settings-store.js')];
  return require('../js/settings-store.js');
}

test('OpenCode selected model survives a full task-pane reload', () => {
  const local = storage();
  let plugin = storage();
  let store = loadStore(local, plugin);
  store.updateSettings({ provider: 'opencode', profile: { endpoint: 'http://127.0.0.1:4096', model: 'openai/gpt-5.6' } });

  plugin = storage(); // PluginStorage is session-only and starts empty after WPS restart.
  store = loadStore(local, plugin);
  const settings = store.loadSettings();

  assert.equal(settings.provider, 'opencode');
  assert.equal(settings.profiles.opencode.model, 'openai/gpt-5.6');
  assert.equal(settings.profiles.opencode.endpoint, 'http://127.0.0.1:4096');
});

test('custom OpenAI-compatible endpoint, model and API key survive reload', () => {
  const local = storage();
  let store = loadStore(local, storage());
  store.updateSettings({
    provider: 'openai',
    profile: {
      endpoint: 'https://models.example/v1/chat/completions',
      model: 'deepseek-chat'
    }
  });
  assert.equal(store.savePassword('sk-local-persisted', 'openai'), true);

  store = loadStore(local, storage());
  const settings = store.loadSettings();
  assert.equal(settings.provider, 'openai');
  assert.equal(settings.profiles.openai.endpoint, 'https://models.example/v1/chat/completions');
  assert.equal(settings.profiles.openai.model, 'deepseek-chat');
  assert.equal(store.loadPassword('openai'), 'sk-local-persisted');
});

test('durable localStorage wins over stale PluginStorage and writes mirror to both', () => {
  const local = storage();
  const plugin = storage();
  local.setItem('wps_text_proofreading_model_settings_v1', JSON.stringify({
    provider: 'opencode',
    profiles: { opencode: { endpoint: 'http://127.0.0.1:4096', model: 'provider/new' } }
  }));
  plugin.setItem('wps_text_proofreading_model_settings_v1', JSON.stringify({
    provider: 'opencode',
    profiles: { opencode: { endpoint: 'http://127.0.0.1:4096', model: 'provider/stale' } }
  }));

  const store = loadStore(local, plugin);
  assert.equal(store.loadSettings().profiles.opencode.model, 'provider/new');

  store.updateSettings({ provider: 'opencode', profile: { model: 'provider/final' } });
  assert.equal(JSON.parse(local.getItem(store.SETTINGS_KEY)).profiles.opencode.model, 'provider/final');
  assert.equal(JSON.parse(plugin.getItem(store.SETTINGS_KEY)).profiles.opencode.model, 'provider/final');
});

test('PluginStorage-only legacy settings migrate into durable localStorage', () => {
  const local = storage();
  const plugin = storage();
  plugin.setItem('wps_text_proofreading_model_settings_v1', JSON.stringify({
    provider: 'openai',
    profiles: { openai: { endpoint: 'https://api.example/v1', model: 'm1' } }
  }));
  const store = loadStore(local, plugin);
  assert.equal(store.loadSettings().profiles.openai.model, 'm1');
  assert.ok(local.getItem(store.SETTINGS_KEY));
});

test('credential-bearing URLs are still rejected as endpoints', () => {
  const local = storage();
  const store = loadStore(local, storage());
  store.updateSettings({ provider: 'openai', profile: { endpoint: 'https://api.example/v1', model: 'm1' } });
  store.updateSettings({ provider: 'openai', profile: { endpoint: 'https://user:pass@example.com/v1' } });
  assert.equal(store.loadSettings().profiles.openai.endpoint, 'https://api.example/v1');
});
