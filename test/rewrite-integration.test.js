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
  const source = options.source || '前文。甲公司拟于2031年4月完成12项资料整理。后文。';
  const selectedText = options.selectedText === undefined
    ? '甲公司拟于2031年4月完成12项资料整理。' : options.selectedText;
  const start = source.indexOf(selectedText);
  let body = source;
  const documentEvents = [];
  const undoTimers = [];
  const perfLogs = [];
  let failNextWrite = false;
  const document = {
    Name: 'test.docx', FullName: '/tmp/test.docx',
    get Content() { documentEvents.push('content'); return { Start: 0, End: body.length }; },
    Range(from, to) {
      documentEvents.push('range');
      return {
        get Text() { documentEvents.push('read'); return body.slice(from, to); },
        set Text(value) {
          documentEvents.push('write');
          body = body.slice(0, from) + String(value) + body.slice(to);
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('WPS write result is unknown');
          }
        }
      };
    }
  };
  const app = {
    ActiveDocument: document,
    Selection: { Range: { Text: selectedText, Start: start, End: start + selectedText.length } }
  };
  let response = JSON.stringify({ rewrittenText: '甲公司拟于2031年4月完成12项资料整理工作。', summary: ['理顺表达'], warnings: [] });
  let resolveModel;
  let requestCount = 0;
  let lastSystemPrompt = '';
  const win = {
    document: {
      readyState: 'complete',
      getElementById(id) { return elements[id] || null; },
      createElement() { return makeElement('li'); },
      addEventListener() {}
    },
    console: { info: (...args) => perfLogs.push(args) },
    location: options.devPerf ? { hostname: '127.0.0.1' } : undefined,
    setTimeout: options.manualUndoTurn ? (callback) => { undoTimers.push(callback); } : undefined,
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
      request: (requestOptions) => {
        requestCount += 1;
        lastSystemPrompt = requestOptions.systemPrompt;
        return options.defer ? new Promise((resolve) => { resolveModel = resolve; }) : Promise.resolve(response);
      }
    },
    getBody: () => body,
    getResponse: () => response,
    setResponse(value) { response = value; },
    resolveModel: (value) => resolveModel && resolveModel(value),
    getResolveModel: () => resolveModel
  };
  const context = vm.createContext({ window: win, console, AbortController, Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'js/rewrite-integration.js'), 'utf8'), context);
  return { win, elements, app, document, getBody: () => body, setBody: (value) => { body = value; },
    getRequestCount: () => requestCount, getDocumentEvents: () => documentEvents.slice(),
    getSystemPrompt: () => lastSystemPrompt,
    clearDocumentEvents: () => { documentEvents.length = 0; },
    failNextWrite: () => { failNextWrite = true; },
    flushUndoTurn: () => { const callback = undoTimers.shift(); if (callback) callback(); },
    getUndoTimerCount: () => undoTimers.length, perfLogs, source };
}

test('ordinary text and unavailable WPS selection properties remain eligible', async () => {
  const ordinary = createHarness();
  ordinary.app.Selection.Type = 2;
  ordinary.app.Selection.Tables = { Count: 0 };
  ordinary.app.Selection.InlineShapes = { Count: 0 };
  assert.equal(await ordinary.win.generateRewrite(), true);
  assert.equal(ordinary.getRequestCount(), 1);

  const legacy = createHarness();
  for (const property of ['Type', 'Tables', 'InlineShapes', 'ShapeRange']) {
    Object.defineProperty(legacy.app.Selection, property, { get() { throw new Error('unavailable'); } });
  }
  assert.equal(await legacy.win.generateRewrite(), true);
  assert.equal(legacy.getRequestCount(), 1);
});

test('table, inline shape, and non-text selections are rejected before model requests', async () => {
  for (const configure of [
    (selection) => { selection.Type = 2; selection.Tables = { Count: 1 }; },
    (selection) => { selection.Type = 2; selection.InlineShapes = { Count: 1 }; },
    (selection) => { selection.Type = 8; },
    (selection) => { selection.Type = 4; },
    (selection) => { selection.Type = 5; },
    (selection) => { selection.Type = 6; },
    (selection) => { selection.Rows = { Count: 1 }; }
  ]) {
    const harness = createHarness();
    configure(harness.app.Selection);
    assert.equal(await harness.win.generateRewrite(), false);
    assert.match(harness.elements['rewrite-status'].textContent, /当前选区包含表格、图片或非普通文本结构/);
    assert.equal(harness.getRequestCount(), 0);
  }
  const regenerate = createHarness();
  assert.equal(await regenerate.win.generateRewrite(), true);
  regenerate.app.Selection.Type = 8;
  regenerate.elements['regenerate-rewrite'].fire('click');
  assert.equal(regenerate.getRequestCount(), 1);
  assert.match(regenerate.elements['rewrite-status'].textContent, /非普通文本结构/);
});

test('rewrite does not start while proofreading or a proofreading action is busy', async () => {
  for (const state of [{ proofreading: true, actionBusy: false }, { proofreading: false, actionBusy: true }]) {
    const harness = createHarness();
    harness.win.getTaskBusyState = () => state;
    assert.equal(await harness.win.generateRewrite(), false);
    assert.equal(harness.getRequestCount(), 0);
  }
});

test('the rewrite system prompt permits restructuring while preserving facts', async () => {
  const harness = createHarness();
  assert.equal(await harness.win.generateRewrite(), true);
  const prompt = harness.getSystemPrompt();
  assert.match(prompt, /主动重组句子和段落/);
  assert.match(prompt, /不必沿用原文顺序/);
  assert.match(prompt, /不得改变事实含义/);
  assert.doesNotMatch(prompt, /宁可少改/);
});

test('rewrite generation previews only selected text and replacement can be undone safely', async () => {
  const harness = createHarness();
  const before = harness.getBody();
  assert.equal(await harness.win.generateRewrite(), true);
  assert.equal(harness.getBody(), before, 'generation must not edit the document');
  assert.equal(harness.elements['rewrite-original-preview'].textContent, '甲公司拟于2031年4月完成12项资料整理。');
  assert.equal(harness.elements['rewrite-text-preview'].textContent, '甲公司拟于2031年4月完成12项资料整理工作。');
  assert.equal(harness.win.replaceRewriteSelection(), true);
  assert.equal(harness.getBody(), '前文。甲公司拟于2031年4月完成12项资料整理工作。后文。');
  assert.equal(harness.elements['rewrite-completed'].hidden, false);
  assert.equal(harness.elements['rewrite-result-actions'].hidden, true);
  assert.equal(await harness.win.undoRewrite(), true);
  assert.equal(harness.getBody(), before);
  assert.equal(harness.elements['rewrite-completed'].hidden, true);
  assert.equal(harness.elements['rewrite-result-actions'].hidden, false);
});

test('undo writes before yielding and defers postcheck and UI work', async () => {
  const harness = createHarness({ manualUndoTurn: true, devPerf: true });
  const original = harness.getBody();
  assert.equal(await harness.win.generateRewrite(), true);
  assert.equal(harness.win.replaceRewriteSelection(), true);
  harness.clearDocumentEvents();

  const operation = harness.win.undoRewrite();
  assert.equal(harness.getBody(), original, 'the document write occurs before the timer turn');
  assert.deepEqual(harness.getDocumentEvents(), [
    'range', 'read', 'range', 'read', 'range', 'read', 'range', 'write'
  ]);
  assert.equal(harness.getUndoTimerCount(), 1);
  assert.equal(harness.elements['rewrite-completed'].hidden, false, 'UI finalization is deferred');
  assert.equal(await harness.win.undoRewrite(), false, 'a second undo cannot overlap the first');
  assert.equal(harness.win.discardRewrite(), false);

  harness.flushUndoTurn();
  assert.equal(await operation, true);
  assert.equal(harness.elements['rewrite-completed'].hidden, true);
  assert.equal(harness.elements['rewrite-result-actions'].hidden, false);
  assert.equal(await harness.win.undoRewrite(), false, 'the undo record is cleared');
  assert.equal(harness.perfLogs.length, 1);
  assert.equal(harness.perfLogs[0][0], 'rewrite undo perf:');
  for (const field of ['precheck', 'write', 'postcheck', 'ui', 'total']) {
    assert.equal(typeof harness.perfLogs[0][1][field], 'number');
  }
  assert.equal(JSON.stringify(harness.perfLogs).includes('甲公司'), false);
});

test('undo rejects changed text, either surrounding anchor, and a switched document', async () => {
  for (const change of [
    (harness) => harness.setBody(harness.getBody().replace('资料整理工作', '资料整理任务')),
    (harness) => harness.setBody(harness.getBody().replace('前文', '新前文')),
    (harness) => harness.setBody(harness.getBody().replace('后文', '新后文')),
    (harness) => { harness.app.ActiveDocument = { Name: 'other.docx', FullName: '/tmp/other.docx' }; }
  ]) {
    const harness = createHarness();
    assert.equal(await harness.win.generateRewrite(), true);
    assert.equal(harness.win.replaceRewriteSelection(), true);
    const written = harness.getBody();
    change(harness);
    const expected = harness.getBody();
    assert.equal(await harness.win.undoRewrite(), false);
    assert.equal(harness.getBody(), expected);
    assert.equal(await harness.win.undoRewrite(), false);
    assert.equal(harness.elements['rewrite-result'].hidden, true);
    assert.match(harness.elements['rewrite-status'].textContent, /无法安全撤销/);
    assert.notEqual(written, '', 'the replacement was present before the stale condition');
  }
});

test('undo does not publish success when text changes during the deferred turn', async () => {
  const harness = createHarness({ manualUndoTurn: true });
  assert.equal(await harness.win.generateRewrite(), true);
  assert.equal(harness.win.replaceRewriteSelection(), true);
  const operation = harness.win.undoRewrite();
  harness.setBody(harness.getBody().replace('12项', '13项'));
  harness.flushUndoTurn();
  assert.equal(await operation, false);
  assert.equal(await harness.win.undoRewrite(), false);
  assert.equal(harness.elements['rewrite-result'].hidden, true);
  assert.match(harness.elements['rewrite-status'].textContent, /未能验证撤销结果/);
});

test('an unconfirmed undo write invalidates the undo record', async () => {
  const harness = createHarness();
  assert.equal(await harness.win.generateRewrite(), true);
  assert.equal(harness.win.replaceRewriteSelection(), true);
  harness.failNextWrite();
  assert.equal(await harness.win.undoRewrite(), false);
  assert.equal(await harness.win.undoRewrite(), false);
  assert.equal(harness.elements['rewrite-result'].hidden, true);
  assert.match(harness.elements['rewrite-status'].textContent, /未能验证撤销结果/);
});

test('a failed second generation cannot pair an earlier preview with the new selection', async () => {
  const first = '甲公司拟完成12项资料整理。';
  const second = '乙公司拟完成13项资料整理。';
  const source = `前文。${first}中间。${second}后文。`;
  const harness = createHarness({ source, selectedText: first });
  harness.win.setResponse(JSON.stringify({ rewrittenText: '甲公司拟完成12项资料整理工作。' }));
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
  const first = '甲公司拟完成12项资料整理。';
  const second = '乙公司拟完成13项资料整理。';
  const source = `${first}${second}`;
  const harness = createHarness({ source, selectedText: first, defer: true });
  const firstRun = harness.win.generateRewrite();
  harness.win.resolveModel(JSON.stringify({ rewrittenText: '甲公司拟完成12项资料整理工作。' }));
  assert.equal(await firstRun, true);
  harness.app.Selection.Range = { Text: second, Start: source.indexOf(second), End: source.indexOf(second) + second.length };
  const secondRun = harness.win.generateRewrite();
  assert.equal(harness.elements['rewrite-result'].hidden, true);
  assert.equal(harness.win.cancelRewrite(), true);
  harness.win.resolveModel(JSON.stringify({ rewrittenText: '乙公司拟完成13项资料整理工作。' }));
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
  changed.win.resolveModel(JSON.stringify({ rewrittenText: '甲公司拟于2031年4月完成12项资料整理工作。' }));
  assert.equal(await generation, false);
  assert.match(changed.elements['rewrite-status'].textContent, /原文在生成改写后已发生变化/);
});

test('hard fact changes cannot be replaced and soft warnings require explicit confirmation', async () => {
  const hard = createHarness();
  hard.win.setResponse(JSON.stringify({ rewrittenText: '甲公司拟于2031年4月完成11项资料整理。' }));
  assert.equal(await hard.win.generateRewrite(), true);
  assert.equal(hard.elements['replace-rewrite'].disabled, true);
  assert.equal(hard.win.replaceRewriteSelection(), false);

  const soft = createHarness();
  soft.win.setResponse(JSON.stringify({ rewrittenText: '乙公司已要求于2031年4月完成12项资料整理。' }));
  assert.equal(await soft.win.generateRewrite(), true);
  assert.equal(soft.elements['replace-rewrite'].disabled, true);
  soft.elements['rewrite-risk-confirm'].checked = true;
  soft.elements['rewrite-risk-confirm'].fire('change');
  assert.equal(soft.elements['replace-rewrite'].disabled, false);

  const modelWarning = createHarness();
  modelWarning.win.setResponse(JSON.stringify({
    rewrittenText: '甲公司拟于2031年4月完成12项资料整理工作。',
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
  staleUndo.setBody(staleUndo.getBody().replace('资料整理工作', '资料整理任务'));
  assert.equal(await staleUndo.win.undoRewrite(), false);
  assert.match(staleUndo.elements['rewrite-status'].textContent, /无法安全撤销/);
});

test('rewrite selection limit is enforced before any model request', async () => {
  const text = '字'.repeat(5001);
  const harness = createHarness({ source: text, selectedText: text });
  assert.equal(await harness.win.generateRewrite(), false);
  assert.match(harness.elements['rewrite-status'].textContent, /超过 5000 字/);
});
