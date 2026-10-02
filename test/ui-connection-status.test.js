const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function field() {
  const node = { value: '', checked: false, hidden: false, disabled: false,
    textContent: '', className: '', options: [{ value: '' }], attributes: {}, listeners: {} };
  node.addEventListener = (type, handler) => { (node.listeners[type] ||= []).push(handler); };
  node.fire = (type) => (node.listeners[type] || []).forEach((handler) => handler({ stopPropagation() {} }));
  node.appendChild = (child) => node.options.push(child);
  node.remove = (index) => node.options.splice(index, 1);
  node.setAttribute = (name, value) => { node.attributes[name] = value; };
  node.getAttribute = (name) => node.attributes[name];
  return node;
}

function harness(options = {}) {
  const elements = {};
  ['model-provider', 'model-endpoint', 'model-name', 'model-suggestions', 'model-api-key',
    'model-api-key-row', 'model-endpoint-label', 'model-name-label', 'model-api-key-label',
    'provider-help', 'opencode-start-guide', 'opencode-service-state', 'opencode-service-message',
    'opencode-retry', 'opencode-install-help', 'opencode-details', 'opencode-guide-toggle',
    'opencode-guide-content', 'refresh-models', 'model-summary', 'connection-status', 'model-detection-result']
    .forEach((id) => { elements[id] = field(); });
  elements['opencode-guide-content'].hidden = true;
  const storage = new Map();
  const ready = [];
  const intervals = [];
  const win = {
    localStorage: { getItem: (key) => storage.get(key) || '', setItem: (key, value) => storage.set(key, value) },
    document: { readyState: 'loading', getElementById: (id) => elements[id] || null,
      createElement: field, addEventListener: (type, handler) => { if (type === 'DOMContentLoaded') ready.push(handler); } },
    setInterval: (callback, delay) => { assert.equal(delay, 1000); intervals.push(callback); },
    WpsModelCatalog: { detect: async (options) => ({ provider: options.provider,
      models: ['demo/model'], defaultModel: 'demo/model', detail: options.provider + ' 已连接' }) }
  };
  if (options.nativeFetch) {
    win.location = { origin: 'http://127.0.0.1:3891' };
    win.fetch = options.nativeFetch;
  }
  const context = vm.createContext({ window: win, URL, setTimeout, clearTimeout });
  ['settings-store.js', 'proofreading-integration.js', 'taskpane.js'].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file });
  });
  win.document.readyState = 'complete';
  ready.forEach((callback) => callback());
  return { win, elements, storage, tick: () => intervals.forEach((callback) => callback()),
    change(id, value) { elements[id].value = value; elements[id].fire('change'); } };
}

function nativeResponse(state, version = '') {
  return { ok: true, async json() { return { state, found: state !== 'missing', version, managed: state === 'ready' }; } };
}

test('OpenCode selection starts a stopped service and then enumerates models', async () => {
  const calls = [];
  const h = harness({ nativeFetch: async (url, init) => {
    calls.push(init.method + ' ' + url);
    return nativeResponse(init.method === 'GET' ? 'stopped' : 'ready', '1.18.32');
  } });
  await new Promise(setImmediate);
  assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['GET', 'POST']);
  assert.match(h.elements['connection-status'].textContent, /OpenCode 1\.18\.32 · 已发现 1 个模型/);
  assert.equal(h.elements['opencode-retry'].hidden, true);
});

test('an older local server without the manager API still connects directly to OpenCode', async () => {
  for (const nativeFetch of [async () => ({ ok: false, status: 400 }), async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } })]) {
    const h = harness({ nativeFetch });
    await new Promise(setImmediate);
    assert.equal(h.win.getModelConnectionState().detected, true);
    assert.equal(h.elements['opencode-retry'].hidden, true);
    assert.doesNotMatch(h.elements['connection-status'].textContent, /管理服务暂时不可用/);
  }
});

test('using OpenCode after its service stopped starts it again before a model request', async () => {
  let stopped = false;
  const calls = [];
  const h = harness({ nativeFetch: async (_, init) => {
    calls.push(init.method);
    if (init.method === 'POST') stopped = false;
    return nativeResponse(stopped ? 'stopped' : 'ready');
  } });
  await new Promise(setImmediate);
  stopped = true;
  await h.win.ensureOpenCodeConnection({ provider: 'opencode', endpoint: 'http://127.0.0.1:4096', apiKey: '' });
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
});

test('OpenCode manager reports missing install, startup failure, and 4096 conflict', async () => {
  for (const [state, pattern] of [
    ['missing', /未检测到 OpenCode/],
    ['error', /启动失败/],
    ['port_conflict', /4096 端口被其他程序占用/]
  ]) {
    const calls = [];
    const h = harness({ nativeFetch: async (url, init) => {
      calls.push(init.method);
      return nativeResponse(state);
    } });
    await new Promise(setImmediate);
    assert.match(h.elements['connection-status'].textContent, pattern);
    assert.deepEqual(calls, ['GET']);
  }
});

test('failed automatic start offers retry and troubleshooting without exposing the command by default', async () => {
  const calls = [];
  const h = harness({ nativeFetch: async (url, init) => {
    calls.push(init.method);
    return nativeResponse(init.method === 'GET' ? 'stopped' : 'error');
  } });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['GET', 'POST']);
  assert.match(h.elements['opencode-service-message'].textContent, /启动失败/);
  assert.equal(h.elements['opencode-retry'].hidden, false);
  assert.equal(h.elements['opencode-guide-content'].hidden, true);
  h.elements['opencode-details'].fire('click');
  assert.equal(h.elements['opencode-guide-content'].hidden, false);
  h.elements['opencode-retry'].fire('click');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'POST']);
});

test('switching away from OpenCode makes an old native start result stale', async () => {
  let finish;
  const h = harness({ nativeFetch: async (url, init) => {
    if (init.method === 'GET') return nativeResponse('stopped');
    return new Promise((resolve) => { finish = () => resolve(nativeResponse('ready', 'old')); });
  } });
  await new Promise(setImmediate);
  assert.match(h.elements['connection-status'].textContent, /正在启动 OpenCode/);
  h.change('model-provider', 'ollama');
  finish();
  await new Promise(setImmediate);
  assert.equal(h.win.getModelConnectionState().provider, 'ollama');
  assert.doesNotMatch(h.elements['connection-status'].textContent, /OpenCode old|已发现/);
});

test('native startup failure includes its actionable detail as plain text', async () => {
  const h = harness({ nativeFetch: async (url, init) => ({ ok: true, async json() {
    return init.method === 'GET' ? { state: 'stopped', found: true } : {
      state: 'error', found: true, errorCode: 'process_exited',
      detail: 'OpenCode 启动进程已提前退出，请查看本机启动日志。'
    };
  } }) });
  await new Promise(setImmediate);
  assert.match(h.elements['opencode-service-message'].textContent, /启动失败.*提前退出/);
  assert.equal(h.elements['opencode-retry'].hidden, false);
});

test('OpenCode troubleshooting stays folded until requested and other providers do not start it', async () => {
  const calls = [];
  const h = harness({ nativeFetch: async (url, init) => {
    calls.push(init.method);
    return nativeResponse('ready', '1.18.32');
  } });
  await new Promise(setImmediate);
  assert.equal(h.elements['opencode-guide-content'].hidden, true);
  h.elements['opencode-guide-toggle'].fire('click');
  assert.equal(h.elements['opencode-guide-content'].hidden, false);
  h.change('model-provider', 'ollama');
  await h.win.refreshProviderModels();
  assert.deepEqual(calls, ['GET']);
});

test('session-only OpenCode password keeps the existing authenticated model detection path', async () => {
  const calls = [];
  const h = harness({ nativeFetch: async (url, init) => {
    calls.push(init.method);
    return nativeResponse('port_conflict');
  } });
  await new Promise(setImmediate);
  h.change('model-api-key', 'session-only');
  await h.win.refreshProviderModels();
  assert.deepEqual(calls, ['GET']);
  assert.equal(h.win.getModelConnectionState().detected, true);
  assert.equal(JSON.stringify([...h.storage.values()]).includes('session-only'), false);
});

function assertRequiresDetection(h) {
  h.tick();
  h.tick();
  assert.equal(h.win.getModelConnectionState().detected, false);
  assert.equal(h.elements['connection-status'].className, 'connection-status connection-status-idle');
  assert.match(h.elements['connection-status'].textContent, /需重新检测/);
  assert.doesNotMatch(h.elements['model-detection-result'].className, /is-success/);
}

test('provider, endpoint and password edits remain unverified across polling until fresh detection succeeds', async () => {
  const h = harness();
  assert.equal(h.elements['opencode-start-guide'].hidden, false);
  assert.match(h.elements['model-summary'].textContent, /^当前设置：OpenCode/);
  await h.win.refreshProviderModels();
  assert.equal(h.elements['connection-status'].className, 'connection-status connection-status-success');
  assert.equal(h.elements['model-detection-result'].textContent, '已读取 1 个模型');

  h.change('model-provider', 'ollama');
  assert.equal(h.elements['opencode-start-guide'].hidden, true);
  assertRequiresDetection(h);
  assert.doesNotMatch(h.elements['connection-status'].textContent, /opencode 已连接/);
  await h.win.refreshProviderModels();
  assert.equal(h.win.getModelConnectionState().provider, 'ollama');
  assert.equal(h.win.getModelConnectionState().detected, true);

  h.change('model-endpoint', 'http://127.0.0.1:11435');
  assertRequiresDetection(h);
  await h.win.refreshProviderModels();
  assert.equal(h.win.getModelConnectionState().detected, true);

  h.change('model-provider', 'opencode');
  assert.equal(h.elements['opencode-start-guide'].hidden, false);
  await h.win.refreshProviderModels();
  h.change('model-api-key', 'test-only-password');
  assertRequiresDetection(h);
  assert.equal(h.win.WpsSettingsStore.loadPassword('opencode'), 'test-only-password');
  assert.equal(JSON.stringify([...h.storage.values()]).includes('test-only-password'), false);
  assert.equal(JSON.stringify(h.win.getModelConnectionState()).includes('test-only-password'), false);
  await h.win.refreshProviderModels();
  assert.equal(h.win.getModelConnectionState().detected, true);
});

test('cached catalogs never assert a live connection on reload or mismatch; non-connection settings keep verified state', async () => {
  const h = harness();
  h.win.WpsSettingsStore.saveCatalog({ provider: 'ollama', models: ['cached'], tone: 'success', detail: '旧连接' });
  h.tick();
  assert.equal(h.win.getModelConnectionState().detected, false);
  assert.doesNotMatch(h.elements['connection-status'].className, /success/);
  assert.doesNotMatch(h.elements['connection-status'].textContent, /旧连接/);
  await h.win.refreshProviderModels();
  h.win.WpsSettingsStore.updateSettings({ deep: true, autoAdvance: false });
  h.tick();
  assert.equal(h.win.getModelConnectionState().detected, true);
  h.win.WpsSettingsStore.savePassword('programmatic-test', 'opencode');
  assertRequiresDetection(h); // Credential changes must also be observed outside form events.
});

test('late success and failure cannot restore a changed configuration or overwrite a newer detection', async () => {
  for (const change of [
    (h) => h.change('model-provider', 'ollama'),
    (h) => h.change('model-endpoint', 'http://127.0.0.1:4097'),
    (h) => h.change('model-api-key', 'changed-test-password')
  ]) {
    const h = harness();
    let finish;
    h.win.WpsModelCatalog.detect = (options) => new Promise((resolve) => {
      finish = () => resolve({ provider: options.provider, models: ['old/model'], defaultModel: 'old/model' });
    });
    const pending = h.win.refreshProviderModels();
    change(h);
    finish();
    assert.equal((await pending).stale, true);
    assertRequiresDetection(h);
    assert.equal(h.win.WpsSettingsStore.loadCatalog(), null);
    const settings = h.win.WpsSettingsStore.loadSettings() || h.win.WpsSettingsStore.defaultSettings();
    assert.notEqual(settings.profiles.opencode.model, 'old/model');
  }
  const h = harness();
  let rejectOld;
  h.win.WpsModelCatalog.detect = () => new Promise((resolve, reject) => { rejectOld = reject; });
  const older = h.win.refreshProviderModels();
  h.win.WpsModelCatalog.detect = async () => ({ provider: 'opencode', models: ['new/model'], defaultModel: 'new/model' });
  await h.win.refreshProviderModels();
  rejectOld(new Error('obsolete failure'));
  assert.equal((await older).stale, true);
  assert.equal(h.win.getModelConnectionState().detected, true);
  assert.equal(h.win.WpsSettingsStore.loadCatalog().models[0], 'new/model');
});

test('failed detection and empty model lists remain error or warning across unrelated store changes', async () => {
  const h = harness();
  await h.win.refreshProviderModels();
  h.win.WpsModelCatalog.detect = async () => { throw new Error('expected failure'); };
  assert.equal((await h.win.refreshProviderModels()).error, true);
  h.win.WpsSettingsStore.updateSettings({ deep: true });
  h.tick();
  assert.equal(h.win.getModelConnectionState().tone, 'error');
  assert.match(h.elements['model-detection-result'].textContent, /缓存 1 个模型；本次检测失败/);
  h.win.WpsModelCatalog.detect = async () => ({ provider: 'opencode', models: [], defaultModel: '' });
  await h.win.refreshProviderModels();
  h.win.WpsSettingsStore.updateSettings({ deep: false });
  h.tick();
  assert.equal(h.win.getModelConnectionState().tone, 'warning');
  assert.equal(h.win.getModelConnectionState().detected, false);
});

test('configuration observation in a form getter or late response cannot consume the pending connection repaint', async () => {
  const h = harness();
  await h.win.refreshProviderModels();
  h.win.WpsSettingsStore.savePassword('external-change', 'opencode');
  h.win.syncSettingsForm(); // Getter notices the secret-only change before the poll does.
  assertRequiresDetection(h);
  let finish;
  h.win.WpsModelCatalog.detect = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.win.refreshProviderModels();
  h.win.WpsSettingsStore.savePassword('external-change-again', 'opencode');
  finish({ provider: 'opencode', models: ['obsolete'], defaultModel: 'obsolete' });
  assert.equal((await pending).stale, true);
  assertRequiresDetection(h);
});

test('document session swaps preserve shared provider, model, password, settings and verified connection', async () => {
  const h = harness();
  const a = { FullName: '/private/A.docx' };
  const b = { Name: '文档2' };
  h.win.WpsNativeDocument = { getApplication: () => application };
  const application = { ActiveDocument: a };
  h.tick();
  h.change('model-provider', 'openai');
  h.change('model-api-key', 'document-switch-session-secret');
  h.win.WpsSettingsStore.updateSettings({ deep: true, autoAdvance: false });
  await h.win.refreshProviderModels();
  const settings = JSON.stringify(h.win.WpsSettingsStore.loadSettings());
  const connection = JSON.stringify(h.win.getModelConnectionState());
  const connectionText = h.elements['connection-status'].textContent;
  const key = h.win.WpsSettingsStore.loadPassword('openai');
  assert.equal(key, 'document-switch-session-secret');
  for (const document of [b, a, b, null, a]) {
    application.ActiveDocument = document;
    h.tick();
    assert.equal(JSON.stringify(h.win.WpsSettingsStore.loadSettings()), settings);
    assert.equal(JSON.stringify(h.win.getModelConnectionState()), connection);
    assert.equal(h.elements['connection-status'].textContent, connectionText);
    assert.equal(h.win.WpsSettingsStore.loadPassword('openai'), key);
  }
  assert.equal(JSON.stringify([...h.storage.values()]).includes('/private/A.docx'), false);
});
