const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../js/proofreading-core.js");

test("paragraph splitting preserves WPS offsets across CRLF and blank paragraphs", () => {
    const text = "前段。\r\n\r后段。";
    assert.deepEqual(core.splitIntoParagraphs(text), [
        { paragraphIndex: 1, text: "前段。", offset: 0 },
        { paragraphIndex: 3, text: "后段。", offset: 6 }
    ]);
});

test("model issues must be strict JSON and uncertain confidence stays review-only", () => {
    assert.throws(() => core.parseIssues("```json\n{\"issues\":[]}\n```"), /严格 JSON/);
    const issues = core.parseIssues(JSON.stringify({ issues: [
        { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "正字" },
        { category: "unknown", paragraphIndex: 1, original: "甲", suggestion: "乙", confidence: 1 },
        { category: "grammar", paragraphIndex: 1, original: "多行", suggestion: "多\n行", confidence: 0.9 }
    ] }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].confidence, 0);
    assert.equal(issues[0].needsReview, true);
});

test("issue offsets are mapped only for a unique exact excerpt", () => {
    const paragraphs = core.splitIntoParagraphs("前面有错字，后面还有错字。\r第二段有待改内容。\r");
    const issues = [
        { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "正字", reason: "重复", confidence: 0.9, needsReview: false },
        { category: "wording", paragraphIndex: 2, original: "待改", suggestion: "修改", reason: "用词", confidence: 0.8, needsReview: false }
    ];
    const mapped = core.mapIssuesToRanges(paragraphs, issues, 100);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].start, 100 + paragraphs[1].offset + "第二段有".length);
    assert.equal(mapped[0].end, mapped[0].start + 2);
});

test("applying one finding shifts later findings and invalidates overlaps", () => {
    const issues = [
        { id: "first", start: 10, end: 12, status: "pending" },
        { id: "overlap", start: 11, end: 13, status: "pending" },
        { id: "later", start: 20, end: 22, status: "pending" }
    ];
    const updated = core.shiftIssuesAfterReplacement(issues, "first", 10, 12, 4);
    assert.equal(updated[0].status, "accepted");
    assert.equal(updated[1].status, "stale");
    assert.deepEqual([updated[2].start, updated[2].end], [22, 24]);
    assert.deepEqual([issues[2].start, issues[2].end], [20, 22]);
});

test("Ollama and OpenAI-compatible requests keep credentials out of URLs and bodies", () => {
    const ollama = core.createModelRequest("ollama", "http://127.0.0.1:11434/", "qwen", "secret", "prompt");
    assert.equal(ollama.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(ollama.headers.Authorization, undefined);
    assert.equal(JSON.stringify(ollama.body).includes("secret"), false);

    const openai = core.createModelRequest("openai", "https://model.example/v1/chat/completions", "model", "secret", "prompt");
    assert.equal(openai.headers.Authorization, "Bearer secret");
    assert.equal(JSON.stringify(openai.body).includes("secret"), false);
    assert.throws(() => core.createModelRequest("openai", "https://model.example/v1", "model", "", "prompt"), /完整的 Chat Completions/);
});

test("deep enhancement appends stricter instructions and default prompt stays unchanged", () => {
    const paragraphs = [{ paragraphIndex: 1, text: "前段。" }];
    const normal = core.buildPrompt(paragraphs);
    const deep = core.buildPrompt(paragraphs, { deep: true });

    assert.match(normal, /只返回严格 JSON/);
    assert.equal(normal.includes("深度增强"), false);
    assert.match(deep, /已开启深度增强/);
    assert.match(deep, /歧义/);
    assert.equal(deep.includes(normal.split("格式：")[0]), true);
    assert.equal(normal === core.buildPrompt(paragraphs, { deep: false }), true);
});

test("AI prompt receives local rule context without changing the plain prompt", () => {
    const paragraphs = [{ paragraphIndex: 1, text: "请使用旧名称。" }];
    const plain = core.buildPrompt(paragraphs, { deep: false });
    const aware = core.buildPrompt(paragraphs, {
        deep: false,
        ruleContext: [{
            original: "旧名称",
            suggestion: "新名称",
            ruleName: "单位名称规范",
            source: "单位规范",
            confirmed: true,
            review: false
        }]
    });

    assert.equal(plain.includes("本地规则上下文"), false);
    assert.match(aware, /本地规则引擎已经在本批文字中命中/);
    assert.match(aware, /单位名称规范/);
    assert.match(aware, /confirmed=true/);
    assert.match(aware, /禁止重复报告/);
});

test("request failures do not echo endpoint credentials or response bodies", async () => {
    await assert.rejects(
        core.requestModel({ provider: "openai", endpoint: "https://model.example/v1/chat/completions", model: "m", apiKey: "top-secret" }, "p", async () => {
            throw new Error("top-secret");
        }),
        (error) => error.message.includes("top-secret") === false && error.message.includes("连接模型服务失败")
    );
});

test("batching keeps whole paragraphs and respects the batch character budget", () => {
    const paragraphs = [
        { paragraphIndex: 1, text: "短段落。", offset: 0 },
        { paragraphIndex: 2, text: "长".repeat(1500), offset: 5 },
        { paragraphIndex: 3, text: "又是长".repeat(600), offset: 1510 },
        { paragraphIndex: 4, text: "结尾段落。", offset: 4000 }
    ];

    const batches = core.batchParagraphs(paragraphs, 2000);
    assert.equal(batches.length >= 2, true);
    assert.deepEqual(batches.flat().map((item) => item.paragraphIndex), [1, 2, 3, 4]);
    batches.forEach((batch) => {
        const total = batch.reduce((sum, item) => sum + item.text.length, 0);
        assert.equal(total <= 2000 || batch.length === 1, true);
    });

    assert.deepEqual(core.batchParagraphs([], 2000), []);
    assert.equal(core.defaultBatchCharacters, 2500);
    assert.equal(core.maxDocumentCharacters, 80000);
});

test("document validation reports empty and oversized documents in Chinese", () => {
    assert.throws(() => core.validateDocument("   \r\n "), /没有可校对的文字/);
    assert.throws(() => core.validateDocument("字".repeat(core.maxDocumentCharacters + 1)), /80000/);
    assert.equal(core.validateDocument("正常正文"), "正常正文");
});


test("a single oversized paragraph is segmented without losing text or offsets", () => {
    const source = "开头。" + "长句内容，".repeat(900) + "结尾。";
    const paragraphs = [{ paragraphIndex: 7, text: source, offset: 120 }];
    const batches = core.batchParagraphs(paragraphs, 1000);
    const segments = batches.flat();

    assert.equal(segments.length > 1, true);
    assert.equal(segments.map((item) => item.text).join(""), source);
    assert.equal(segments.every((item) => item.text.length <= 1000), true);
    assert.equal(segments.every((item) => item.sourceParagraphIndex === 7), true);
    assert.equal(segments[0].offset, 120);

    for (let index = 1; index < segments.length; index += 1) {
        assert.equal(
            segments[index].offset,
            segments[index - 1].offset + segments[index - 1].text.length
        );
    }

    batches.forEach((batch) => {
        const total = batch.reduce((sum, item) => sum + item.text.length, 0);
        assert.equal(total <= 1000, true);
    });
});

test("consistency index is compact and consistency findings are always review-only", () => {
    const paragraphs = core.splitIntoParagraphs(
        "一、工作安排\r\n" +
        "市安委办负责统筹，《安全生产工作方案》于9月20日印发。\r\n" +
        "市安委会办公室负责协调，《安全生产工作方案》于9月21日印发。"
    );
    const index = core.buildConsistencyIndex(paragraphs);

    assert.equal(index.entries.length >= 2, true);
    assert.equal(core.hasCrossParagraphConsistency(index), true);
    assert.equal(JSON.stringify(index).length <= core.maxConsistencyIndexCharacters + 2000, true);

    const prompt = core.buildConsistencyPrompt(index);
    assert.match(prompt, /第二遍跨段落一致性复核/);
    assert.match(prompt, /needsReview 必须为 true/);

    const parsed = core.parseConsistencyIssues(JSON.stringify({
        issues: [{
            category: "consistency",
            paragraphIndex: 3,
            original: "市安委会办公室",
            suggestion: "市安委办",
            reason: "与第2段称谓不一致",
            confidence: 0.96,
            needsReview: false
        }, {
            category: "typo",
            paragraphIndex: 2,
            original: "统筹",
            suggestion: "统等",
            confidence: 0.99,
            needsReview: false
        }]
    }));

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].category, "consistency");
    assert.equal(parsed[0].needsReview, true);
});
