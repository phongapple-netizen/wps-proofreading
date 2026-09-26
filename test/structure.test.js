const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function loadBrowserScript(relativePath, windowObject) {
  const context = vm.createContext({
    window: windowObject,
    console,
    URL,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(read(relativePath), context, { filename: relativePath });
  return windowObject;
}

test('WPS root files and ribbon callbacks are present', () => {
  const ribbon = read('ribbon.xml');
  assert.ok(ribbon.startsWith('<customUI '));
  assert.match(ribbon, /onLoad="OnAddinLoad"/);
  assert.match(ribbon, /onAction="OnAction"/);
  assert.match(ribbon, /wpsProofreadingOpenPanel/);
  assert.equal(/wordOllama/i.test(ribbon), false);
  assert.match(read('main.js'), /js\/ribbon\.js/);
  assert.equal(/settings-store|model-catalog/.test(read('main.js')), false);
  assert.match(read('package.json'), /"addonType":\s*"wps"/);

  const ribbonJs = read('js/ribbon.js');
  assert.equal(/OnProviderChanged|OnModelItemCount|runModelDetection/.test(ribbonJs), false);
  assert.equal(/wordOllama/i.test(ribbonJs), false);
});

test('provenance and upstream notices are retained without changing the current license boundary', () => {
  const provenance = read('SOURCE_PROVENANCE.md');
  const notices = read('THIRD_PARTY_NOTICES.md');

  assert.match(provenance, /228ceeb7cef20935757de05637c7c0d16ba6011d/);
  assert.match(provenance, /6780afe059d134e1f65e2b256fde41223bdf2e9f/);
  assert.match(provenance, /WPS-AI/);
  assert.match(provenance, /WordOllama Community Edition/);

  assert.match(notices, /GNU GPL v3/);
  assert.match(notices, /Copyright \(c\) 2026 灵犀AI/);
  assert.match(notices, /不代表金山办公官方产品/);
  assert.match(notices, /当前独立仓库采用 GNU GPL v3/);
});

test('document adapter reads and replaces the WPS selection safely', () => {
  const selection = { Text: '原文', Range: { Text: '原文' } };
  const win = { Application: { Selection: selection } };
  loadBrowserScript('js/wps-api.js', win);

  assert.equal(win.WpsNativeDocument.readSelectionText(), '原文');
  assert.equal(win.WpsNativeDocument.replaceSelectionText('修订后'), true);
  assert.equal(selection.Range.Text, '修订后');
});

test('ribbon callback opens one task pane and stores its id', () => {
  let createdUrl = '';
  const storage = new Map();
  const pane = { ID: 'pane-1', Visible: false, DockPosition: null };
  const win = {
    location: { href: 'http://127.0.0.1:3893/index.html' },
    Application: {
      Enum: { msoCTPDockPositionRight: 2 },
      PluginStorage: {
        getItem: (key) => storage.get(key) || '',
        setItem: (key, value) => storage.set(key, value)
      },
      CreateTaskPane: (url) => {
        createdUrl = url;
        return pane;
      },
      GetTaskPane: () => pane
    }
  };
  loadBrowserScript('js/wps-api.js', win);
  loadBrowserScript('js/util.js', win);
  loadBrowserScript('js/ribbon.js', win);

  assert.equal(win.OnAction({ Id: 'wpsProofreadingOpenPanel' }), true);
  assert.equal(createdUrl, 'http://127.0.0.1:3893/ui/taskpane.html');
  assert.equal(storage.get('wps_proofreading_taskpane_id'), 'pane-1');
  assert.equal(pane.Visible, true);
  assert.equal(pane.DockPosition, 2);
});

test('top toolbar and rules center expose the expected controls', () => {
  const html = read('ui/taskpane.html');
  assert.match(html, /<div class="toolbar">/);
  assert.match(html, /<h1 class="toolbar-title">智能校对<\/h1>/);
  assert.match(html, /id="rules-toggle"/);
  assert.match(html, /id="settings-toggle"/);
  assert.match(html, /aria-label="设置" title="设置"/);
  assert.equal(html.slice(0, html.indexOf('<div id="settings-popover"')).includes('id="rules-toggle"'), false);
  assert.match(html, /<div id="settings-popover" class="settings-popover" hidden>/);
  assert.equal(/id="page-header"|id="selection-heading"|id="selected-text"|id="selection-meta"|id="refresh-selection"|<details/.test(html), false);
  assert.equal((html.match(/id="run-proofreading"/g) || []).length, 1);
  assert.equal((html.match(/id="proofreading-progress"/g) || []).length, 1);

  ['deep-enhance', 'model-provider', 'model-endpoint', 'model-name', 'model-suggestions',
    'model-api-key', 'model-api-key-row', 'refresh-models',
    'provider-help', 'model-summary', 'connection-status'].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"'));
  });
  assert.match(html, /id="tab-issues"/);
  assert.match(html, /id="tab-history"/);
  assert.match(html, /id="proofreading-history"/);
  assert.match(html, /id="apply-all"/);
  assert.match(html, /id="rerun-proofreading"/);
  assert.match(html, /id="proofreading-progress"/);
  assert.match(html, /id="progress-fill"/);
  ['rules-center', 'rules-status', 'rules-list', 'rule-new', 'rule-test-document',
    'rule-import', 'rule-export', 'builtin-rule-pack', 'builtin-rule-install',
    'builtin-rule-description', 'rule-editor', 'rule-name', 'rule-group', 'rule-type',
    'rule-pattern', 'rule-match-mode', 'rule-instruction', 'rule-replacement',
    'rule-severity', 'rule-priority', 'rule-auto-fix', 'rule-source', 'rule-notes'].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"'));
  });
  assert.match(html, /js\/rules-center\.js/);
  assert.match(html, /js\/rules-ui\.js/);

  const taskpane = read('js/taskpane.js');
  assert.match(taskpane, /applyAllProofreadingIssues/);
  assert.match(taskpane, /pushProofreadingRecord/);
  assert.match(taskpane, /switchTab/);
  assert.match(taskpane, /setProofreadingProgress/);
  assert.match(taskpane, /syncFormFromStore/);
  assert.match(taskpane, /bindSettingsForm/);
  assert.match(taskpane, /bindSettingsToggle/);
  assert.match(read('js/proofreading-integration.js'), /applyAllProofreadingIssues/);
  assert.match(read('js/proofreading-integration.js'), /batchParagraphs/);
  assert.match(read('js/proofreading-core.js'), /function batchParagraphs/);
  assert.match(read('js/proofreading-core.js'), /function validateDocument/);
  assert.match(read('js/proofreading-integration.js'), /WpsRulesCenter\.evaluate/);
  assert.match(read('js/proofreading-integration.js'), /batchRuleContext/);
  assert.match(read('js/proofreading-integration.js'), /batchAiReviewContext/);
  assert.match(read('js/rules-center.js'), /collectAiReviewCandidates/);
  assert.match(read('js/proofreading-core.js'), /AI核查规则/);
  assert.match(read('js/proofreading-integration.js'), /rule\+ai/);
  assert.match(read('js/proofreading-core.js'), /本地规则上下文/);
  assert.match(read('js/rules-center.js'), /function importPack/);
  assert.match(read('js/rules-center.js'), /function exportPack/);
  assert.match(read('js/rules-ui.js'), /testCurrentDocument/);
  assert.match(read('js/rules-ui.js'), /loadBuiltinCatalog/);
  assert.match(read('js/rules-ui.js'), /installBuiltinPack/);
  assert.match(read('rules/catalog.json'), /chinese-writing-basic\.json/);
  assert.match(read('rules/catalog.json'), /party-government-document\.json/);
  assert.match(read('rules/catalog.json'), /work-safety\.json/);
});

test('settings popover contains a rules accordion and closes on outside click or Escape', () => {
  const ids = ['settings-toggle', 'settings-popover', 'rules-toggle', 'rules-center', 'run-proofreading', 'cancel-proofreading',
    'issue-filter', 'tab-issues', 'tab-history', 'apply-all', 'rerun-proofreading'];
  const elements = {};
  ids.forEach((id) => {
    elements[id] = {
      hidden: id === 'settings-popover' || id === 'rules-center',
      disabled: false,
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      getAttribute: () => null,
      listeners: {},
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
      },
      fire(type, event) {
        (this.listeners[type] || []).forEach((fn) => fn(event || { stopPropagation() {} }));
      }
    };
  });
  elements['settings-popover'].hidden = true;
  const documentListeners = {};
  const win = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ appendChild() {}, setAttribute() {}, addEventListener() {} }),
      addEventListener(type, fn) {
        (documentListeners[type] = documentListeners[type] || []).push(fn);
      },
      fire(type, event) {
        (documentListeners[type] || []).forEach((fn) => fn(event || {}));
      }
    },
    WpsNativeDocument: { readSelectionText: () => '' }
  };
  loadBrowserScript('js/taskpane.js', win);
  loadBrowserScript('js/rules-ui.js', win);

  assert.equal(elements['settings-popover'].hidden, true);
  elements['settings-toggle'].fire('click');
  assert.equal(elements['settings-popover'].hidden, false);
  assert.equal(elements['rules-center'].hidden, true);
  elements['rules-toggle'].fire('click');
  assert.equal(elements['rules-center'].hidden, false);
  assert.equal(elements['settings-popover'].hidden, false);
  elements['rules-toggle'].fire('click');
  assert.equal(elements['rules-center'].hidden, true);
  elements['settings-popover'].fire('click');
  assert.equal(elements['settings-popover'].hidden, false);
  win.document.fire('click');
  assert.equal(elements['settings-popover'].hidden, true);

  elements['settings-toggle'].fire('click');
  assert.equal(elements['settings-popover'].hidden, false);
  win.document.fire('keydown', { key: 'Escape' });
  assert.equal(elements['settings-popover'].hidden, true);
  win.openRulesCenter();
  assert.equal(elements['settings-popover'].hidden, false);
  assert.equal(elements['rules-center'].hidden, false);
  win.closeRulesCenter();
  assert.equal(elements['rules-center'].hidden, true);
  assert.equal(elements['settings-popover'].hidden, false);
});

test('task pane exposes safe integration callbacks without fabricating results', () => {
  const win = {
    document: undefined,
    WpsNativeDocument: { readSelectionText: () => '' }
  };
  loadBrowserScript('js/taskpane.js', win);

  assert.equal(typeof win.runProofreading, 'function');
  assert.equal(typeof win.applyProofreadingIssue, 'function');
  assert.equal(typeof win.setProofreadingStatus, 'function');
  assert.equal(typeof win.setProofreadingProgress, 'function');
  const result = win.runProofreading();
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'integration-not-bound');
  assert.equal(win.getProofreadingStatus().tone, 'warning');
});

test('history records are deduplicated per run id', () => {
  const elements = {};
  const win = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ appendChild() {}, setAttribute() {}, addEventListener() {} })
    }
  };
  loadBrowserScript('js/taskpane.js', win);

  const record = {
    id: 'issue-1',
    action: 'ignored',
    categoryLabel: '错别字',
    original: '错字',
    suggestion: ''
  };
  assert.equal(win.pushProofreadingRecord(Object.assign({ runId: 1 }, record)), true);
  assert.equal(win.pushProofreadingRecord(Object.assign({ runId: 1 }, record)), false);
  assert.equal(win.pushProofreadingRecord(Object.assign({ runId: 2 }, record)), true);
});

test('settings form persists safe settings while provider secrets stay memory-only', () => {
  function makeField(value) {
    return {
      value: value == null ? '' : value,
      checked: false,
      hidden: false,
      disabled: false,
      textContent: '',
      placeholder: '',
      listeners: {},
      options: [{ value: '' }],
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
      },
      fire(type) {
        (this.listeners[type] || []).forEach((fn) => fn());
      },
      remove() {},
      appendChild() {}
    };
  }

  const ids = ['model-provider', 'model-endpoint', 'model-name', 'model-suggestions',
    'model-api-key', 'model-api-key-row', 'model-endpoint-label', 'model-name-label',
    'model-api-key-label', 'provider-help', 'deep-enhance', 'refresh-models',
    'model-summary', 'connection-status', 'selected-text', 'selection-meta'];
  const elements = {};
  ids.forEach((id) => { elements[id] = makeField(); });
  const storage = new Map();
  const win = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      createElement: () => makeField('')
    },
    WpsNativeDocument: {
      getPluginStorage: () => ({
        getItem: (key) => storage.get(key) || '',
        setItem: (key, value) => storage.set(key, value)
      })
    }
  };
  loadBrowserScript('js/settings-store.js', win);
  loadBrowserScript('js/taskpane.js', win);

  assert.equal(elements['model-provider'].value, 'opencode');

  elements['model-provider'].value = 'ollama';
  elements['model-provider'].fire('change');
  assert.equal(win.WpsSettingsStore.loadSettings().provider, 'ollama');
  assert.equal(elements['model-endpoint-label'].textContent, 'Ollama 服务地址');
  assert.equal(elements['model-api-key-row'].hidden, true);

  elements['model-endpoint'].value = 'http://127.0.0.1:11434';
  elements['model-endpoint'].fire('change');
  assert.equal(win.WpsSettingsStore.loadRuntimeEndpoint('ollama').endpoint, 'http://127.0.0.1:11434');
  assert.equal(win.WpsSettingsStore.loadSettings().profiles.ollama.endpoint, 'http://127.0.0.1:11434');

  elements['model-name'].value = 'qwen3:8b';
  elements['model-name'].fire('change');
  assert.equal(win.WpsSettingsStore.loadSettings().profiles.ollama.model, 'qwen3:8b');

  elements['deep-enhance'].checked = true;
  elements['deep-enhance'].fire('change');
  assert.equal(win.WpsSettingsStore.loadSettings().deep, true);

  elements['model-provider'].value = 'opencode';
  elements['model-provider'].fire('change');
  elements['model-api-key'].value = 'session-secret';
  elements['model-api-key'].fire('change');
  assert.equal(win.WpsSettingsStore.loadPassword('opencode'), 'session-secret');
  assert.equal(win.WpsSettingsStore.loadPassword('openai'), '');

  elements['model-provider'].value = 'openai';
  elements['model-provider'].fire('change');
  assert.equal(elements['model-api-key'].value, '');
  elements['model-api-key'].value = 'openai-secret';
  elements['model-api-key'].fire('change');
  assert.equal(win.WpsSettingsStore.loadPassword('openai'), 'openai-secret');
  assert.equal(win.WpsSettingsStore.loadPassword('opencode'), 'session-secret');

  const storedText = Array.from(storage.values()).join('\n');
  assert.equal(storedText.includes('session-secret'), false);
  assert.equal(storedText.includes('openai-secret'), false);
});
