const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../js/rewrite-core.js');

const projectRoot = path.resolve(__dirname, '..');

test('rewrite action controls have the DOM id used to toggle them after replacement and undo', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'ui/taskpane.html'), 'utf8');
  assert.match(html, /<div\s+id="rewrite-result-actions"\s+class="rewrite-actions rewrite-result-actions">/);
});

function makeElement(id) {
  const listeners = {};
  return {
    id, value: '', checked: false, disabled: false, hidden: false, className: '',
    textContent: '', children: [], listeners,
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    appendChild(child) { this.children.push(child); },
    fire(type) { (listeners[type] || []).forEach((callback) => callback({})); }
  };
}

function createHarness(options = {}) {
  const elements = Object.fromEntries([
    'rewrite-status', 'rewrite-selection-count', 'run-rewrite', 'cancel-rewrite',
    'replace-rewrite', 'regenerate-rewrite', 'discard-rewrite', 'undo-rewrite',
    'rewrite-requirements', 'rewrite-result', 'rewrite-original-preview', 'rewrite-text-preview',
    'rewrite-length-summary', 'rewrite-summary-list', 'rewrite-risk', 'rewrite-risk-title',
    'rewrite-risk-list', 'rewrite-risk-confirm-row', 'rewrite-risk-confirm',
    'rewrite-completed', 'rewrite-result-actions'
  ].map((id) => [id, makeElement(id)]));
  const source = options.source || '前文。市安委办拟于2026年9月完成17项整改。后文。';
  const selectedText = options.selectedText === undefined
    ? '市安委办拟于2026年9月完成17项整改。' : options.selectedText;
  const start = source.indexOf(selectedText);
  let body = source;
  const document = {
    Name: 'test.docx', FullName: '/tmp/test.docx',
    get Content() { return { Start: 0, End: body.length }; },
    Range(from, to) {
      return {
        get Text() { return body.slice(from, to); },
        set Text(value) { body = body.slice(0, from) + String(value) + body.slice(to); }
      };
    }
  };
  const app = {
    ActiveDocument: document,
    Selection: { Range: { Text: selectedText, Start: start, End: start + selectedText.length } }
  };
  let response = JSON.stringify({ rewrittenText: '市安委办拟于2026年9月完成17项整改工作。', summary: ['理顺表达'], warnings: [] });
  let resolveModel;
  const win = {
    document: {
      readyState: 'complete',
      getElementById(id) { return elements[id] || null; },
      createElement() { return makeElement('li'); },
      addEventListener() {}
    },
    AbortController,
    WpsNativeDocument: { getApplication: () => app },
    WpsRewriteCore: core,
    WpsSettingsStore: {
      loadSettings: () => ({ provider: 'opencode', profiles: { opencode: { endpoint: 'http://127.0.0.1:4096', model: 'm' } } }),
      loadPassword: () => ''
    },
    WpsOpenCodeClient: {
      normalizeEndpoint: () => 'http://127.0.0.1:4096',
      parseModelName: () => 'm',
      request: () => options.defer ? new Promise((resolve) => { resolveModel = resolve; }) : Promise.resolve(response)
    },
    getBody: () => body,
    getResponse: () => response,
    setResponse(value) { response = value; },
    resolveModel: (value) => resolveModel && resolveModel(value),
    getResolveModel: () => resolveModel
  };
  const context = vm.createContext({ window: win, console, AbortController, Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'js/rewrite-integration.js'), 'utf8'), context);
  return { win, elements, app, document, getBody: () => body, setBody: (value) => { body = value; }, source };
}

test('rewrite generation previews only selected text and replacement can be undone safely', async () => {
  const harness = createHarness();
  const before = harness.getBody();
  assert.equal(await harness.win.generateRewrite(), true);
  assert.equal(harness.getBody(), before, 'generation must not edit the document');
  assert.equal(harness.elements['rewrite-original-preview'].textContent, '市安委办拟于2026年9月完成17项整改。');
  assert.equal(harness.elements['rewrite-text-preview'].textContent, '市安委办拟于2026年9月完成17项整改工作。');
  assert.equal(harness.win.replaceRewriteSelection(), true);
  assert.equal(harness.getBody(), '前文。市安委办拟于2026年9月完成17项整改工作。后文。');
  assert.equal(harness.elements['rewrite-completed'].hidden, false);
  assert.equal(harness.elements['rewrite-result-actions'].hidden, true);
  assert.equal(harness.win.undoRewrite(), true);
  assert.equal(harness.getBody(), before);
  assert.equal(harness.elements['rewrite-completed'].hidden, true);
  assert.equal(harness.elements['rewrite-result-actions'].hidden, false);
});

test('a failed second generation cannot pair an earlier preview with the new selection', async () => {
  const first = '甲公司拟完成17项整改。';
  const second = '乙公司拟完成18项整改。';
  const source = `前文。${first}中间。${second}后文。`;
  const harness = createHarness({ source, selectedText: first });
  harness.win.setResponse(JSON.stringify({ rewrittenText: '甲公司拟完成17项整改工作。' }));
  assert.equal(await harness.win.generateRewrite(), true);
  harness.app.Selection.Range = { Text: second, Start: source.indexOf(second), End: source.indexOf(second) + second.length };
  harness.win.setResponse('invalid JSON');
  assert.equal(await harness.win.generateRewrite(), false);
  assert.equal(harness.elements['rewrite-result'].hidden, true);
  assert.equal(harness.elements['replace-rewrite'].disabled, true);
  assert.equal(harness.win.replaceRewriteSelection(), false);
  assert.equal(harness.getBody(), source);
});

test('cancelling a second generation leaves no earlier replaceable preview', async () => {
  const first = '甲公司拟完成17项整改。';
  const second = '乙公司拟完成18项整改。';
  const source = `${first}${second}`;
  const harness = createHarness({ source, selectedText: first, defer: true });
  const firstRun = harness.win.generateRewrite();
  harness.win.resolveModel(JSON.stringify({ rewrittenText: '甲公司拟完成17项整改工作。' }));
  assert.equal(await firstRun, true);
  harness.app.Selection.Range = { Text: second, Start: source.indexOf(second), End: source.indexOf(second) + second.length };
  const secondRun = harness.win.generateRewrite();
  assert.equal(harness.elements['rewrite-result'].hidden, true);
  assert.equal(harness.win.cancelRewrite(), true);
  harness.win.resolveModel(JSON.stringify({ rewrittenText: '乙公司拟完成18项整改工作。' }));
  assert.equal(await secondRun, false);
  assert.equal(harness.win.replaceRewriteSelection(), false);
  assert.equal(harness.getBody(), source);
});

test('rewriting is unavailable without a selection and a generated result is invalidated by document edits', async () => {
  const empty = createHarness({ selectedText: '' });
  assert.equal(empty.elements['run-rewrite'].disabled, false, 'the user can click to get the no-selection prompt');
  assert.equal(await empty.win.generateRewrite(), false);
  assert.match(empty.elements['rewrite-status'].textContent, /请先选中/);

  const changed = createHarness({ defer: true });
  const generation = changed.win.generateRewrite();
  changed.setBody(changed.getBody().replace('前文', '另一段前文'));
  changed.win.resolveModel(JSON.stringify({ rewrittenText: '市安委办拟于2026年9月完成17项整改工作。' }));
  assert.equal(await generation, false);
  assert.match(changed.elements['rewrite-status'].textContent, /原文在生成改写后已发生变化/);
});

test('hard fact changes cannot be replaced and soft warnings require explicit confirmation', async () => {
  const hard = createHarness();
  hard.win.setResponse(JSON.stringify({ rewrittenText: '市安委办拟于2026年9月完成16项整改。' }));
  assert.equal(await hard.win.generateRewrite(), true);
  assert.equal(hard.elements['replace-rewrite'].disabled, true);
  assert.equal(hard.win.replaceRewriteSelection(), false);

  const soft = createHarness();
  soft.win.setResponse(JSON.stringify({ rewrittenText: '市应急管理局已要求于2026年9月完成17项整改。' }));
  assert.equal(await soft.win.generateRewrite(), true);
  assert.equal(soft.elements['replace-rewrite'].disabled, true);
  soft.elements['rewrite-risk-confirm'].checked = true;
  soft.elements['rewrite-risk-confirm'].fire('change');
  assert.equal(soft.elements['replace-rewrite'].disabled, false);

  const modelWarning = createHarness();
  modelWarning.win.setResponse(JSON.stringify({
    rewrittenText: '市安委办拟于2026年9月完成17项整改工作。',
    warnings: ['请核对责任主体']
  }));
  assert.equal(await modelWarning.win.generateRewrite(), true);
  assert.equal(modelWarning.elements['rewrite-risk-confirm-row'].hidden, false);
  assert.equal(modelWarning.elements['replace-rewrite'].disabled, true);
  assert.equal(modelWarning.win.replaceRewriteSelection(), false);
  modelWarning.elements['rewrite-risk-confirm'].checked = true;
  modelWarning.elements['rewrite-risk-confirm'].fire('change');
  assert.equal(modelWarning.elements['replace-rewrite'].disabled, false);
  assert.equal(modelWarning.win.replaceRewriteSelection(), true);
});

test('replacement and undo both reject stale text or changed surrounding anchors', async () => {
  const staleReplace = createHarness();
  assert.equal(await staleReplace.win.generateRewrite(), true);
  staleReplace.setBody(staleReplace.getBody().replace('后文', '已修改后文'));
  assert.equal(staleReplace.win.replaceRewriteSelection(), false);
  assert.match(staleReplace.elements['rewrite-status'].textContent, /原文在生成改写后已发生变化/);

  const staleUndo = createHarness();
  assert.equal(await staleUndo.win.generateRewrite(), true);
  assert.equal(staleUndo.win.replaceRewriteSelection(), true);
  staleUndo.setBody(staleUndo.getBody().replace('整改工作', '整改任务'));
  assert.equal(staleUndo.win.undoRewrite(), false);
  assert.match(staleUndo.elements['rewrite-status'].textContent, /无法安全撤销/);
});

test('rewrite selection limit is enforced before any model request', async () => {
  const text = '字'.repeat(5001);
  const harness = createHarness({ source: text, selectedText: text });
  assert.equal(await harness.win.generateRewrite(), false);
  assert.match(harness.elements['rewrite-status'].textContent, /超过 5000 字/);
});
