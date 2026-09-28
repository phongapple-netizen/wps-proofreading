const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const core = require('../js/rewrite-core.js');

test('rewrite selection requires non-empty selected text and enforces a 5000 character limit', () => {
  assert.throws(() => core.validateRewriteSelection('  '), /请先选中/);
  assert.equal(core.validateRewriteSelection(' 段落 '), ' 段落 ');
  assert.throws(() => core.validateRewriteSelection('字'.repeat(5001)), /超过 5000 字/);
});

test('rewrite guards extract numeric facts, dates, units, percentages, and bracketed titles', () => {
  const guards = core.extractRewriteGuards('2026年9月28日完成17项，金额40.06万元，比例89.82%，容量2GW和500kV，见《安全生产法》。');
  assert.deepEqual(guards.numbers, ['2026年9月28日', '17项', '40.06万元', '89.82%', '2GW', '500kV']);
  assert.deepEqual(guards.titles, ['《安全生产法》']);
});

test('hard fact changes block replacement while status, strength, and actor changes require review', () => {
  const guards = core.extractRewriteGuards('市安委办拟督促甲公司于2026年9月完成17项整改。');
  const hard = core.compareRewriteGuards(guards, '市安委办拟督促甲公司于2026年9月完成16项整改。');
  assert.equal(hard.canReplace, false);
  assert.equal(hard.requiresConfirmation, false);
  assert.match(hard.hardRisks[0].message, /17项/);

  const soft = core.compareRewriteGuards(guards, '市应急管理局已要求甲公司于2026年9月完成17项整改。');
  assert.equal(soft.hardRisks.length, 0);
  assert.equal(soft.requiresConfirmation, true);
  assert.match(soft.warnings.map((item) => item.message).join('\n'), /拟|督促|市安委办/);
});

test('rewrite prompts are independent, preserve optional requirements as data, and demand strict JSON', () => {
  const prompt = core.buildRewritePrompt('原文：拟于2026年9月完成。', '篇幅不要增加');
  assert.match(prompt, /严格 JSON/);
  assert.match(prompt, /不得新增事实/);
  assert.match(prompt, /篇幅不要增加/);
  assert.match(prompt, /2026年9月/);
  assert.throws(() => core.buildRewritePrompt('', ''), /请先选中/);
});

test('rewrite response parser accepts only a JSON object with rewrittenText', () => {
  assert.deepEqual(core.parseRewriteResponse(JSON.stringify({
    rewrittenText: '改写正文', summary: ['理顺层次'], warnings: ['核对主体']
  })), { rewrittenText: '改写正文', summary: ['理顺层次'], warnings: ['核对主体'] });
  assert.throws(() => core.parseRewriteResponse('```json\n{"rewrittenText":"x"}\n```'), /严格 JSON/);
  assert.throws(() => core.parseRewriteResponse('{"summary":[]}'), /rewrittenText/);
});

test('model warnings always require explicit review, while hard risks cannot be overridden', () => {
  const unchanged = core.compareRewriteGuards(core.extractRewriteGuards('17项任务'), '17项工作');
  assert.equal(core.summarizeRewriteRisk(unchanged, []).level, 'safe');
  assert.equal(core.summarizeRewriteRisk(unchanged, ['主体需要核实']).canReplace, false);

  const changed = core.compareRewriteGuards(core.extractRewriteGuards('17项任务'), '16项任务');
  assert.equal(core.summarizeRewriteRisk(changed, []).level, 'blocked');
  assert.equal(core.summarizeRewriteRisk(changed, []).canReplace, false);
});

test('OpenAI-compatible request builder accepts a larger rewrite response budget', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'js/proofreading-core.js'), 'utf8');
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(source, context);
  const request = context.WpsProofreadingCore.createModelRequest(
    'openai', 'https://model.example/v1/chat/completions', 'm', '', 'prompt', { maxOutputTokens: 10000 });
  assert.equal(request.body.max_tokens, 10000);
  const capped = context.WpsProofreadingCore.createModelRequest(
    'openai', 'https://model.example/v1/chat/completions', 'm', '', 'prompt', { maxOutputTokens: 50000 });
  assert.equal(capped.body.max_tokens, 16000);
});
