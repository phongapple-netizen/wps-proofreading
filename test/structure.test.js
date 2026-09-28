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

function makeTaskPaneElement(tag) {
  const node = {
    tag: tag || 'div',
    children: [],
    parent: null,
    listeners: {},
    attributes: {},
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    open: false,
    style: {}
  };
  node.appendChild = (child) => {
    child.parent = node;
    node.children.push(child);
    return child;
  };
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.getAttribute = (name) => node.attributes[name] || null;
  node.classList = {
    toggle(name, enabled) {
      const names = node.className.split(/\s+/).filter(Boolean);
      const has = names.includes(name);
      const shouldHave = enabled === undefined ? !has : enabled;
      if (shouldHave && !has) names.push(name);
      if (!shouldHave && has) names.splice(names.indexOf(name), 1);
      node.className = names.join(' ');
    },
    add(name) { this.toggle(name, true); },
    remove(name) { this.toggle(name, false); }
  };
  node.addEventListener = (type, fn) => {
    (node.listeners[type] = node.listeners[type] || []).push(fn);
  };
  node.fire = (type, event) => {
    let stopped = false;
    const value = event || {};
    if (typeof value.stopPropagation !== 'function') value.stopPropagation = () => { stopped = true; };
    const originalStop = value.stopPropagation;
    value.stopPropagation = () => { stopped = true; originalStop(); };
    let current = node;
    while (current && !stopped) {
      (current.listeners[type] || []).forEach((fn) => fn(value));
      current = current.parent;
    }
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._textContent || ''; },
    set(value) { node._textContent = String(value == null ? '' : value); node.children = []; }
  });
  node.focus = () => {};
  return node;
}

function createResultHarness() {
  const ids = ['issue-filter', 'tab-issues', 'tab-history', 'proofreading-issues', 'empty-state',
    'history-empty', 'proofreading-history', 'result-count', 'result-summary', 'result-stale-summary',
    'apply-all', 'rerun-proofreading', 'proofreading-status'];
  const elements = {};
  ids.forEach((id) => { elements[id] = makeTaskPaneElement(id === 'proofreading-issues' ? 'section' : 'div'); });
  elements['issue-filter'].value = 'all';
  const documentListeners = {};
  const calls = [];
  const ruleDrafts = [];
  const win = {
    document: {
      readyState: 'complete',
      activeElement: null,
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeTaskPaneElement(tag),
      addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); }
    },
    locateProofreadingIssue: (id) => { calls.push(['locate', id]); return true; },
    applyProofreadingIssue: (id) => { calls.push(['apply', id]); return true; },
    undoProofreadingIssue: (id) => { calls.push(['undo', id]); return true; },
    ignoreProofreadingIssue: (id) => { calls.push(['ignore', id]); return true; },
    openIssueRuleDraft: (issue) => { ruleDrafts.push(issue); return true; },
    applyAllProofreadingIssues: () => { calls.push(['apply-all']); return true; }
  };
  loadBrowserScript('js/taskpane.js', win);
  return { win, elements, calls, ruleDrafts };
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
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

test('AI issue can open a fixed-rule draft without applying text and shows saved-session feedback', () => {
  const { win, elements, calls, ruleDrafts } = createResultHarness();
  win.setProofreadingIssues([{
    id: 'ai-issue', category: 'wording', origin: 'ai',
    original: '高空作业', suggestion: '高处作业', actionable: true, status: 'pending'
  }]);

  const saveButton = findNode(elements['proofreading-issues'], (node) => node.textContent === '保存为规则');
  assert.ok(saveButton);
  saveButton.fire('click');
  assert.equal(ruleDrafts.length, 1);
  assert.equal(ruleDrafts[0].original, '高空作业');
  assert.equal(ruleDrafts[0].suggestion, '高处作业');
  assert.equal(calls.some((call) => call[0] === 'apply'), false);

  win.markProofreadingIssueRuleSaved('ai-issue');
  const savedButton = findNode(elements['proofreading-issues'], (node) => node.textContent === '已保存规则');
  assert.ok(savedButton);
  assert.equal(savedButton.disabled, true);
  assert.equal(findNode(elements['proofreading-issues'],
    (node) => node.textContent === '已保存为固定替换规则，下次校对时生效。') !== null, true);
});

test('accepted AI issues can save a rule without applying again or changing accepted status', () => {
  const { win, elements, calls, ruleDrafts } = createResultHarness();
  let documentText = '市消防救援支队';
  const apply = win.applyProofreadingIssue;
  win.applyProofreadingIssue = (id) => {
    apply(id);
    documentText = '市消防救援局';
    return true;
  };
  const storage = new Map();
  win.localStorage = {
    getItem: (key) => storage.get(key) || '',
    setItem: (key, value) => storage.set(key, String(value))
  };
  loadBrowserScript('js/rules-center.js', win);
  win.setProofreadingIssues([{
    id: 'accepted-ai', category: 'wording', origin: 'ai',
    original: '市消防救援支队', suggestion: '市消防救援局', status: 'pending'
  }]);

  findNode(elements['proofreading-issues'], (node) => node.textContent === '修正').fire('click');
  assert.deepEqual(calls, [['apply', 'accepted-ai']]);
  win.setProofreadingIssues([{
    id: 'accepted-ai', category: 'wording', origin: 'ai',
    original: '市消防救援支队', suggestion: '市消防救援局', status: 'accepted'
  }]);
  assert.ok(findNode(elements['proofreading-issues'], (node) => node.textContent === '撤销'));
  const save = findNode(elements['proofreading-issues'], (node) => node.textContent === '保存为规则');
  assert.ok(save);
  assert.equal(save.disabled, false);

  save.fire('click');
  assert.equal(ruleDrafts.length, 1);
  const saved = win.WpsRulesCenter.saveUserReplacementRule({
    pattern: ruleDrafts[0].original,
    replacement: ruleDrafts[0].suggestion
  });
  assert.equal(saved.type, 'replace');
  assert.equal(saved.autoFix, false);
  win.markProofreadingIssueRuleSaved('accepted-ai');

  assert.equal(documentText, '市消防救援局');
  assert.deepEqual(calls, [['apply', 'accepted-ai']]);
  assert.ok(findNode(elements['proofreading-issues'], (node) => node.textContent === '撤销'));
  const savedButton = findNode(elements['proofreading-issues'], (node) => node.textContent === '已保存规则');
  assert.ok(savedButton);
  assert.equal(savedButton.disabled, true);
  assert.match(elements['result-summary'].textContent, /已处理 1/);
});

test('ignored and stale issues do not offer save-as-rule', () => {
  const { win, elements } = createResultHarness();
  win.setProofreadingIssues([
    { id: 'ignored-ai', origin: 'ai', original: '甲', suggestion: '乙', status: 'ignored' },
    { id: 'stale-ai', origin: 'ai', original: '丙', suggestion: '丁', status: 'stale' }
  ]);
  assert.equal(findNode(elements['proofreading-issues'],
    (node) => node.textContent === '保存为规则'), null);
});

test('issues already generated by a local fixed rule do not offer save-as-rule again', () => {
  const { win, elements } = createResultHarness();
  win.setProofreadingIssues([{
    id: 'local-rule', category: 'rule', origin: 'rule', ruleType: 'replace',
    original: '旧名称', suggestion: '新名称', actionable: true, status: 'pending'
  }]);
  assert.equal(findNode(elements['proofreading-issues'],
    (node) => node.textContent === '保存为规则'), null);
});

test('manual fixed-rule entry persists only after submit through the existing rules center', () => {
  function field() {
    const node = {
      value: '', textContent: '', hidden: false, disabled: false, checked: false,
      listeners: {}, children: [], className: '', attributes: {}, style: {}
    };
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.fire = (type, event) => (node.listeners[type] || []).forEach((fn) => fn(event || {
      preventDefault() {}, stopPropagation() {}
    }));
    node.appendChild = (child) => { node.children.push(child); return child; };
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    node.getAttribute = (name) => node.attributes[name] || null;
    node.classList = { toggle() {}, add() {}, remove() {} };
    node.focus = () => {};
    node.scrollIntoView = () => {};
    return node;
  }
  const ids = ['rule-new-fixed', 'fixed-rule-editor', 'fixed-rule-cancel',
    'fixed-rule-pattern', 'fixed-rule-replacement', 'fixed-rule-name', 'fixed-rule-notes',
    'fixed-rule-context', 'rules-list', 'rules-empty', 'rules-status'];
  const elements = Object.fromEntries(ids.map((id) => [id, field()]));
  elements['fixed-rule-editor'].hidden = true;
  const storage = new Map();
  const win = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      createElement: () => field()
    },
    localStorage: {
      getItem: (key) => storage.get(key) || '',
      setItem: (key, value) => storage.set(key, String(value))
    }
  };
  loadBrowserScript('js/rules-center.js', win);
  loadBrowserScript('js/rules-ui.js', win);

  elements['rule-new-fixed'].fire('click');
  assert.equal(elements['fixed-rule-editor'].hidden, false);
  elements['fixed-rule-pattern'].value = '市消防救援支队';
  elements['fixed-rule-replacement'].value = '市消防救援局';
  elements['fixed-rule-name'].value = '机构名称规范';
  elements['fixed-rule-notes'].value = '人工确认后建立';
  assert.equal(win.WpsRulesCenter.getRules().length, 0);
  elements['fixed-rule-editor'].fire('submit');

  const saved = win.WpsRulesCenter.getRules()[0];
  assert.equal(saved.pattern, '市消防救援支队');
  assert.equal(saved.replacement, '市消防救援局');
  assert.equal(saved.name, '机构名称规范');
  assert.equal(saved.notes, '人工确认后建立');
  assert.equal(saved.type, 'replace');
  assert.equal(saved.autoFix, false);
  assert.equal(elements['fixed-rule-editor'].hidden, true);
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
  assert.match(html, /id="rule-new-fixed"/);
  assert.equal(html.includes("高级规则编辑"), false);
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
  assert.match(html, /校对建议/);
  assert.match(html, /id="result-summary"/);
  assert.match(html, /id="result-stale-summary"/);
  assert.match(html, /id="proofreading-history"/);
  assert.match(html, /id="apply-all"/);
  assert.match(html, /修正安全格式项（0）/);
  assert.match(html, /仅处理低风险格式规则/);
  assert.match(html, /id="rerun-proofreading"/);
  assert.match(html, /id="proofreading-progress"/);
  assert.match(html, /id="progress-fill"/);
  ['rules-center', 'rules-status', 'rules-list', 'rule-new-fixed',
    'fixed-rule-editor', 'fixed-rule-pattern', 'fixed-rule-replacement', 'fixed-rule-name',
    'fixed-rule-notes', 'rule-test-document',
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
  assert.match(taskpane, /beginProofreadingRun/);
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
  assert.match(read('js/rules-ui.js'), /textContent = "编辑"/);
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

test('full-document pane confirmation waits for actual button clicks and resets between runs', async () => {
  const elements = {};
  const ids = ['full-document-confirmation', 'full-document-confirmation-message', 'confirm-full-document',
    'decline-full-document', 'run-proofreading', 'cancel-proofreading'];
  const listeners = {};
  const doc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };
  ids.forEach((id) => {
    elements[id] = {
      hidden: id === 'full-document-confirmation',
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      fire(type) { (this.listeners[type] || []).forEach((fn) => fn({})); },
      focus() { doc.activeElement = this; }
    };
  });
  const win = { document: doc, confirm() { throw new Error('native confirm must not be used'); } };
  loadBrowserScript('js/taskpane.js', win);
  win.setProofreadingBusy(true);
  const details = { characterCount: 1062, providerLabel: 'OpenCode', model: 'opencode/mimo-v2.6-flash-free' };
  const first = win.requestFullDocumentConfirmation(details);
  let settled = false;
  first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(elements['full-document-confirmation'].hidden, false);
  assert.equal(elements['cancel-proofreading'].hidden, true);
  assert.match(elements['full-document-confirmation-message'].textContent, /1062/);
  assert.match(elements['full-document-confirmation-message'].textContent, /OpenCode/);
  assert.match(elements['full-document-confirmation-message'].textContent, /mimo-v2.6-flash-free/);
  assert.equal(doc.activeElement, elements['confirm-full-document']);
  elements['confirm-full-document'].fire('click');
  assert.equal(await first, true);
  assert.equal(elements['full-document-confirmation'].hidden, true);
  assert.equal(elements['cancel-proofreading'].hidden, false);

  const second = win.requestFullDocumentConfirmation(details);
  elements['decline-full-document'].fire('click');
  assert.equal(await second, false);
  assert.equal(elements['full-document-confirmation'].hidden, true);
  assert.equal(win.dismissFullDocumentConfirmation(), false);

  const third = win.requestFullDocumentConfirmation(details);
  (listeners.keydown || []).forEach((fn) => fn({ key: 'Escape', preventDefault() {} }));
  assert.equal(await third, false);
  assert.equal(elements['full-document-confirmation'].hidden, true);

  const fourth = win.requestFullDocumentConfirmation(details);
  assert.equal(win.dismissFullDocumentConfirmation(), true);
  assert.equal(await fourth, false);
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
  assert.equal(win.pushProofreadingRecord(Object.assign({}, record,
    { runId: 1, action: 'undone', operationId: 1 })), true);
  assert.equal(win.pushProofreadingRecord(Object.assign({}, record,
    { runId: 1, action: 'applied', operationId: 2 })), true);
});

test('issue cards locate on body click, keep buttons independent, and offer undo after apply', () => {
  function element(tag) {
    const node = { tag, children: [], parent: null, listeners: {}, disabled: false };
    node.appendChild = (child) => { child.parent = node; node.children.push(child); return child; };
    node.setAttribute = () => {};
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.fire = (type) => {
      let stopped = false;
      const event = { stopPropagation() { stopped = true; } };
      let current = node;
      while (current && !stopped) {
        (current.listeners[type] || []).forEach((fn) => fn(event));
        current = current.parent;
      }
    };
    Object.defineProperty(node, 'textContent', {
      get() { return node.value || ''; },
      set(value) { node.value = value; node.children = []; }
    });
    return node;
  }
  const list = element('section');
  const empty = element('p');
  const calls = [];
  const win = {
    document: {
      readyState: 'loading',
      getElementById: (id) => ({ 'proofreading-issues': list, 'empty-state': empty })[id] || null,
      createElement: element,
      addEventListener() {}
    },
    locateProofreadingIssue: (id) => { calls.push(['locate', id]); return true; },
    applyProofreadingIssue: (id) => { calls.push(['apply', id]); return true; },
    undoProofreadingIssue: (id) => { calls.push(['undo', id]); return true; }
  };
  loadBrowserScript('js/taskpane.js', win);
  win.setProofreadingIssues([
    { id: 'pending', category: 'typo', original: '错字', suggestion: '正字',
      status: 'pending', reason: '需要核对' },
    { id: 'accepted', category: 'typo', original: '原字', suggestion: '新字',
      status: 'accepted' },
    { id: 'stale', category: 'typo', original: '旧字', suggestion: '正字',
      status: 'stale' }
  ]);
  const pending = list.children.find((child) => child.className.includes('is-locatable'));
  const stale = list.children.find((child) => child.className === 'issue-card');
  const processedSection = list.children.find((child) => child.tag === 'details');
  assert.ok(processedSection);
  assert.equal(processedSection.open, false);
  const accepted = processedSection.children[1].children[0];
  pending.fire('click');
  assert.deepEqual(calls, [['locate', 'pending']]);
  pending.children[0].children[1].children[1].fire('click');
  assert.deepEqual(calls, [['locate', 'pending'], ['locate', 'pending']]);
  pending.children[0].children[1].children[0].fire('click');
  assert.deepEqual(calls.at(-1), ['apply', 'pending']);
  const analysis = pending.children.find((child) => child.tag === 'details');
  analysis.children[0].fire('click');
  assert.equal(calls.length, 3);
  const undo = accepted.children[0].children[1].children[0];
  assert.equal(undo.textContent, '撤销');
  assert.equal(undo.disabled, false);
  undo.fire('click');
  assert.deepEqual(calls.at(-1), ['undo', 'accepted']);
  stale.fire('click');
  assert.equal(calls.length, 4);
});

test('a new proofreading run resets filter and tab while preserving session history', () => {
  const { win, elements } = createResultHarness();
  win.setProofreadingIssues([{
    id: 'done', category: 'typo', original: '原字', suggestion: '新字', status: 'accepted'
  }]);
  elements['issue-filter'].value = 'typo';
  elements['issue-filter'].fire('change');
  elements['tab-history'].fire('click');
  assert.equal(elements['proofreading-history'].children.length, 1);

  assert.equal(win.beginProofreadingRun(), true);
  assert.equal(elements['issue-filter'].value, 'all');
  assert.equal(elements['tab-issues'].attributes['aria-selected'], 'true');
  assert.equal(elements['tab-history'].attributes['aria-selected'], 'false');
  assert.equal(elements['proofreading-history'].hidden, true);
  assert.equal(elements['result-count'].textContent, '0');

  elements['tab-history'].fire('click');
  assert.equal(elements['proofreading-history'].children.length, 1);
  assert.equal(elements['proofreading-history'].hidden, false);
});

test('result summaries count pending review, processed, stale, and strict safe-format actions', () => {
  const { win, elements, calls } = createResultHarness();
  win.setProofreadingIssues([
    { id: 'pending', category: 'typo', original: '错字', suggestion: '正字', status: 'pending' },
    { id: 'review', category: 'wording', original: '待核对', suggestion: '规范写法', status: 'pending',
      needsReview: true, autoFixable: true, confidence: 0.99 },
    { id: 'safe', category: 'punctuation', original: '，', suggestion: '。', status: 'pending',
      autoFixable: true, confidence: 0.95 },
    { id: 'accepted', category: 'typo', original: '原字', suggestion: '新字', status: 'accepted' },
    { id: 'ignored', category: 'grammar', original: '原句', suggestion: '新句', status: 'ignored' },
    { id: 'stale', category: 'typo', original: '旧字', suggestion: '正字', status: 'stale' }
  ]);

  assert.equal(elements['result-count'].textContent, '3');
  assert.equal(elements['result-summary'].textContent, '待处理 3（其中需复核 1）· 已处理 2');
  assert.equal(elements['result-stale-summary'].textContent, '需重查 1');
  assert.equal(elements['result-stale-summary'].hidden, false);
  assert.equal(elements['apply-all'].textContent, '修正安全格式项（1）');
  assert.equal(elements['apply-all'].disabled, false);

  const processedSection = elements['proofreading-issues'].children.find((child) => child.tag === 'details');
  assert.ok(processedSection);
  assert.equal(processedSection.open, false);
  assert.equal(processedSection.children[1].children.length, 2);
  processedSection.open = true;
  const acceptedCard = processedSection.children[1].children.find((card) =>
    card.children[0].children[1].children[0].textContent === '撤销');
  assert.ok(acceptedCard);
  const undo = acceptedCard.children[0].children[1].children[0];
  undo.fire('click');
  assert.deepEqual(calls.at(-1), ['undo', 'accepted']);

  win.setProofreadingActionBusy(true);
  assert.equal(elements['apply-all'].disabled, true);
  win.setProofreadingActionBusy(false);
  assert.equal(elements['apply-all'].disabled, false);

  win.setProofreadingBusy(true);
  const waitingCard = elements['proofreading-issues'].children.find((card) =>
    card.className === 'issue-card' && card.children[0].children[1].children[0].textContent === '修正');
  assert.ok(waitingCard);
  assert.equal(waitingCard.children[0].children[1].children[0].disabled, true);
  win.setProofreadingBusy(false);

  win.setProofreadingIssues([]);
  assert.equal(elements['proofreading-issues'].hidden, true);
  assert.equal(elements['empty-state'].textContent, '校对结果会显示在这里。');
  assert.equal(elements['result-stale-summary'].hidden, true);
});

test('action busy locks issue controls without rebuilding cards and catches rejected actions safely', async () => {
  function element(tag) {
    const node = { tag, children: [], parent: null, listeners: {}, disabled: false };
    node.appendChild = (child) => { child.parent = node; node.children.push(child); return child; };
    node.setAttribute = () => {};
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.fire = (type) => {
      let stopped = false;
      const event = { stopPropagation() { stopped = true; } };
      let current = node;
      while (current && !stopped) {
        (current.listeners[type] || []).forEach((fn) => fn(event));
        current = current.parent;
      }
    };
    Object.defineProperty(node, 'textContent', {
      get() { return node.value || ''; },
      set(value) { node.value = value; node.children = []; }
    });
    return node;
  }

  const list = element('section');
  const empty = element('p');
  const controls = {};
  ['run-proofreading', 'rerun-proofreading', 'apply-all', 'model-provider', 'rules-toggle']
    .forEach((id) => { controls[id] = element('button'); });
  const elements = Object.assign({
    'proofreading-issues': list,
    'empty-state': empty
  }, controls);
  const calls = [];
  let applyResult = true;
  const win = {
    document: {
      readyState: 'loading',
      getElementById: (id) => elements[id] || null,
      createElement: element,
      addEventListener() {}
    },
    locateProofreadingIssue: (id) => { calls.push(['locate', id]); return true; },
    applyProofreadingIssue: (id) => { calls.push(['apply', id]); return applyResult; },
    undoProofreadingIssue: (id) => { calls.push(['undo', id]); return true; },
    ignoreProofreadingIssue: (id) => { calls.push(['ignore', id]); return true; }
  };
  loadBrowserScript('js/taskpane.js', win);
  win.setProofreadingIssues([
    { id: 'pending', category: 'typo', original: '错字', suggestion: '正字', status: 'pending' },
    { id: 'accepted', category: 'typo', original: '原字', suggestion: '新字', status: 'accepted' },
    { id: 'stale', category: 'typo', original: '旧字', suggestion: '正字', status: 'stale' },
    { id: 'review', category: 'wording', original: '待核对', suggestion: '规范写法',
      status: 'pending', actionable: false },
    { id: 'autofix', category: 'punctuation', original: '，', suggestion: '。', status: 'pending',
      autoFixable: true, confidence: 0.95 }
  ]);

  const cardsBeforeLock = list.children.filter((child) => child.className === 'issue-card' ||
    child.className.includes('is-locatable'));
  const processedSection = list.children.find((child) => child.tag === 'details');
  const acceptedCard = processedSection.children[1].children[0];
  const pendingActions = cardsBeforeLock[0].children[0].children[1].children;
  const acceptedActions = acceptedCard.children[0].children[1].children;
  const staleActions = cardsBeforeLock[1].children[0].children[1].children;
  const reviewActions = cardsBeforeLock[2].children[0].children[1].children;

  assert.equal(typeof win.setProofreadingActionBusy, 'function');
  assert.equal(controls['run-proofreading'].disabled, false);
  assert.equal(controls['rerun-proofreading'].disabled, false);
  assert.equal(controls['apply-all'].disabled, false);
  assert.equal(controls['model-provider'].disabled, false);
  assert.equal(controls['rules-toggle'].disabled, false);

  win.setProofreadingActionBusy(true);
  assert.equal(list.children[0], cardsBeforeLock[0]);
  assert.equal(controls['run-proofreading'].disabled, true);
  assert.equal(controls['rerun-proofreading'].disabled, true);
  assert.equal(controls['apply-all'].disabled, true);
  assert.equal(controls['model-provider'].disabled, false);
  assert.equal(controls['rules-toggle'].disabled, false);
  [pendingActions, acceptedActions, staleActions, reviewActions].forEach((actions) => {
    Array.from(actions).forEach((button) => assert.equal(button.disabled, true));
  });
  cardsBeforeLock[0].fire('click');
  pendingActions[0].fire('click');
  pendingActions[1].fire('click');
  pendingActions[2].fire('click');
  assert.deepEqual(calls, []);

  win.setProofreadingActionBusy(false);
  assert.equal(list.children[0], cardsBeforeLock[0]);
  assert.equal(controls['run-proofreading'].disabled, false);
  assert.equal(controls['rerun-proofreading'].disabled, false);
  assert.equal(controls['apply-all'].disabled, false);
  assert.equal(pendingActions[0].disabled, false);
  assert.equal(pendingActions[1].disabled, false);
  assert.equal(pendingActions[2].disabled, false);
  assert.equal(acceptedActions[0].disabled, false);
  assert.equal(acceptedActions[1].disabled, true);
  assert.equal(acceptedActions[2].disabled, false);
  assert.equal(acceptedActions[3].disabled, true);
  assert.equal(staleActions[0].disabled, true);
  assert.equal(staleActions[1].disabled, true);
  assert.equal(staleActions[2].disabled, true);
  assert.equal(reviewActions[0].disabled, true);
  assert.equal(reviewActions[1].disabled, false);
  assert.equal(reviewActions[2].disabled, false);

  cardsBeforeLock[0].fire('click');
  assert.deepEqual(calls, [['locate', 'pending']]);

  applyResult = Promise.reject(new Error('正文内容不应出现在错误提示中'));
  pendingActions[0].fire('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1)[0], 'apply');
  assert.equal(win.getProofreadingStatus().text.includes('正文内容不应出现在错误提示中'), false);
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
