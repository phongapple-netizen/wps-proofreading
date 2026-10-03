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
    operations: { append: 0, insert: 0, remove: 0 },
    attributes: {},
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    open: false,
    style: {}
  };
  function detach(child) {
    if (!child.parent) return;
    const index = child.parent.children.indexOf(child);
    if (index >= 0) {
      child.parent.children.splice(index, 1);
      child.parent.operations.remove++;
    }
    child.parent = null;
  }
  node.appendChild = (child) => {
    detach(child);
    child.parent = node;
    node.children.push(child);
    node.operations.append++;
    return child;
  };
  node.insertBefore = (child, before) => {
    if (child === before) return child;
    detach(child);
    child.parent = node;
    const index = node.children.indexOf(before);
    node.children.splice(index < 0 ? node.children.length : index, 0, child);
    node.operations.insert++;
    return child;
  };
  node.removeChild = (child) => {
    const index = node.children.indexOf(child);
    if (index < 0) throw new Error('removeChild target is not a child');
    node.children.splice(index, 1);
    child.parent = null;
    node.operations.remove++;
    return child;
  };
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.getAttribute = (name) => node.attributes[name] || null;
  node.querySelectorAll = (selector) => {
    const found = [];
    (function visit(current) {
      for (const child of current.children) {
        if (selector === '.issue-card[data-issue-id]' &&
          child.className.split(/\s+/).includes('issue-card') && child.getAttribute('data-issue-id')) {
          found.push(child);
        }
        visit(child);
      }
    })(node);
    return found;
  };
  node.querySelector = (selector) => findNode(node, (child) => child !== node &&
    child.className.split(/\s+/).includes(selector.slice(1)));
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
    get() { return node._textContent || node.children.map((child) => child.textContent).join(''); },
    set(value) {
      node.children.forEach(child => { child.parent = null; node.operations.remove++; });
      node._textContent = String(value == null ? '' : value);
      node.children = [];
    }
  });
  node.focus = () => {};
  return node;
}

function createResultHarness(extraWindow = {}) {
  const ids = ['issue-filter', 'tab-issues', 'tab-history', 'proofreading-issues', 'empty-state',
    'history-empty', 'proofreading-history', 'result-count', 'result-summary', 'result-stale-summary',
    'apply-all', 'rerun-proofreading', 'proofreading-status', 'proofreading-view', 'rewrite-view',
    'mode-proofread', 'mode-rewrite', 'deep-enhance-control', 'proofreading-toast', 'app-version'];
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
      addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
      fire(type, event) { (documentListeners[type] || []).forEach(fn => fn(event || {})); }
    },
    locateProofreadingIssue: (id) => { calls.push(['locate', id]); return true; },
    applyProofreadingIssue: (id) => { calls.push(['apply', id]); return true; },
    undoProofreadingIssue: (id) => { calls.push(['undo', id]); return true; },
    ignoreProofreadingIssue: (id) => { calls.push(['ignore', id]); return true; },
    openIssueRuleDraft: (issue) => { ruleDrafts.push(issue); return true; },
    applyAllProofreadingIssues: () => { calls.push(['apply-all']); return true; }
  };
  Object.assign(win, extraWindow);
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

function issueActions(card) {
  return findNode(card, (node) => node.className === 'issue-actions');
}

function issueActionButtons(card) {
  const buttons = [];
  (function visit(node) {
    if (node.tag === 'button') buttons.push(node);
    (node.children || []).forEach(visit);
  })(issueActions(card));
  return buttons;
}

test('settings displays the package version and keeps package metadata aligned', async () => {
  const packageInfo = JSON.parse(read('package.json'));
  const calls = [];
  const { elements } = createResultHarness({
    fetch: async (url, options) => {
      calls.push([url, options]);
      return { ok: true, json: async () => ({ version: packageInfo.version }) };
    }
  });
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '../package.json');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(elements['app-version'].textContent, 'WPS 文本校改 · v' + packageInfo.version);

  const packageLock = JSON.parse(read('package-lock.json'));
  assert.equal(packageLock.version, packageInfo.version);
  assert.equal(packageLock.packages[''].version, packageInfo.version);
  assert.match(read('ui/taskpane.html'), /id="app-version"/);
});

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

test('top-level mode switch separates rewrite from proofreading and hides deep enhancement in rewrite mode', () => {
  const { win, elements } = createResultHarness();
  elements['rewrite-view'].hidden = true;
  assert.equal(elements['proofreading-view'].hidden, false);
  assert.equal(elements['rewrite-view'].hidden, true);
  assert.equal(win.setAppMode('rewrite'), 'rewrite');
  assert.equal(elements['proofreading-view'].hidden, true);
  assert.equal(elements['rewrite-view'].hidden, false);
  assert.equal(elements['deep-enhance-control'].hidden, true);
  assert.equal(elements['mode-rewrite'].getAttribute('aria-selected'), 'true');
  assert.equal(win.setAppMode('proofread'), 'proofread');
  assert.equal(elements['proofreading-view'].hidden, false);
  assert.equal(elements['rewrite-view'].hidden, true);
  assert.equal(elements['deep-enhance-control'].hidden, false);
});

test('mode tabs stay locked for rewrite, proofreading, and proofreading actions, then recover', () => {
  const { win, elements } = createResultHarness();
  assert.equal(win.setAppMode('rewrite'), 'rewrite');
  win.setRewriteBusy(true);
  assert.equal(elements['mode-proofread'].disabled, true);
  assert.equal(elements['mode-rewrite'].disabled, true);
  assert.equal(win.setAppMode('proofread'), 'rewrite');
  elements['mode-proofread'].fire('click');
  assert.equal(win.getAppMode(), 'rewrite');
  win.setRewriteBusy(false);
  assert.equal(elements['mode-proofread'].disabled, false);
  assert.equal(win.setAppMode('proofread'), 'proofread');

  for (const [start, finish] of [
    [() => win.setProofreadingBusy(true), () => win.setProofreadingBusy(false)],
    [() => win.setProofreadingActionBusy(true), () => win.setProofreadingActionBusy(false)]
  ]) {
    start();
    assert.equal(elements['mode-proofread'].disabled, true);
    assert.equal(elements['mode-rewrite'].disabled, true);
    assert.equal(win.setAppMode('rewrite'), 'proofread');
    elements['mode-rewrite'].fire('click');
    assert.equal(win.getAppMode(), 'proofread');
    finish();
    assert.equal(elements['mode-proofread'].disabled, false);
    assert.equal(elements['mode-rewrite'].disabled, false);
  }
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
    original: '旧表述', suggestion: '新表述', actionable: true, status: 'pending'
  }]);

  const saveButton = findNode(elements['proofreading-issues'], (node) => node.tag === 'button' && node.textContent === '保存为规则');
  assert.ok(saveButton);
  assert.equal(saveButton.disabled, false);
  const moreToggle = findNode(elements['proofreading-issues'], (node) => node.className === 'issue-more-toggle');
  moreToggle.fire('click');
  assert.equal(moreToggle.getAttribute('aria-expanded'), 'true');
  saveButton.fire('click');
  assert.equal(ruleDrafts.length, 1);
  assert.equal(ruleDrafts[0].original, '旧表述');
  assert.equal(ruleDrafts[0].suggestion, '新表述');
  assert.equal(calls.some((call) => call[0] === 'apply'), false);

  win.markProofreadingIssueRuleSaved('ai-issue');
  const savedButton = findNode(elements['proofreading-issues'], (node) => node.tag === 'button' && node.textContent === '已保存规则');
  assert.ok(savedButton);
  assert.equal(savedButton.disabled, true);
  assert.equal(findNode(elements['proofreading-issues'],
    (node) => node.textContent === '已保存为固定替换规则，下次校对时生效。') !== null, true);
});

test('review-only cards show neutral text and keep card location with ignore action', () => {
  const { win, elements, calls } = createResultHarness();
  win.setProofreadingIssues([{
    id: 'review-only', action: 'review', actionable: false, needsReview: true,
    category: 'wording', original: '电信信号视频连线', suggestion: '',
    reason: '搭配需人工核对。', status: 'pending'
  }]);
  const card = elements['proofreading-issues'].children[0];
  assert.equal(findNode(card, (node) => node.className === 'diff-old'), null);
  assert.equal(findNode(card, (node) => node.className === 'issue-review-label').textContent, '需核对');
  assert.equal(findNode(card, (node) => node.className === 'issue-review-text').textContent, '电信信号视频连线');
  assert.ok(findNode(card, (node) => node.textContent === '错误分析'));
  const actions = issueActions(card).children;
  assert.deepEqual(actions.map((button) => button.textContent), ['忽略']);
  card.fire('click');
  actions[0].fire('click');
  assert.deepEqual(calls, [['locate', 'review-only'], ['ignore', 'review-only']]);

  win.setProofreadingIssues([{
    id: 'review-action', action: 'review', original: '待核对原文', suggestion: '未验证候选', status: 'pending'
  }]);
  const actionOnlyCard = elements['proofreading-issues'].children[0];
  assert.equal(findNode(actionOnlyCard, (node) => node.className === 'diff-old'), null);
  assert.equal(findNode(actionOnlyCard, (node) => node.textContent === '修正'), null);
  const css = read('ui/taskpane.css');
  assert.match(css, /\.issue-review-text\s*\{[^}]*text-decoration:\s*none/);
  assert.match(css, /\.issue-review-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.results-panel\s*\{/);
  assert.match(css, /\.issue-main\s*\{/);
  assert.match(css, /\.issue-title\s*\{/);
});

test('compact cards promote rule names and omit redundant ordinary pending status', () => {
  const { win, elements } = createResultHarness();
  win.setProofreadingIssues([{
    id: 'compact-rule', category: 'punctuation', original: ',', suggestion: '，',
    status: 'pending', origin: 'rule', ruleName: '汉字之间误用英文逗号',
    ruleSource: '内置基础规则'
  }]);
  const card = elements['proofreading-issues'].children[0];
  assert.equal(findNode(card, (node) => node.className === 'issue-title').textContent, '汉字之间误用英文逗号');
  assert.equal(findNode(card, (node) => node.className === 'badge-source').textContent, '本地规则');
  assert.equal(findNode(card, (node) => node.className === 'issue-status'), null);
  assert.ok(findNode(card, (node) => node.className === 'issue-main'));
  assert.ok(findNode(card, (node) => node.className === 'issue-actions'));
});

test('replace and delete cards highlight only changed characters and keep writable actions', () => {
  const { win, elements, calls } = createResultHarness();
  win.setProofreadingIssues([
    { id: 'replace', action: 'replace', actionable: true, original: '旧表述',
      suggestion: '新表述', status: 'pending' },
    { id: 'delete', action: 'delete', actionable: true, original: '多余文字',
      suggestion: '', status: 'pending' }
  ]);
  const [replaceCard, deleteCard] = elements['proofreading-issues'].children;
  assert.equal(findNode(replaceCard, (node) => node.tag === 'del').textContent, '旧');
  assert.equal(findNode(replaceCard, (node) => node.tag === 'ins').textContent, '新');
  assert.equal(findNode(replaceCard, (node) => node.className === 'diff-common').textContent, '表述');
  assert.equal(findNode(deleteCard, (node) => node.tag === 'del').textContent, '多余文字');
  assert.equal(findNode(deleteCard, (node) => node.className === 'diff-delete-note').textContent, '（建议删除）');
  const replaceButton = findNode(replaceCard, (node) => node.textContent === '修正');
  const deleteButton = findNode(deleteCard, (node) => node.textContent === '修正');
  assert.equal(replaceButton.disabled, false);
  assert.equal(deleteButton.disabled, false);
  replaceButton.fire('click');
  deleteButton.fire('click');
  assert.deepEqual(calls, [['apply', 'replace'], ['apply', 'delete']]);

  win.setProofreadingIssues([{
    id: 'replace', action: 'replace', actionable: true, original: '旧表述',
    suggestion: '新表述', status: 'accepted'
  }]);
  const processed = elements['proofreading-issues'].children.find((node) => node.tag === 'details');
  const acceptedCard = processed.children[1].children[0];
  const undoButton = findNode(acceptedCard, (node) => node.textContent === '撤销');
  assert.equal(undoButton.disabled, false);
  undoButton.fire('click');
  assert.deepEqual(calls.at(-1), ['undo', 'replace']);
});

test('character diff handles common suffixes, surrogate pairs, and identical suggestions; review actions stay outlined', () => {
  const { win, elements, calls } = createResultHarness();
  win.setProofreadingIssues([
    { id: 'unicode', original: '甲😀乙', suggestion: '甲😁乙', status: 'pending' },
    { id: 'same', original: '完全相同', suggestion: '完全相同', status: 'pending' },
    { id: 'review', original: '甲，乙', suggestion: '甲、乙', status: 'pending', needsReview: true }
  ]);
  const [unicodeCard, sameCard, reviewCard] = elements['proofreading-issues'].children;
  assert.equal(findNode(unicodeCard, (node) => node.tag === 'del').textContent, '😀');
  assert.equal(findNode(unicodeCard, (node) => node.tag === 'ins').textContent, '😁');
  assert.deepEqual(findNode(unicodeCard, (node) => node.className === 'issue-diff').children
    .filter((node) => node.className === 'diff-common').map((node) => node.textContent), ['甲', '乙']);
  assert.ok(findNode(sameCard, (node) => node.className === 'issue-identical-note'));
  assert.equal(findNode(sameCard, (node) => node.tag === 'del'), null);
  const confirm = findNode(reviewCard, (node) => node.tag === 'button' && node.textContent === '确认修正');
  assert.ok(confirm.className.includes('issue-action-review'));
  assert.equal(confirm.disabled, false);
  const ignore = findNode(reviewCard, (node) => node.tag === 'button' && node.textContent === '忽略');
  assert.ok(ignore.className.includes('button-text'));
  confirm.fire('click');
  assert.deepEqual(calls, [['apply', 'review']]);
});

test('locate success toast expires after three seconds and preserves visible warnings and errors', () => {
  const timers = new Map();
  let nextTimer = 0;
  const { win, elements } = createResultHarness({
    setTimeout(callback, delay) {
      assert.equal(delay, 3000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  win.setProofreadingStatus('文档已经变化，请重新校对。', 'warning');
  win.setProofreadingStatus('已在文档中定位这条问题。', 'success');
  assert.equal(elements['proofreading-toast'].hidden, false);
  assert.equal(win.getProofreadingStatus().text, '文档已经变化，请重新校对。');
  assert.equal(elements['proofreading-status'].textContent, '文档已经变化，请重新校对。');
  assert.equal(elements['proofreading-status'].className, 'status status-warning');
  win.setProofreadingStatus('已在文档中定位这条问题。', 'success');
  assert.equal(timers.size, 1);
  win.setProofreadingStatus('定位失败，请重新校对。', 'error');
  timers.values().next().value();
  assert.equal(elements['proofreading-toast'].hidden, true);
  assert.equal(elements['proofreading-status'].className, 'status status-error');
  assert.equal(elements['proofreading-status'].textContent, '定位失败，请重新校对。');
});

test('non-actionable identical suggestions keep the neutral note and offer no correction', () => {
  const { win, elements } = createResultHarness();
  win.setProofreadingIssues([{ id: 'same-review', original: '原文保持不变',
    suggestion: '原文保持不变', actionable: false, needsReview: true, status: 'pending' }]);
  const card = elements['proofreading-issues'].children[0];
  assert.equal(findNode(card, (node) => node.className === 'issue-identical-text').textContent, '原文保持不变');
  assert.equal(findNode(card, (node) => node.className === 'issue-identical-note').textContent,
    '建议文本与原文一致，请人工核对。');
  assert.equal(findNode(card, (node) => node.tag === 'del' || node.tag === 'ins'), null);
  assert.deepEqual(issueActionButtons(card).map((node) => node.textContent), ['忽略']);
});

test('result layout places toast after the summary and keeps ordinary statuses accessible without a separate row', () => {
  const html = read('ui/taskpane.html');
  const summary = html.indexOf('class="result-summary-row"');
  const toast = html.indexOf('id="proofreading-toast"');
  assert.ok(html.indexOf('class="tab-bar result-tab-row"') < summary);
  assert.ok(summary < toast && toast < html.indexOf('id="proofreading-issues"'));
  assert.match(html.slice(summary, toast), /id="proofreading-status"[^>]*aria-live="polite"/);
  const { win, elements } = createResultHarness();
  ['idle', 'success'].forEach((tone) => {
    win.setProofreadingStatus('普通消息', tone);
    assert.match(elements['proofreading-status'].className, /status-compact/);
    assert.equal(elements['proofreading-status'].textContent, '普通消息');
  });
  ['warning', 'error', 'working'].forEach((tone) => {
    win.setProofreadingStatus('需要可见的消息', tone);
    assert.equal(elements['proofreading-status'].className, 'status status-' + tone);
  });
});

test('accepted AI issues can save a rule without applying again or changing accepted status', () => {
  const { win, elements, calls, ruleDrafts } = createResultHarness();
  let documentText = '甲市公共服务中心旧称';
  const apply = win.applyProofreadingIssue;
  win.applyProofreadingIssue = (id) => {
    apply(id);
    documentText = '甲市公共服务中心';
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
    original: '甲市公共服务中心旧称', suggestion: '甲市公共服务中心', status: 'pending'
  }]);

  findNode(elements['proofreading-issues'], (node) => node.textContent === '修正').fire('click');
  assert.deepEqual(calls, [['apply', 'accepted-ai']]);
  win.setProofreadingIssues([{
    id: 'accepted-ai', category: 'wording', origin: 'ai',
    original: '甲市公共服务中心旧称', suggestion: '甲市公共服务中心', status: 'accepted'
  }]);
  assert.ok(findNode(elements['proofreading-issues'], (node) => node.textContent === '撤销'));
  const save = findNode(elements['proofreading-issues'], (node) => node.tag === 'button' && node.textContent === '保存为规则');
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

  assert.equal(documentText, '甲市公共服务中心');
  assert.deepEqual(calls, [['apply', 'accepted-ai']]);
  assert.ok(findNode(elements['proofreading-issues'], (node) => node.textContent === '撤销'));
  const savedButton = findNode(elements['proofreading-issues'], (node) => node.tag === 'button' && node.textContent === '已保存规则');
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
  elements['fixed-rule-pattern'].value = '甲市公共服务中心旧称';
  elements['fixed-rule-replacement'].value = '甲市公共服务中心';
  elements['fixed-rule-name'].value = '机构名称规范';
  elements['fixed-rule-notes'].value = '人工确认后建立';
  assert.equal(win.WpsRulesCenter.getRules().length, 0);
  elements['fixed-rule-editor'].fire('submit');

  const saved = win.WpsRulesCenter.getRules()[0];
  assert.equal(saved.pattern, '甲市公共服务中心旧称');
  assert.equal(saved.replacement, '甲市公共服务中心');
  assert.equal(saved.name, '机构名称规范');
  assert.equal(saved.notes, '人工确认后建立');
  assert.equal(saved.type, 'replace');
  assert.equal(saved.autoFix, false);
  assert.equal(elements['fixed-rule-editor'].hidden, true);
});

test('top toolbar and rules center expose the expected controls', () => {
  const html = read('ui/taskpane.html');
  assert.match(html, /<div class="toolbar">/);
  assert.doesNotMatch(html, /<h1 class="toolbar-title">智能校改<\/h1>/);
  assert.match(html, /id="main-view"/);
  assert.match(html, /id="settings-back"/);
  assert.match(html, /id="mode-proofread"/);
  assert.match(html, /id="mode-rewrite"/);
  assert.match(html, /id="rewrite-view"/);
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
  assert.match(html, /一键修正（0）/);
  assert.doesNotMatch(html, /修正安全格式项/);
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
  assert.doesNotMatch(taskpane, /修正安全格式项/);
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

test('settings page returns with Escape or back without closing on outside click', () => {
  const ids = ['main-view', 'settings-toggle', 'settings-back', 'settings-popover', 'rules-toggle', 'rules-center', 'run-proofreading', 'cancel-proofreading',
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
  elements['main-view'].hidden = false;
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
  assert.equal(elements['main-view'].hidden, true);
  assert.equal(elements['rules-center'].hidden, true);
  elements['rules-toggle'].fire('click');
  assert.equal(elements['rules-center'].hidden, false);
  assert.equal(elements['settings-popover'].hidden, false);
  elements['rules-toggle'].fire('click');
  assert.equal(elements['rules-center'].hidden, true);
  elements['settings-popover'].fire('click');
  assert.equal(elements['settings-popover'].hidden, false);
  win.document.fire('click');
  assert.equal(elements['settings-popover'].hidden, false);

  elements['settings-back'].fire('click');
  assert.equal(elements['settings-popover'].hidden, true);
  assert.equal(elements['main-view'].hidden, false);
  elements['settings-toggle'].fire('click');
  assert.equal(elements['settings-popover'].hidden, false);
  win.document.fire('keydown', { key: 'Escape' });
  assert.equal(elements['settings-popover'].hidden, true);
  assert.equal(elements['main-view'].hidden, false);
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
    undoProofreadingIssue: (id) => { calls.push(['undo', id]); return true; },
    ignoreProofreadingIssue: (id) => { calls.push(['ignore', id]); return true; },
    openIssueRuleDraft: (issue) => { calls.push(['save', issue.id]); return true; }
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
  assert.equal(!!findNode(list, (node) => node.tag === 'button' && node.textContent === '定位'), false);
  pending.fire('click');
  assert.deepEqual(calls, [['locate', 'pending']]);
  findNode(pending, (node) => node.tag === 'button' && node.textContent === '修正').fire('click');
  assert.deepEqual(calls.at(-1), ['apply', 'pending']);
  findNode(pending, (node) => node.tag === 'button' && node.textContent === '忽略').fire('click');
  assert.deepEqual(calls.at(-1), ['ignore', 'pending']);
  const save = findNode(pending, (node) => node.tag === 'button' && node.textContent === '保存为规则');
  assert.ok(save);
  save.fire('click');
  assert.deepEqual(calls.at(-1), ['save', 'pending']);
  const analysis = pending.children.find((child) => child.tag === 'details');
  analysis.children[0].fire('click');
  assert.equal(calls.length, 4);
  const undo = issueActions(accepted).children[0];
  assert.equal(undo.textContent, '撤销');
  assert.equal(undo.disabled, false);
  undo.fire('click');
  assert.deepEqual(calls.at(-1), ['undo', 'accepted']);
  stale.fire('click');
  assert.equal(calls.length, 5);
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

test('incremental cards keep filter, tab, scroll, and expanded analysis while writes stay disabled', () => {
  const { win, elements, calls } = createResultHarness();
  const list = elements['proofreading-issues'];
  const first = { id: 'stable-1', category: 'typo', original: '错字', suggestion: '正字',
    reason: '测试分析', status: 'pending', autoFixable: true, confidence: 0.95 };
  win.setProofreadingBusy(true);
  win.setProofreadingIssues([first]);
  const originalCard = list.children[0];
  const analysis = findNode(originalCard, (node) => node.className === 'issue-analysis');
  analysis.open = true;
  list.scrollTop = 240;
  originalCard.fire('click');
  assert.deepEqual(calls.at(-1), ['locate', 'stable-1']);
  assert.equal(issueActions(originalCard).children[0].disabled, true);
  assert.equal(elements['apply-all'].disabled, true);

  win.setProofreadingIssues([first, { id: 'stable-2', category: 'grammar', original: '病句',
    suggestion: '通顺', status: 'pending' }]);
  assert.equal(list.scrollTop, 240);
  assert.equal(findNode(list.children[0], (node) => node.className === 'issue-analysis').open, true);
  elements['issue-filter'].value = 'typo';
  elements['issue-filter'].fire('change');
  win.setProofreadingIssues([first, { id: 'stable-2', category: 'grammar', original: '病句',
    suggestion: '通顺', status: 'pending' }, { id: 'stable-3', category: 'typo',
    original: '误字', suggestion: '正字', status: 'pending' }]);
  assert.equal(elements['issue-filter'].value, 'typo');
  assert.equal(list.children.length, 2);
  elements['tab-history'].fire('click');
  win.setProofreadingIssues([first, { id: 'stable-3', category: 'typo',
    original: '误字', suggestion: '正字', status: 'pending' }]);
  assert.equal(elements['tab-history'].attributes['aria-selected'], 'true');
  win.setProofreadingBusy(false);
  elements['tab-issues'].fire('click');
  assert.equal(issueActions(list.children[0]).children[0].disabled, false);
  assert.equal(elements['apply-all'].disabled, false);
});

test('first-pass completion unlocks apply actions while busy, keeps rule saving locked, and permits ignore', () => {
  const { win, elements, calls, ruleDrafts } = createResultHarness();
  const list = elements['proofreading-issues'];
  const issue = { id: 'busy-item', category: 'typo', original: '错字', suggestion: '正字',
    reason: '分析', status: 'pending', autoFixable: true, confidence: 0.95 };
  win.setProofreadingBusy(true);
  win.setProofreadingIssues([issue]);
  const card = list.children[0];
  const actions = issueActions(card).children;
  const apply = actions.find(button => button.textContent === '修正');
  const ignore = actions.find(button => button.textContent === '忽略');
  const save = findNode(card, node => node.tag === 'button' && node.textContent === '保存为规则');
  assert.equal(apply.disabled, true);
  assert.equal(ignore.disabled, false);
  assert.equal(elements['apply-all'].disabled, true);
  assert.equal(save.disabled, true);
  ignore.fire('click');
  assert.deepEqual(calls.at(-1), ['ignore', 'busy-item']);

  assert.equal(win.setProofreadingFirstPassComplete(true), true);
  assert.equal(apply.disabled, false);
  assert.equal(ignore.disabled, false);
  assert.equal(elements['apply-all'].disabled, false);
  elements['apply-all'].fire('click');
  assert.deepEqual(calls.at(-1), ['apply-all']);
  apply.fire('click');
  assert.deepEqual(calls.at(-1), ['apply', 'busy-item']);
  save.fire('click');
  assert.equal(ruleDrafts.length, 0, 'rule saving stays locked during a run');
  win.setProofreadingActionBusy(true);
  assert.equal(apply.disabled, true, 'actionBusy keeps actions locked after first-pass completion');
});

test('100+ issue updates reuse unchanged keyed cards and create only changed and new cards in input order', () => {
  const { win, elements, calls } = createResultHarness();
  const list = elements['proofreading-issues'];
  let articleCreates = 0;
  const createElement = win.document.createElement;
  win.document.createElement = tag => {
    if (tag === 'article') articleCreates++;
    return createElement(tag);
  };
  const initial = Array.from({ length: 120 }, (_, index) => ({
    id: `issue-${index}`, category: 'typo', original: `错${index}`, suggestion: `正${index}`,
    status: 'pending', reason: `分析${index}`
  }));
  win.setProofreadingIssues(initial);
  assert.equal(articleCreates, 120);
  const identities = new Map(list.children.map(card => [card.getAttribute('data-issue-id'), card]));
  Object.keys(list.operations).forEach(key => { list.operations[key] = 0; });
  articleCreates = 0;
  win.setProofreadingIssues(initial.map(issue => Object.assign({}, issue)));
  assert.equal(articleCreates, 0);
  assert.deepEqual(list.operations, { append: 0, insert: 0, remove: 0 });

  articleCreates = 0;
  const next = initial.map(issue => issue.id === 'issue-57'
    ? Object.assign({}, issue, { reason: '已更新分析' }) : issue);
  next.push({ id: 'issue-new', category: 'grammar', original: '病句',
    suggestion: '通顺', status: 'pending', reason: '新增分析' });
  Object.keys(list.operations).forEach(key => { list.operations[key] = 0; });
  win.setProofreadingIssues(next);
  assert.equal(articleCreates, 2);
  assert.equal(list.children.length, 121);
  assert.equal(list.operations.remove, 1, 'only the changed card is detached');
  assert.equal(list.operations.insert, 2, 'only the changed card and appended card are inserted');
  assert.deepEqual(list.children.map(card => card.getAttribute('data-issue-id')),
    next.map(issue => issue.id));
  for (const issue of next) {
    if (issue.id === 'issue-57' || issue.id === 'issue-new') continue;
    assert.equal(list.children.find(card => card.getAttribute('data-issue-id') === issue.id), identities.get(issue.id));
  }
  list.children.find(card => card.getAttribute('data-issue-id') === 'issue-new').fire('click');
  assert.deepEqual(calls.at(-1), ['locate', 'issue-new']);
});

test('an open reused issue menu still dismisses with Escape after an incremental batch', () => {
  const { win, elements } = createResultHarness();
  const issue = { id: 'menu', category: 'typo', original: '错字', suggestion: '正字', status: 'pending' };
  win.setProofreadingIssues([issue]);
  const card = elements['proofreading-issues'].children[0];
  const toggle = findNode(card, node => node.className === 'issue-more-toggle');
  const menu = findNode(card, node => node.className === 'issue-menu');
  toggle.fire('click');
  assert.equal(menu.hidden, false);
  win.setProofreadingIssues([issue, { ...issue, id: 'new-menu' }]);
  assert.equal(elements['proofreading-issues'].children[0], card);
  win.document.fire('keydown', { key: 'Escape' });
  assert.equal(menu.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('status changes replace one card in the processed section and preserve details state', () => {
  const { win, elements } = createResultHarness();
  const list = elements['proofreading-issues'];
  const pending = { id: 'transition', category: 'typo', original: '错字', suggestion: '正字',
    reason: '分析', status: 'pending' };
  const accepted = { id: 'already-done', category: 'typo', original: '原字', suggestion: '新字',
    status: 'accepted' };
  win.setProofreadingIssues([pending, accepted]);
  const details = list.children.find(child => child.className === 'processed-issues');
  details.open = true;
  const oldCard = list.children[0];
  findNode(oldCard, node => node.className === 'issue-analysis').open = true;
  list.scrollTop = 88;
  Object.keys(list.operations).forEach(key => { list.operations[key] = 0; });

  win.setProofreadingIssues([{ ...pending, status: 'accepted' }, accepted]);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], details);
  assert.equal(details.open, true);
  assert.equal(details.children[1].children.length, 2);
  assert.notEqual(details.children[1].children[0], oldCard);
  assert.equal(findNode(details.children[1].children[0], node => node.className === 'issue-analysis').open, true);
  assert.equal(list.scrollTop, 88);
  assert.equal(list.operations.remove, 1, 'only the replaced pending card is removed from the issue list');
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
  assert.equal(elements['result-summary'].textContent, '待处理 3 · 需复核 1 · 已处理 2 · 需重查 1');
  assert.equal(elements['result-stale-summary'].textContent, '需重查 1');
  assert.equal(elements['result-stale-summary'].hidden, true);
  assert.equal(elements['apply-all'].textContent, '一键修正（1）');
  assert.equal(elements['apply-all'].disabled, false);

  const processedSection = elements['proofreading-issues'].children.find((child) => child.tag === 'details');
  assert.ok(processedSection);
  assert.equal(processedSection.open, false);
  assert.equal(processedSection.children[1].children.length, 2);
  processedSection.open = true;
  const acceptedCard = processedSection.children[1].children.find((card) =>
    issueActions(card).children[0].textContent === '撤销');
  assert.ok(acceptedCard);
  const undo = issueActions(acceptedCard).children[0];
  undo.fire('click');
  assert.deepEqual(calls.at(-1), ['undo', 'accepted']);

  win.setProofreadingActionBusy(true);
  assert.equal(elements['apply-all'].disabled, true);
  win.setProofreadingActionBusy(false);
  assert.equal(elements['apply-all'].disabled, false);

  win.setProofreadingBusy(true);
  const waitingCard = elements['proofreading-issues'].children.find((card) =>
    card.className.split(/\s+/).includes('issue-card') && issueActions(card).children[0].textContent === '修正');
  assert.ok(waitingCard);
  assert.equal(issueActions(waitingCard).children[0].disabled, true);
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
  const pendingActions = issueActionButtons(cardsBeforeLock[0]);
  const acceptedActions = issueActionButtons(acceptedCard);
  const staleActions = issueActionButtons(cardsBeforeLock[1]);
  const reviewActions = issueActionButtons(cardsBeforeLock[2]);

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
    Array.from(actions).filter((node) => node.tag === 'button').forEach((button) => assert.equal(button.disabled, true));
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
  assert.equal(acceptedActions.find((button) => button.textContent === '忽略').disabled, true);
  assert.equal(acceptedActions.find((button) => button.className === 'issue-menu-item').disabled, false);
  assert.equal(staleActions[0].disabled, true);
  assert.equal(staleActions[1].disabled, true);
  assert.deepEqual(Array.from(reviewActions).map((button) => button.textContent), ['忽略']);
  assert.equal(reviewActions[0].disabled, false);

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
    'model-api-key-label', 'provider-help', 'deep-enhance', 'auto-advance', 'refresh-models',
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
  assert.equal(win.WpsSettingsStore.defaultSettings().autoAdvance, true);
  assert.equal(elements['auto-advance'].checked, true);
  elements['auto-advance'].checked = false;
  elements['auto-advance'].fire('change');
  assert.equal(win.WpsSettingsStore.loadSettings().autoAdvance, false);

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
  storage.set('wps_text_proofreading_model_settings_v1', JSON.stringify({ provider: 'ollama' }));
  assert.equal(win.WpsSettingsStore.loadSettings().autoAdvance, true);
  win.WpsSettingsStore.saveSettings({ provider: 'ollama', autoAdvance: false });
  assert.equal(win.WpsSettingsStore.loadSettings().autoAdvance, false);
});

function createDocumentResultHarness() {
  const { win, elements, calls, ruleDrafts } = createResultHarness();
  function document(name) {
    let body = '这里有错字，那里有误字。';
    return {
      Name: name, FullName: name, TrackRevisions: false,
      get Content() { return { Start: 0, End: body.length, Text: body }; },
      Range(start, end) {
        return { Start: start, End: end,
          get Text() { return body.slice(start, end); },
          set Text(value) { body = body.slice(0, start) + value + body.slice(end); },
          Select() {} };
      }
    };
  }
  const a = document('A.docx');
  const b = document('B.docx');
  const events = {};
  win.Application = { ActiveDocument: a, ApiEvent: {
    AddApiEventListener(name, callback) { events[name] = callback; }
  }, get Selection() { return { Range: this.ActiveDocument.Range(0, this.ActiveDocument.Content.End) }; } };
  win.WpsNativeDocument = { getApplication: () => win.Application };
  win.WpsSettingsStore = { loadSettings: () => ({ provider: 'ollama', autoAdvance: false,
    profiles: { ollama: { endpoint: 'http://127.0.0.1:11434', model: 'fixture' } } }) };
  win.AbortController = AbortController;
  win.setInterval = () => {};
  loadBrowserScript('js/proofreading-core.js', win);
  win.WpsProofreadingCore.requestModel = async () => JSON.stringify({ issues: [
    { category: 'typo', paragraphIndex: 1, original: '错字', suggestion: '正字',
      reason: '测试分析', confidence: 0.95, needsReview: false },
    { category: 'wording', paragraphIndex: 1, original: '误字', suggestion: '新字',
      reason: '测试分析', confidence: 0.95, needsReview: false }
  ] });
  loadBrowserScript('js/proofreading-integration.js', win);
  return { win, elements, calls, ruleDrafts, a, b,
    activate(doc, notify = true) {
      win.Application.ActiveDocument = doc;
      if (notify) events.WindowActivate(doc);
    } };
}

test('real document switching isolates history, ruleSaved, filter, tab, expanded analysis and status', async () => {
  const h = createDocumentResultHarness();
  const { win, elements } = h;
  await win.runProofreading();
  const [first, second] = win.getWpsProofreadingState().issues;
  assert.equal(await win.applyProofreadingIssue(first.id), true);
  win.markProofreadingIssueRuleSaved(first.id);
  const aRunId = win.captureProofreadingView().issues[0].runId;
  elements['issue-filter'].value = 'typo';
  elements['issue-filter'].fire('change');
  const processed = elements['proofreading-issues'].querySelector('.processed-issues');
  processed.open = true;
  processed.querySelector('.issue-analysis').open = true;
  elements['proofreading-issues'].scrollTop = 123;
  elements['tab-history'].fire('click');
  const aStatus = win.getProofreadingStatus().text;
  h.activate(h.b);
  assert.equal(elements['proofreading-issues'].children.length, 0);
  assert.equal(elements['proofreading-history'].children.length, 0);
  assert.equal(elements['empty-state'].textContent, '当前文档尚未校对');
  assert.equal(elements['empty-state'].hidden, false);
  assert.equal(win.captureProofreadingView().history.length, 0);
  assert.equal(elements['issue-filter'].value, 'all');
  assert.equal(elements['tab-issues'].getAttribute('aria-selected'), 'true');
  await win.runProofreading();
  const bIssue = win.getWpsProofreadingState().issues[1];
  assert.equal(win.ignoreProofreadingIssue(bIssue.id), true);
  assert.equal(win.captureProofreadingView().history.length, 1);
  h.activate(h.a);
  let saved = win.captureProofreadingView();
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].id, first.id);
  assert.equal(saved.issues[0].runId, aRunId);
  assert.equal(saved.issues[0].ruleSaved, true);
  assert.equal(saved.issues[1].ruleSaved, false);
  assert.equal(saved.filter, 'typo');
  assert.equal(saved.tab, 'history');
  assert.equal(win.getProofreadingStatus().text, aStatus);
  assert.equal(elements['proofreading-history'].children.length, 1);
  elements['tab-issues'].fire('click');
  assert.equal(elements['proofreading-issues'].scrollTop, 123);
  // History tab restoration defers card creation until the issues tab is shown.
  assert.equal(win.getWpsProofreadingState().issues[1].id, second.id);
  h.activate(h.b);
  saved = win.captureProofreadingView();
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].id, bIssue.id);
  assert.equal(saved.issues.every(issue => !issue.ruleSaved), true);
});

test('expanded and processed cards restore per document without inheriting B DOM state', async () => {
  const h = createDocumentResultHarness();
  const { win, elements } = h;
  await win.runProofreading();
  const id = win.getWpsProofreadingState().issues[0].id;
  await win.applyProofreadingIssue(id);
  const list = elements['proofreading-issues'];
  list.querySelector('.processed-issues').open = true;
  list.querySelector('.issue-analysis').open = true;
  list.scrollTop = 222;
  h.activate(h.b);
  await win.runProofreading();
  assert.equal(list.querySelector('.issue-analysis').open, false);
  h.activate(h.a);
  assert.equal(list.querySelector('.processed-issues').open, true);
  assert.equal(list.querySelector('.issue-analysis').open, true);
  assert.equal(list.scrollTop, 222);
});

test('no active WPS document clears real issue cards and history while preserving rewrite mode and busy protection', async () => {
  const h = createDocumentResultHarness();
  const { win, elements } = h;
  await win.runProofreading();
  win.ignoreProofreadingIssue(win.getWpsProofreadingState().issues[0].id);
  win.setAppMode('rewrite');
  win.setRewriteBusy(true);
  h.activate(null);
  assert.equal(elements['proofreading-issues'].children.length, 0);
  assert.equal(elements['proofreading-history'].children.length, 0);
  assert.equal(win.captureProofreadingView().issues.length, 0);
  assert.equal(win.getAppMode(), 'rewrite');
  assert.equal(win.getTaskBusyState().rewrite, true);
  assert.equal((await win.runProofreading()).reason, 'rewrite-busy');
  assert.equal(win.setAppMode('proofread'), 'rewrite');
});

test('save-rule UI refuses an A card after an unobserved switch to B', async () => {
  const h = createDocumentResultHarness();
  await h.win.runProofreading();
  const save = findNode(h.elements['proofreading-issues'], node => node.tag === 'button' && node.textContent === '保存为规则');
  assert.ok(save);
  h.activate(h.b, false);
  save.fire('click');
  assert.equal(h.ruleDrafts.length, 0);
  assert.match(h.win.getProofreadingStatus().text, /切回原文档/);
});

test('issue-derived rule drafts validate document identity again at submit and restore rule feedback in A', async () => {
  const h = createDocumentResultHarness();
  const { win, elements } = h;
  const storage = new Map();
  win.localStorage = {
    getItem: key => storage.get(key) || '',
    setItem: (key, value) => storage.set(key, value)
  };
  for (const id of ['fixed-rule-editor', 'fixed-rule-cancel', 'fixed-rule-pattern',
    'fixed-rule-replacement', 'fixed-rule-name', 'fixed-rule-notes', 'fixed-rule-context', 'rules-status']) {
    elements[id] = makeTaskPaneElement(id === 'fixed-rule-editor' ? 'form' : 'input');
  }
  loadBrowserScript('js/rules-center.js', win);
  loadBrowserScript('js/rules-ui.js', win);
  await win.runProofreading();
  const issue = win.captureProofreadingView().issues[0];
  assert.equal(win.openIssueRuleDraft(issue), true);
  h.activate(h.b);
  elements['fixed-rule-editor'].fire('submit', { preventDefault() {} });
  assert.equal(win.WpsRulesCenter.getRules().length, 0);
  assert.match(elements['rules-status'].textContent, /切回原文档/);
  assert.equal(win.captureProofreadingView().issues.length, 0);
  assert.equal(win.openIssueRuleDraft(issue), false);
  h.activate(h.a);
  elements['fixed-rule-editor'].fire('submit', { preventDefault() {} });
  assert.equal(win.WpsRulesCenter.getRules().length, 1);
  assert.equal(win.captureProofreadingView().issues[0].ruleSaved, true);
  const status = win.getProofreadingStatus().text;
  h.activate(h.b);
  h.activate(h.a);
  assert.equal(win.getProofreadingStatus().text, status);
  assert.equal(elements['proofreading-history'].hidden, true);
});

test('A locate toast is transient and switching A-B-A restores A persistent status without replaying it', async () => {
  const h = createDocumentResultHarness();
  const { win, elements } = h;
  const timers = new Map();
  let scheduled = 0;
  win.setTimeout = (callback, delay) => {
    assert.equal(delay, 3000);
    timers.set(++scheduled, callback);
    return scheduled;
  };
  win.clearTimeout = id => timers.delete(id);
  await win.runProofreading();
  const aStatus = win.getProofreadingStatus();
  const id = win.getWpsProofreadingState().issues[0].id;
  assert.equal(win.locateProofreadingIssue(id), true);
  assert.equal(elements['proofreading-toast'].hidden, false);
  assert.equal(scheduled, 1);
  assert.equal(timers.size, 1);
  assert.deepEqual(win.getProofreadingStatus(), aStatus);
  assert.equal(elements['proofreading-status'].textContent, aStatus.text);

  h.activate(h.b);
  win.setProofreadingStatus('B 的独立持久状态', 'warning');
  assert.equal(elements['proofreading-toast'].hidden, true);
  assert.equal(timers.size, 0);
  h.activate(h.a);
  assert.equal(elements['proofreading-toast'].hidden, true);
  assert.equal(scheduled, 1, 'returning to A must not schedule another locate toast');
  assert.equal(timers.size, 0);
  assert.deepEqual(win.getProofreadingStatus(), aStatus);
  assert.equal(elements['proofreading-status'].textContent, aStatus.text);
  assert.match(elements['proofreading-status'].className, /status-success/);
  h.activate(h.b);
  assert.equal(elements['proofreading-status'].textContent, 'B 的独立持久状态');
});

test('UI selection hook follows integration navigation without locating twice', () => {
  const h = createResultHarness();
  h.win.setProofreadingIssues([
    { id: 'a', original: '错', suggestion: '对', status: 'pending' },
    { id: 'b', original: '旧', suggestion: '新', status: 'pending' }
  ]);
  const [a, b] = h.elements['proofreading-issues'].children;
  h.win.setActiveProofreadingIssue('a');
  assert.equal(a.getAttribute('aria-expanded'), 'true');
  h.win.applyProofreadingIssue = id => {
    h.calls.push(['apply', id]);
    h.win.setActiveProofreadingIssue('b');
    return true;
  };
  findNode(a, node => node.tag === 'button' && node.textContent === '修正').fire('click');
  assert.deepEqual(h.calls, [['apply', 'a']]);
  assert.equal(a.getAttribute('aria-expanded'), 'false');
  assert.equal(b.getAttribute('aria-expanded'), 'true');
});

test('zero-result completion survives view restoration and busy resets', () => {
  const h = createResultHarness();
  h.win.beginProofreadingRun();
  h.win.setProofreadingBusy(true);
  h.win.setProofreadingStatus('校对完成 · 未发现明显问题。', 'success');
  h.win.setProofreadingBusy(false);
  const saved = h.win.captureProofreadingView();
  assert.equal(saved.runFinished, true);
  assert.equal(h.elements['proofreading-view'].getAttribute('data-finished-empty'), 'true');
  assert.match(h.elements['empty-state'].textContent, /未发现明显问题/);
  h.win.restoreProofreadingView({ issues: [] });
  h.win.setProofreadingBusy(false);
  assert.equal(h.win.captureProofreadingView().runFinished, false);
  h.win.restoreProofreadingView(saved);
  h.win.setProofreadingStatus('校对完成 · 未发现明显问题。', 'success');
  h.win.setProofreadingBusy(false);
  assert.equal(h.win.captureProofreadingView().runFinished, true);
  h.win.beginProofreadingRun();
  assert.equal(h.win.captureProofreadingView().runFinished, false);
});
