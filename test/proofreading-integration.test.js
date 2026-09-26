const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const coreSource = fs.readFileSync(path.join(projectRoot, "js/proofreading-core.js"), "utf8");
const storeSource = fs.readFileSync(path.join(projectRoot, "js/settings-store.js"), "utf8");
const rulesSource = fs.readFileSync(path.join(projectRoot, "js/rules-center.js"), "utf8");
const integrationSource = fs.readFileSync(path.join(projectRoot, "js/proofreading-integration.js"), "utf8");

const SETTINGS_KEY = "wps_text_proofreading_model_settings_v1";
const RUNTIME_ENDPOINT_KEY = "wps_text_proofreading_runtime_endpoint_v1";
const PASSWORD_KEY = "wps_text_proofreading_runtime_password_v1";

const DEFAULT_SETTINGS = {
    provider: "ollama",
    deep: false,
    profiles: {
        ollama: { endpoint: "http://127.0.0.1:11434", model: "qwen3:8b" },
        opencode: { endpoint: "http://127.0.0.1:4096", model: "opencode/mimo-v2.6-flash-free" },
        openai: { endpoint: "", model: "" }
    }
};

function createHarness(options = {}) {
    const selectedText = options.selectedText || "本段有错字。";
    const prefix = "机密前文。";
    const suffix = "机密后文。";
    const start = prefix.length;
    let documentText = prefix + selectedText + suffix;
    let selectedRange = null;
    let contentReads = 0;
    const storage = new Map();
    storage.set(SETTINGS_KEY, options.seed || JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, {
        deep: options.deep === true
    })));
    if (options.runtimeEndpoint) storage.set(RUNTIME_ENDPOINT_KEY, options.runtimeEndpoint);
    const modelIssues = options.issues || [
        {
            category: "typo",
            paragraphIndex: 1,
            original: "错字",
            suggestion: "错别字",
            reason: "用词错误",
            confidence: 0.95,
            needsReview: false
        }
    ];
    const document = {
        Name: "测试文档.docx",
        FullName: "C:\\temp\\测试文档.docx",
        get Content() {
            contentReads += 1;
            if (options.requireSelection) throw new Error("whole document must not be read");
            return { Text: documentText, Start: 0, End: documentText.length };
        },
        Range(rangeStart, rangeEnd) {
            return {
                Start: rangeStart,
                End: rangeEnd,
                get Text() { return documentText.slice(rangeStart, rangeEnd); },
                set Text(value) {
                    documentText = documentText.slice(0, rangeStart) + String(value) + documentText.slice(rangeEnd);
                },
                Select() {
                    selectedRange = [rangeStart, rangeEnd];
                }
            };
        }
    };
    const selection = {
        get Range() {
            if (options.noSelection) return document.Range(0, 0);
            return document.Range(start, start + selectedText.length);
        }
    };
    let renderedIssues = [];
    let status = { text: "", tone: "idle" };
    const statuses = [];
    const requests = [];
    const records = [];
    const progress = [];
    const confirmMessages = [];
    let busyValue = false;

    const windowObject = {
        Application: { ActiveDocument: document, Selection: selection },
        WpsNativeDocument: {
            getApplication: () => windowObject.Application,
            getPluginStorage: () => ({
                getItem: (key) => storage.get(key) || "",
                setItem: (key, value) => storage.set(key, value)
            })
        },
        document: {
            readyState: "complete",
            getElementById: () => null
        },
        fetch: async (url, requestOptions) => {
            const body = requestOptions && requestOptions.body ? JSON.parse(requestOptions.body) : null;
            requests.push({ url, options: requestOptions, body });
            const requestIndex = requests.length - 1;
            const responseIssues = typeof options.issuesForRequest === "function"
                ? options.issuesForRequest({ url, options: requestOptions, body, requestIndex })
                : modelIssues;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    message: {
                        content: JSON.stringify({ issues: responseIssues || [] })
                    }
                })
            };
        },
        setProofreadingStatus: (value) => { status = value; statuses.push(value); },
        setProofreadingIssues: (value) => { renderedIssues = value; },
        clearProofreadingIssues: () => { renderedIssues = []; },
        setProofreadingProgress: (percent, label) => { progress.push({ percent, label: label || "" }); },
        setProofreadingBusy: (value) => { busyValue = value === true; },
        pushProofreadingRecord: (record) => { records.push(record); return true; },
        confirm: (message) => {
            confirmMessages.push(String(message));
            return options.confirmFullDocument !== false;
        }
    };

    const context = vm.createContext({ window: windowObject, URL, setTimeout, clearTimeout });
    vm.runInContext(coreSource, context, { filename: "proofreading-core.js" });
    vm.runInContext(storeSource, context, { filename: "settings-store.js" });
    vm.runInContext(rulesSource, context, { filename: "rules-center.js" });
    (options.rules || []).forEach((rule) => {
        windowObject.WpsRulesCenter.saveRule(rule);
    });
    if (options.password) {
        windowObject.WpsSettingsStore.savePassword(
            options.password,
            options.passwordProvider || "opencode"
        );
    }
    vm.runInContext(integrationSource, context, { filename: "proofreading-integration.js" });

    return {
        window: windowObject,
        readDocument: () => documentText,
        changeDocument: (value) => { documentText = value; },
        selectedText,
        prefix,
        suffix,
        get contentReads() { return contentReads; },
        get selectedRange() { return selectedRange; },
        get storedSettings() { return storage.get(SETTINGS_KEY) || ""; },
        get runtimeEndpoint() { return storage.get(RUNTIME_ENDPOINT_KEY) || ""; },
        get storageDump() { return Array.from(storage.values()).join("\n"); },
        get confirmMessages() { return confirmMessages.slice(); },
        get sentRequest() { return requests[requests.length - 1]; },
        get requests() { return requests; },
        get renderedIssues() { return renderedIssues; },
        get status() { return status; },
        get statuses() { return statuses; },
        get records() { return records; },
        get progress() { return progress; },
        get busy() { return busyValue; }
    };
}

test("only selected text is sent and a verified suggestion updates the WPS range", async () => {
    const harness = createHarness({ requireSelection: true });
    await harness.window.runProofreading();

    assert.equal(harness.sentRequest.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(JSON.stringify(harness.sentRequest.body).includes(harness.selectedText), true);
    assert.equal(JSON.stringify(harness.sentRequest.body).includes("机密前文"), false);
    assert.equal(JSON.stringify(harness.sentRequest.body).includes("机密后文"), false);
    assert.equal(harness.contentReads, 0);
    assert.equal(harness.renderedIssues.length, 1);

    const id = harness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(harness.window.applyProofreadingIssue(id), true);
    assert.equal(harness.readDocument(), harness.prefix + "本段有错别字。" + harness.suffix);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "accepted");
});

test("a finding can be located and ignored without changing document text", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];

    assert.equal(harness.window.locateProofreadingIssue(issue.id), true);
    assert.deepEqual(harness.selectedRange, [issue.start, issue.end]);
    assert.equal(harness.window.ignoreProofreadingIssue(issue.id), true);
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "ignored");
});

test("a changed document is left untouched when an old suggestion is applied", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    const edited = harness.prefix + "本段已人工改过。" + harness.suffix;
    harness.changeDocument(edited);

    assert.equal(harness.window.applyProofreadingIssue(id), false);
    assert.equal(harness.readDocument(), edited);
    assert.equal(harness.status.tone, "warning");
});

test("edits after the selected range do not invalidate safe positions", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    harness.changeDocument(harness.prefix + harness.selectedText + "新增的文末内容。" );

    assert.equal(harness.window.applyProofreadingIssue(id), true);
    assert.equal(harness.readDocument(), harness.prefix + "本段有错别字。" + "新增的文末内容。");
});

test("edits before the selected range invalidate old offsets", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    harness.changeDocument("机密前文已变化。" + harness.selectedText + harness.suffix);

    assert.equal(harness.window.applyProofreadingIssue(id), false);
    assert.equal(harness.readDocument(), "机密前文已变化。" + harness.selectedText + harness.suffix);
});

test("credential-like endpoint data is rejected by the settings store", () => {
    const harness = createHarness();
    const store = harness.window.WpsSettingsStore;

    assert.equal(store.saveRuntimeEndpoint("opencode", "https://models.example/v1/chat/completions?api_key=private-value"), false);
    store.updateSettings({ provider: "opencode", profile: { endpoint: "https://models.example/v1/chat/completions?api_key=private-value" } });

    assert.equal(harness.storedSettings.includes("private-value"), false);
    assert.equal(harness.storedSettings.includes("models.example"), false);
    assert.equal(harness.runtimeEndpoint.includes("private-value"), false);
});

test("one-click fix applies every pending suggestion after verifying each original", async () => {
    const harness = createHarness({
        issues: [
            { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字", reason: "用词错误", confidence: 0.95, needsReview: false },
            { category: "wording", paragraphIndex: 1, original: "本段", suggestion: "该段", reason: "用词重复", confidence: 0.9, needsReview: false }
        ]
    });
    await harness.window.runProofreading();
    assert.equal(harness.window.getWpsProofreadingState().issues.length, 2);

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 2);
    assert.equal(result.failed, 0);
    assert.equal(harness.readDocument(), harness.prefix + "该段有错别字。" + harness.suffix);
    assert.equal(harness.window.getWpsProofreadingState().issues.every((issue) => issue.status === "accepted"), true);
    assert.equal(harness.records.filter((record) => record.action === "applied").length, 2);
    assert.equal(harness.status.text.includes("已一键修正 2 条"), true);
});

test("one-click fix skips review-only and low-confidence suggestions", async () => {
    const harness = createHarness({
        selectedText: "本段有错字，也有可疑表述。",
        issues: [
            { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字", reason: "明确错字", confidence: 0.98, needsReview: false },
            { category: "wording", paragraphIndex: 1, original: "可疑表述", suggestion: "建议表述", reason: "需要人工判断语境", confidence: 0.99, needsReview: true },
            { category: "grammar", paragraphIndex: 1, original: "本段", suggestion: "该段", reason: "置信度不足", confidence: 0.72, needsReview: false }
        ]
    });
    await harness.window.runProofreading();

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 1);
    assert.equal(result.skipped, 2);
    assert.equal(harness.readDocument(), harness.prefix + "本段有错别字，也有可疑表述。" + harness.suffix);

    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.find((issue) => issue.original === "错字").status, "accepted");
    assert.equal(issues.find((issue) => issue.original === "可疑表述").status, "pending");
    assert.equal(issues.find((issue) => issue.original === "本段").status, "pending");
    assert.match(harness.status.text, /另有 2 条/);
});

test("one-click fix stops without writing when the document changed first", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const edited = harness.prefix + "本段已人工改过。" + harness.suffix;
    harness.changeDocument(edited);

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 0);
    assert.equal(harness.readDocument(), edited);
    assert.equal(harness.window.getWpsProofreadingState().issues.every((issue) => issue.status === "stale"), true);
});

test("ignoring a finding records history without touching the document", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];

    assert.equal(harness.window.ignoreProofreadingIssue(issue.id), true);
    assert.equal(harness.records.length, 1);
    assert.equal(harness.records[0].action, "ignored");
    assert.equal(typeof harness.records[0].runId, "number");
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
});

test("the deep enhancement setting adds stricter instructions to the prompt", async () => {
    const harness = createHarness({ deep: true });
    await harness.window.runProofreading();

    assert.equal(JSON.stringify(harness.sentRequest.body).includes("已开启深度增强"), true);
    assert.equal(harness.storedSettings.includes("\"deep\":true"), true);
});

test("the deep enhancement flag is read back from saved settings", () => {
    const harness = createHarness({
        seed: JSON.stringify({ provider: "ollama", deep: true, profiles: {} })
    });

    assert.equal(harness.window.WpsSettingsStore.loadSettings().deep, true);
    assert.equal(harness.window.getWpsProofreadingState().provider, "ollama");
});

test("an empty selection requires explicit confirmation before proofreading the whole document", async () => {
    const harness = createHarness({ noSelection: true });
    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(harness.confirmMessages.length, 1);
    assert.match(harness.confirmMessages[0], /将校对全文/);
    assert.match(harness.confirmMessages[0], /Ollama/);
    assert.equal(harness.contentReads >= 1, true);
    assert.equal(JSON.stringify(harness.sentRequest.body).includes(harness.readDocument()), true);
    assert.equal(harness.statuses.some((entry) => String(entry.text).includes("全文")), true);
    assert.equal(harness.status.tone, "success");
    assert.equal(harness.progress.some((entry) => entry.percent === 100), true);
    assert.equal(harness.busy, false);
});

test("declining whole-document confirmation sends no model request", async () => {
    const harness = createHarness({ noSelection: true, confirmFullDocument: false });
    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "full-document-not-confirmed");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.confirmMessages.length, 1);
    assert.match(harness.status.text, /没有发送/);
    assert.equal(harness.busy, false);
});

test("long content is split into batches with real progress reporting", async () => {
    const paragraphs = [];
    for (let index = 0; index < 12; index += 1) {
        paragraphs.push("第" + index + "段" + "校对测试句子".repeat(60) + "错字。");
    }
    const harness = createHarness({ selectedText: paragraphs.join("\n") });
    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(result.batches >= 2, true);
    assert.equal(harness.requests.length, result.batches);

    const percents = harness.progress.map((entry) => entry.percent);
    assert.equal(percents[percents.length - 1], 100);
    assert.equal(percents.every((value, index) => index === 0 || value >= percents[index - 1]), true);
    assert.equal(harness.busy, false);
});


test("first-pass progress is weighted by processed characters rather than batch count", async () => {
    const selectedText = [
        "甲".repeat(499) + "。",
        "乙".repeat(2399) + "。",
        "丙".repeat(99) + "。"
    ].join("\n");
    const harness = createHarness({ selectedText, issues: [] });

    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(result.batches, 2);

    const firstBatch = harness.progress.find((entry) =>
        String(entry.label).includes("第 1/2 批"));
    assert.ok(firstBatch);
    assert.equal(firstBatch.percent, 17);
    assert.match(firstBatch.label, /已处理 500\/3000 字/);

    const secondBatch = harness.progress.find((entry) =>
        String(entry.label).includes("第 2/2 批"));
    assert.ok(secondBatch);
    assert.equal(secondBatch.percent, 100);
    assert.match(secondBatch.label, /已处理 3000\/3000 字/);
});

test("runtime secrets and external endpoints are provider-scoped and memory-only", () => {
    const harness = createHarness();
    const store = harness.window.WpsSettingsStore;

    assert.equal(store.savePassword("opencode-secret", "opencode"), true);
    assert.equal(store.savePassword("openai-secret", "openai"), true);
    assert.equal(store.loadPassword("opencode"), "opencode-secret");
    assert.equal(store.loadPassword("openai"), "openai-secret");
    assert.equal(store.loadPassword("ollama"), "");

    assert.equal(store.saveRuntimeEndpoint("openai", "https://models.example/v1/chat/completions"), true);
    assert.equal(store.loadRuntimeEndpoint("openai").endpoint, "https://models.example/v1/chat/completions");
    assert.equal(store.loadRuntimeEndpoint("opencode"), null);

    assert.equal(harness.storageDump.includes("opencode-secret"), false);
    assert.equal(harness.storageDump.includes("openai-secret"), false);
    assert.equal(harness.storageDump.includes("models.example"), false);

    store.clearPassword("opencode");
    assert.equal(store.loadPassword("opencode"), "");
    assert.equal(store.loadPassword("openai"), "openai-secret");
});


test("multi-batch proofreading runs a second consistency pass and keeps its findings review-only", async () => {
    const first = "市安委办负责统筹。" + "第一部分工作内容。".repeat(180);
    const second = "市安委会办公室负责统筹。" + "第二部分工作内容。".repeat(180);
    const harness = createHarness({
        selectedText: first + "\n" + second,
        issuesForRequest: ({ body }) => {
            const prompt = body && body.messages && body.messages[0] && body.messages[0].content || "";
            if (prompt.includes("第二遍跨段落一致性复核")) {
                return [{
                    category: "consistency",
                    paragraphIndex: 2,
                    original: "市安委会办公室",
                    suggestion: "市安委办",
                    reason: "与第1段机构称谓不一致，需核实正式名称后统一",
                    confidence: 0.97,
                    needsReview: false
                }];
            }
            return [];
        }
    });

    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(result.batches >= 2, true);
    assert.equal(result.consistencyAttempted, true);
    assert.equal(result.consistencyCompleted, true);
    assert.equal(harness.requests.length, result.batches + 1);

    const consistencyProgress = harness.progress.find((entry) =>
        String(entry.label).includes("全文一致性复核中"));
    assert.ok(consistencyProgress);
    assert.equal(consistencyProgress.percent, 85);
    assert.equal(harness.progress.some((entry) => entry.percent === 90), false);

    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].category, "consistency");
    assert.equal(issues[0].needsReview, true);

    const before = harness.readDocument();
    const applyAll = harness.window.applyAllProofreadingIssues();
    assert.equal(applyAll.applied, 0);
    assert.equal(applyAll.skipped, 1);
    assert.equal(harness.readDocument(), before);
});

test("consistency-pass failure keeps completed first-pass findings", async () => {
    const first = "第一段由市安委办统筹，有错字。" + "第一部分工作内容。".repeat(180);
    const second = "第二段由市安委会办公室协调。" + "第二部分工作内容。".repeat(180);
    let call = 0;
    const harness = createHarness({
        selectedText: first + "\n" + second,
        issuesForRequest: ({ body }) => {
            const prompt = body && body.messages && body.messages[0] && body.messages[0].content || "";
            if (prompt.includes("第二遍跨段落一致性复核")) return [];
            call += 1;
            return call === 1 ? [{
                category: "typo",
                paragraphIndex: 1,
                original: "错字",
                suggestion: "错别字",
                reason: "明确错字",
                confidence: 0.98,
                needsReview: false
            }] : [];
        }
    });

    // Make the consistency response invalid without affecting the first-pass responses.
    const originalRequest = harness.window.WpsProofreadingCore.requestModel;
    let modelCall = 0;
    harness.window.WpsProofreadingCore.requestModel = async function (requestOptions, prompt, fetchImpl) {
        modelCall += 1;
        if (String(prompt).includes("第二遍跨段落一致性复核")) return "not-json";
        return originalRequest(requestOptions, prompt, fetchImpl);
    };

    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(result.consistencyAttempted, true);
    assert.equal(result.consistencyCompleted, false);
    assert.match(result.consistencyWarning, /严格 JSON/);
    assert.equal(harness.window.getWpsProofreadingState().issues.some((issue) => issue.original === "错字"), true);
    assert.equal(harness.status.tone, "warning");
});


test("local rules run before AI and safe rule findings can be one-click fixed", async () => {
    const harness = createHarness({
        selectedText: "请使用旧名称开展工作。",
        issues: [],
        rules: [{
            id: "unit-name",
            name: "单位名称规范",
            group: "单位规范",
            type: "replace",
            pattern: "旧名称",
            replacement: "新名称",
            autoFix: true,
            priority: 100,
            source: "单位规范"
        }]
    });

    const result = await harness.window.runProofreading();
    assert.equal(result.accepted, true);
    assert.equal(harness.statuses.some((item) => /本地规则扫描完成/.test(item.text)), true);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("本地规则上下文"), true);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("单位名称规范"), true);

    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].category, "rule");
    assert.equal(issues[0].needsReview, false);
    assert.equal(issues[0].actionable, true);

    const applied = harness.window.applyAllProofreadingIssues();
    assert.equal(applied.applied, 1);
    assert.equal(harness.readDocument(), harness.prefix + "请使用新名称开展工作。" + harness.suffix);
});

test("reminder-only rules can be located and ignored but never written", async () => {
    const harness = createHarness({
        selectedText: "本措施可以保证绝对安全。",
        issues: [],
        rules: [{
            id: "reminder",
            name: "绝对化表述提醒",
            type: "reminder",
            pattern: "绝对安全",
            replacement: "",
            source: "单位规范",
            notes: "建议人工核实是否属于绝对化表述。"
        }]
    });

    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];

    assert.equal(issue.actionable, false);
    assert.equal(harness.window.locateProofreadingIssue(issue.id), true);
    assert.deepEqual(harness.selectedRange, [issue.start, issue.end]);
    assert.equal(harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);

    const batch = harness.window.applyAllProofreadingIssues();
    assert.equal(batch.applied, 0);
    assert.equal(batch.skipped, 1);

    assert.equal(harness.window.ignoreProofreadingIssue(issue.id), true);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "ignored");
});

test("conflicting rule and AI suggestions become one review-only finding", async () => {
    const harness = createHarness({
        selectedText: "旧名称需要统一。",
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "旧名称",
            suggestion: "模型建议",
            reason: "模型润色",
            confidence: 0.99,
            needsReview: false
        }],
        rules: [{
            id: "priority-rule",
            name: "正式名称",
            type: "replace",
            pattern: "旧名称",
            replacement: "规则建议",
            autoFix: true,
            priority: 100
        }]
    });

    await harness.window.runProofreading();
    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].category, "rule");
    assert.equal(issues[0].suggestion, "规则建议");
    assert.equal(issues[0].origin, "rule+ai");
    assert.equal(issues[0].aiConflict, true);
    assert.equal(issues[0].needsReview, true);

    const batch = harness.window.applyAllProofreadingIssues();
    assert.equal(batch.applied, 0);
    assert.equal(batch.skipped, 1);
});

test("matching rule and AI suggestions are merged and classified by the AI issue type", async () => {
    const harness = createHarness({
        selectedText: "请使用旧名称开展工作。",
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "旧名称",
            suggestion: "新名称",
            reason: "名称应统一",
            confidence: 0.98,
            needsReview: false
        }],
        rules: [{
            id: "same-rule",
            name: "单位名称规范",
            type: "replace",
            pattern: "旧名称",
            replacement: "新名称",
            autoFix: true,
            priority: 100,
            source: "单位规范"
        }]
    });

    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];

    assert.equal(harness.window.getWpsProofreadingState().issues.length, 1);
    assert.equal(issue.category, "wording");
    assert.equal(issue.origin, "rule+ai");
    assert.equal(issue.confirmedByAI, true);
    assert.equal(issue.aiConflict, undefined);
    assert.match(issue.reason, /本地规则与 AI 判断一致/);
});

test("a reminder rule and an AI suggestion are combined into one contextual review finding", async () => {
    const harness = createHarness({
        selectedText: "这里使用高空作业表述。",
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "高空作业",
            suggestion: "高处作业",
            reason: "专业材料通常使用高处作业",
            confidence: 0.95,
            needsReview: false
        }],
        rules: [{
            id: "height-term",
            name: "高空作业术语核对",
            type: "reminder",
            pattern: "高空作业",
            replacement: "高处作业",
            source: "专业术语"
        }]
    });

    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];

    assert.equal(harness.window.getWpsProofreadingState().issues.length, 1);
    assert.equal(issue.category, "wording");
    assert.equal(issue.origin, "rule+ai");
    assert.equal(issue.suggestion, "高处作业");
    assert.equal(issue.actionable === false, false);
    assert.equal(issue.needsReview, true);
    assert.equal(issue.ruleName, "高空作业术语核对");
});


test("AI review rules stay invisible when the model decides the trigger is valid in context", async () => {
    const harness = createHarness({
        selectedText: "引用原文写道：高空作业是历史文件中的称谓。",
        issues: [],
        rules: [{
            id: "height-context",
            name: "高空作业术语核查",
            type: "ai_review",
            pattern: "高空作业",
            matchMode: "literal",
            replacement: "高处作业",
            instruction: "若为历史原文引用不要修改；只有规范性专业表述才建议使用高处作业。",
            source: "专业术语",
            priority: 90
        }]
    });

    const result = await harness.window.runProofreading();
    assert.equal(result.accepted, true);
    assert.equal(harness.window.getWpsProofreadingState().issues.length, 0);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("AI核查规则"), true);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("height-context"), true);
    assert.equal(harness.statuses.some((item) => /AI核查点 1 处/.test(item.text)), true);
});

test("AI-confirmed review rules become one review-only finding with rule provenance", async () => {
    const harness = createHarness({
        selectedText: "检查发现企业存在高空作业管理不到位问题。",
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "高空作业",
            suggestion: "高处作业",
            reason: "当前属于安全生产监管语境，应使用规范术语。",
            confidence: 0.97,
            needsReview: false,
            reviewRuleId: "height-context"
        }],
        rules: [{
            id: "height-context",
            name: "高空作业术语核查",
            type: "ai_review",
            pattern: "高空作业",
            matchMode: "literal",
            replacement: "高处作业",
            instruction: "安全生产监管语境通常使用高处作业；引用原文时不要机械修改。",
            source: "专业术语",
            severity: "medium",
            priority: 90
        }]
    });

    await harness.window.runProofreading();
    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].origin, "ai-review");
    assert.equal(issues[0].ruleName, "高空作业术语核查");
    assert.equal(issues[0].ruleSource, "专业术语");
    assert.equal(issues[0].suggestion, "高处作业");
    assert.equal(issues[0].needsReview, true);
    assert.equal(issues[0].actionable, true);

    const before = harness.readDocument();
    const batch = harness.window.applyAllProofreadingIssues();
    assert.equal(batch.applied, 0);
    assert.equal(batch.skipped, 1);
    assert.equal(harness.readDocument(), before);

    assert.equal(harness.window.applyProofreadingIssue(issues[0].id), true);
    assert.equal(harness.readDocument(), harness.prefix +
        "检查发现企业存在高处作业管理不到位问题。" + harness.suffix);
});
