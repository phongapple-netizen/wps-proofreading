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
const basicRules = JSON.parse(fs.readFileSync(path.join(projectRoot, "rules/chinese-writing-basic.json"), "utf8")).rules;
function basicRule(id) { return basicRules.find((rule) => rule.id === id); }

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
    const prefix = options.prefix === undefined ? "机密前文。" : options.prefix;
    const suffix = options.suffix === undefined ? "机密后文。" : options.suffix;
    const start = prefix.length;
    let documentText = prefix + selectedText + suffix;
    let selectedRange = null;
    let contentReads = 0;
    const rangeReads = [];
    const rangeCreations = [];
    const actionTimers = [];
    const actionLocks = [];
    const perfLogs = [];
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
            rangeCreations.push([rangeStart, rangeEnd]);
            return {
                Start: rangeStart,
                End: rangeEnd,
                get Text() {
                    rangeReads.push([rangeStart, rangeEnd]);
                    return documentText.slice(rangeStart, rangeEnd);
                },
                set Text(value) {
                    documentText = documentText.slice(0, rangeStart) + String(value) + documentText.slice(rangeEnd);
                    if (options.onWrite) options.onWrite();
                },
                Select() {
                    if (options.onSelect) options.onSelect(rangeStart, rangeEnd);
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
    const applicationConfirmMessages = [];
    const confirmationDetails = [];
    let pendingConfirmationResolve = null;
    let notifyConfirmationRequested;
    const confirmationRequested = new Promise((resolve) => { notifyConfirmationRequested = resolve; });
    let busyValue = false;

    function resolveConfirmation(confirmed) {
        const resolve = pendingConfirmationResolve;
        pendingConfirmationResolve = null;
        if (resolve) resolve(confirmed);
        return !!resolve;
    }

    const application = {
        ActiveDocument: document,
        Selection: selection,
        confirm: (message) => {
            applicationConfirmMessages.push(String(message));
            return false;
        }
    };

    const windowObject = {
        Application: application,
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
            if (typeof options.waitForRequest === "function") await options.waitForRequest();
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
        setProofreadingActionBusy: (value) => { actionLocks.push(value); },
        WpsIssueActionPerf: options.perf === true,
        console: { info: (label, report) => { perfLogs.push({ label, report }); } },
        pushProofreadingRecord: (record) => { records.push(record); return true; },
        requestFullDocumentConfirmation: (details) => {
            confirmationDetails.push(details);
            return new Promise((resolve) => {
                pendingConfirmationResolve = resolve;
                notifyConfirmationRequested();
                if (!options.deferConfirmation) resolveConfirmation(options.confirmFullDocument !== false);
            });
        },
        dismissFullDocumentConfirmation: () => resolveConfirmation(false),
        confirm: (message) => {
            confirmMessages.push(String(message));
            return false;
        }
    };

    if (options.manualActions) {
        windowObject.setTimeout = (callback, delay) => { actionTimers.push({ callback, delay }); };
    }

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
        get rangeReads() { return rangeReads; },
        get rangeCreations() { return rangeCreations; },
        actionTimers,
        actionLocks,
        perfLogs,
        flushAction: async () => {
            const timer = actionTimers.shift();
            assert.ok(timer, "a deferred action timer must be pending");
            assert.equal(timer.delay, 0);
            timer.callback();
            await Promise.resolve();
        },
        get selectedRange() { return selectedRange; },
        get storedSettings() { return storage.get(SETTINGS_KEY) || ""; },
        get runtimeEndpoint() { return storage.get(RUNTIME_ENDPOINT_KEY) || ""; },
        get storageDump() { return Array.from(storage.values()).join("\n"); },
        get confirmMessages() { return confirmMessages.slice(); },
        get applicationConfirmMessages() { return applicationConfirmMessages.slice(); },
        get confirmationDetails() { return confirmationDetails.slice(); },
        confirmationRequested,
        resolveConfirmation,
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

test("repeated successful model detection updates only connection status", async () => {
    const harness = createHarness({ seed: JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, { provider: "opencode" })) });
    const connection = [];
    harness.window.setModelConnectionStatus = (text, tone) => connection.push({ text, tone });
    harness.window.WpsModelCatalog = { detect: async () => ({
        provider: "opencode", models: ["opencode/mimo-v2.6-flash-free"],
        defaultModel: "opencode/mimo-v2.6-flash-free", detail: "OpenCode 已连接"
    }) };

    const first = await harness.window.refreshProviderModels();
    assert.equal(first.models.length, 1);
    const catalog = JSON.stringify(harness.window.WpsSettingsStore.loadCatalog());
    harness.window.setProofreadingStatus({ text: "校对完成，结果仍可处理", tone: "success" });
    connection.length = 0;
    const second = await harness.window.refreshProviderModels();
    assert.equal(second.models.length, 1);
    assert.equal(JSON.stringify(harness.window.WpsSettingsStore.loadCatalog()), catalog);
    assert.equal(connection[0].tone, "working");
    assert.equal(connection[connection.length - 1].tone, "success");
    assert.equal(connection[connection.length - 1].text, "OpenCode 已连接 · 1 个模型");
    assert.equal(harness.status.text, "校对完成，结果仍可处理");
});

test("repeated failed model detection updates only connection status", async () => {
    const harness = createHarness();
    const connection = [];
    harness.window.setModelConnectionStatus = (text, tone) => connection.push({ text, tone });
    harness.window.WpsModelCatalog = { detect: async () => { throw new Error("测试连接失败"); } };

    await harness.window.refreshProviderModels();
    const catalog = JSON.stringify(harness.window.WpsSettingsStore.loadCatalog());
    harness.window.setProofreadingStatus({ text: "校对完成，结果仍可处理", tone: "success" });
    connection.length = 0;
    const second = await harness.window.refreshProviderModels();
    assert.equal(second.error, true);
    assert.equal(JSON.stringify(harness.window.WpsSettingsStore.loadCatalog()), catalog);
    assert.equal(connection[0].tone, "working");
    assert.equal(connection[connection.length - 1].tone, "error");
    assert.equal(connection[connection.length - 1].text, "测试连接失败");
    assert.equal(harness.status.text, "校对完成，结果仍可处理");
});

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
    assert.equal(await harness.window.applyProofreadingIssue(id), true);
    assert.equal(harness.readDocument(), harness.prefix + "本段有错别字。" + harness.suffix);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "accepted");
});

test("proofreading passes edit action to the card view without changing editability", async () => {
    for (const [action, actionable] of [["review", false], ["delete", true]]) {
        const harness = createHarness({ issues: [{
            category: "wording", paragraphIndex: 1, original: "错字",
            action, suggestion: "", reason: "测试展示分类",
            confidence: 0.95, needsReview: action === "review"
        }] });
        await harness.window.runProofreading();
        assert.equal(harness.renderedIssues.length, 1);
        assert.equal(harness.renderedIssues[0].action, action);
        assert.equal(harness.renderedIssues[0].actionable, actionable);
        assert.equal(harness.renderedIssues[0].suggestion, "");
    }
});

test("OpenCode proofreading uses the built-in agent and retains the selection-only workflow", async () => {
    const harness = createHarness({
        requireSelection: true,
        seed: JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, { provider: "opencode" }))
    });
    let message;
    harness.window.WpsOpenCodeClient = require("../js/opencode-client.js");
    harness.window.fetch = async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        let payload = null;
        if (init.method === "POST" && url.endsWith("/session")) payload = {
            id: "pane-ok-session", permission: body.permission
        };
        if (url.endsWith("/message")) {
            message = body;
            payload = { info: { role: "assistant" }, parts: [{ type: "text", text: JSON.stringify({ issues: [{
                category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字",
                reason: "用词错误", confidence: 0.95, needsReview: false
            }] }) }] };
        }
        return { ok: true, status: 200, json: async () => payload };
    };

    const result = await harness.window.runProofreading();
    assert.equal(result.accepted, true);
    assert.equal(harness.renderedIssues.length, 1);
    assert.equal(harness.busy, false);
    assert.equal(harness.status.tone, "success");
    assert.equal(message.agent, "build");
    assert.equal(message.tools, undefined);
    assert.equal(JSON.stringify(message).includes(harness.selectedText), true);
    assert.equal(JSON.stringify(message).includes(harness.prefix), false);
    assert.equal(JSON.stringify(message).includes(harness.suffix), false);
    assert.equal(harness.contentReads, 0);
});

test("OpenCode free-tier rejection reaches the task pane and releases the busy state", async () => {
    const harness = createHarness({
        requireSelection: true,
        seed: JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, { provider: "opencode" }))
    });
    const originalDocument = harness.readDocument();
    const paths = [];
    harness.window.WpsOpenCodeClient = require("../js/opencode-client.js");
    harness.window.fetch = async (url, init) => {
        paths.push(`${init.method} ${new URL(url).pathname}`);
        let payload = null;
        if (init.method === "POST" && url.endsWith("/session")) payload = {
            id: "pane-error-session", permission: [{ permission: "*", pattern: "*", action: "ask" }]
        };
        if (url.endsWith("/message")) payload = {
            info: { error: { name: "APIError", data: {
                statusCode: 403,
                message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"
            } } },
            parts: []
        };
        return { ok: true, status: 200, json: async () => payload };
    };

    const result = await harness.window.runProofreading();
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "error");
    assert.equal(harness.status.tone, "error");
    assert.match(harness.status.text, /免费额度仅限 OpenCode 内使用/);
    assert.match(harness.status.text, /代理或权限配置不兼容/);
    assert.equal(harness.busy, false);
    assert.equal(harness.renderedIssues.length, 0);
    assert.equal(harness.readDocument(), originalDocument);
    assert.equal(harness.contentReads, 0);
    assert.deepEqual(paths.slice(-2), [
        "POST /session/pane-error-session/abort",
        "DELETE /session/pane-error-session"
    ]);
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

test("single correction writes immediately and leaves history, coordinates, and rendering to a timer", async () => {
    const harness = createHarness({ manualActions: true });
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    const originalSnapshot = harness.window.getWpsProofreadingState().snapshot.selectedText;
    const initialRender = harness.renderedIssues;
    const operation = harness.window.applyProofreadingIssue(issue.id);

    assert.match(harness.readDocument(), /错别字/);
    assert.equal(harness.records.length, 0);
    assert.equal(harness.renderedIssues, initialRender);
    assert.equal(harness.window.getWpsProofreadingState().snapshot.selectedText, originalSnapshot);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "pending");
    assert.equal(harness.window.getWpsProofreadingState().actionBusy, true);
    assert.equal(harness.busy, false);
    await Promise.resolve();
    assert.equal(harness.records.length, 0, "a microtask must not perform the deferred work");
    await harness.flushAction();
    assert.equal(await operation, true);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "accepted");
    assert.equal(harness.records.length, 1);
    assert.equal(harness.window.getWpsProofreadingState().actionBusy, false);
});

test("rapid correction, undo, locate, and rerun calls cannot use coordinates awaiting finalization", async () => {
    const harness = createHarness({ manualActions: true });
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    const operation = harness.window.applyProofreadingIssue(issue.id);
    const written = harness.readDocument();
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(await harness.window.undoProofreadingIssue(issue.id), false);
    assert.equal(harness.window.locateProofreadingIssue(issue.id), false);
    assert.equal(harness.window.ignoreProofreadingIssue(issue.id), false);
    assert.equal((await harness.window.runProofreading()).reason, "action-busy");
    assert.equal(harness.window.applyAllProofreadingIssues().applied, 0);
    assert.equal(harness.readDocument(), written);
    assert.equal(harness.actionTimers.length, 1);
    await harness.flushAction();
    assert.equal(await operation, true);
});

test("a changed document is left untouched when an old suggestion is applied", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    const edited = harness.prefix + "本段已人工改过。" + harness.suffix;
    harness.changeDocument(edited);

    assert.equal(await harness.window.applyProofreadingIssue(id), false);
    assert.equal(harness.readDocument(), edited);
    assert.equal(harness.status.tone, "warning");
});

function twoIssueHarness(options = {}) {
    return createHarness(Object.assign({
        selectedText: "这里有错字，那里有误字。",
        issues: [
            { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字",
                reason: "错字", confidence: 0.98, needsReview: false },
            { category: "typo", paragraphIndex: 1, original: "误字", suggestion: "正确字",
                reason: "误字", confidence: 0.98, needsReview: false }
        ]
    }, options));
}

async function startDeferredReplacement(undo) {
    const harness = twoIssueHarness({ manualActions: true, perf: true });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    if (undo) {
        const apply = harness.window.applyProofreadingIssue(id);
        await harness.flushAction();
        assert.equal(await apply, true);
    }
    const bodyBeforeWrite = harness.readDocument();
    const recordsBefore = harness.records.length;
    const selectedBefore = harness.selectedRange;
    const operation = undo ? harness.window.undoProofreadingIssue(id) : harness.window.applyProofreadingIssue(id);
    assert.notEqual(harness.readDocument(), bodyBeforeWrite, "the synchronous write must still happen before yielding");
    assert.equal(harness.records.length, recordsBefore);
    return { harness, operation, bodyBeforeWrite, recordsBefore, selectedBefore };
}

async function assertPostWriteRejected(pending) {
    const { harness, operation, recordsBefore, selectedBefore } = pending;
    const liveText = harness.readDocument();
    await harness.flushAction();
    assert.equal(await operation, false);
    const state = harness.window.getWpsProofreadingState();
    assert.equal(state.snapshot, null);
    assert.equal(state.issues.every(issue => issue.status === "stale"), true);
    assert.equal(state.actionBusy, false);
    assert.equal(harness.records.length, recordsBefore, "must not record a normal applied/undone action");
    assert.deepEqual(harness.selectedRange, selectedBefore, "must not locate another issue after a failed post-write check");
    assert.equal(harness.readDocument(), liveText, "must not overwrite the user's native edit");
    assert.match(harness.status.text, /正文在写入后发生变化/);
    assert.equal(harness.perfLogs.at(-1).report.outcome, "post-write-changed");
    assert.equal(await harness.window.applyProofreadingIssue(state.issues[1].id), false);
    assert.equal(await harness.window.undoProofreadingIssue(state.issues[0].id), false);
    assert.equal(harness.readDocument(), liveText);
}

test("native Ctrl+Z before deferred finalization cannot commit a correction or undo as completed", async () => {
    for (const undo of [false, true]) {
        const pending = await startDeferredReplacement(undo);
        pending.harness.changeDocument(pending.bodyBeforeWrite);
        await assertPostWriteRejected(pending);
    }
});

test("native edits to nearby context before deferred finalization invalidate correction and undo", async () => {
    for (const undo of [false, true]) {
        const pending = await startDeferredReplacement(undo);
        const harness = pending.harness;
        harness.changeDocument(harness.readDocument().replace("这里", "此处"));
        if (undo) {
            harness.window.setProofreadingIssues = () => { throw new Error("render failed after native edit"); };
        }
        await assertPostWriteRejected(pending);
    }
});

test("switching ActiveDocument before deferred finalization invalidates correction and undo without reading the new document", async () => {
    for (const undo of [false, true]) {
        const pending = await startDeferredReplacement(undo);
        let rangeCalls = 0;
        pending.harness.window.Application.ActiveDocument = {
            FullName: "C:\\temp\\新文档.docx",
            Range() { rangeCalls++; throw new Error("must not inspect or select a different document"); }
        };
        await assertPostWriteRejected(pending);
        assert.equal(rangeCalls, 0);
    }
});

test("post-write COM failures cannot publish a successful correction or undo", async () => {
    for (const undo of [false, true]) {
        const pending = await startDeferredReplacement(undo);
        pending.harness.window.Application.ActiveDocument.Range = () => { throw new Error("post-write read failed"); };
        await assertPostWriteRejected(pending);
    }
    const harness = twoIssueHarness({ manualActions: true });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    harness.window.setTimeout = () => { throw new Error("timer unavailable after write"); };
    assert.equal(await harness.window.applyProofreadingIssue(id), false);
    assert.match(harness.readDocument(), /错别字/);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, null);
    assert.equal(harness.window.getWpsProofreadingState().issues.every(issue => issue.status === "stale"), true);
    assert.equal(harness.records.length, 0);
    assert.equal(harness.window.getWpsProofreadingState().actionBusy, false);
});

test("deleting the whole proofreading range without anchors is refused before WPS writes", async () => {
    for (const noSelection of [false, true]) {
        const harness = createHarness({ manualActions: true, prefix: "", suffix: "", noSelection,
            selectedText: "多余内容", issues: [{ category: "redundancy", paragraphIndex: 1,
                original: "多余内容", action: "delete", suggestion: "", reason: "应删除",
                confidence: 0.99, needsReview: false }] });
        await harness.window.runProofreading();
        const id = harness.window.getWpsProofreadingState().issues[0].id;
        const readsBefore = harness.rangeReads.length;
        const rangesBefore = harness.rangeCreations.length;
        assert.equal(await harness.window.applyProofreadingIssue(id), false);
        assert.equal(harness.readDocument(), "多余内容");
        assert.equal(harness.rangeReads.length, readsBefore);
        assert.equal(harness.rangeCreations.length, rangesBefore);
        assert.equal(harness.actionTimers.length, 0);
        assert.equal(harness.records.length, 0);
        const state = harness.window.getWpsProofreadingState();
        assert.equal(state.snapshot.selectedText, "多余内容");
        assert.equal(state.issues[0].status, "pending");
        assert.equal(state.issues[0].actionable, false);
        assert.equal(state.issues[0].needsReview, true);
        assert.equal(state.actionBusy, false);
        assert.match(harness.status.text, /未修改正文/);
    }
});

test("a second rapid click is blocked until shifted coordinates are published, then can be retried safely", async () => {
    const harness = twoIssueHarness({ manualActions: true });
    await harness.window.runProofreading();
    const [first, second] = harness.window.getWpsProofreadingState().issues;
    const firstAction = harness.window.applyProofreadingIssue(first.id);
    assert.equal(await harness.window.applyProofreadingIssue(second.id), false);
    assert.equal(harness.selectedRange, null, "automatic next location must wait for the timer");
    assert.equal(harness.window.getWpsProofreadingState().issues[1].start, second.start);
    await harness.flushAction();
    assert.equal(await firstAction, true);
    const shifted = harness.window.getWpsProofreadingState().issues[1];
    assert.equal(shifted.start, second.start + 1);
    assert.deepEqual(harness.selectedRange, [shifted.start, shifted.end]);
    const secondAction = harness.window.applyProofreadingIssue(second.id);
    assert.equal(harness.readDocument(), harness.prefix + "这里有错别字，那里有正确字。" + harness.suffix);
    await harness.flushAction();
    assert.equal(await secondAction, true);
    assert.equal(harness.records.length, 2);
});

test("undo writes immediately, reads one context, and defers history and snapshot finalization", async () => {
    const harness = createHarness({ manualActions: true });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    const apply = harness.window.applyProofreadingIssue(id);
    await harness.flushAction();
    await apply;
    const readsBefore = harness.rangeReads.length;
    const undo = harness.window.undoProofreadingIssue(id);
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
    assert.equal(harness.rangeReads.length - readsBefore, 1);
    assert.equal(harness.records.length, 1);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "accepted");
    await harness.flushAction();
    assert.equal(await undo, true);
    assert.equal(harness.window.getWpsProofreadingState().snapshot.selectedText, harness.selectedText);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "pending");
    assert.deepEqual(harness.records.map(record => record.action), ["applied", "undone"]);
});

test("anchors are computed per operation without storing or globally refreshing issue anchors", async () => {
    const harness = twoIssueHarness();
    await harness.window.runProofreading();
    const issues = harness.window.getWpsProofreadingState().issues;
    for (const issue of issues) {
        assert.equal(Object.hasOwn(issue, "anchorBefore"), false);
        assert.equal(Object.hasOwn(issue, "anchorAfter"), false);
        for (const name of ["anchorBefore", "anchorAfter"]) {
            Object.defineProperty(issue, name, { set() { throw new Error("anchor cache must not be rebuilt"); } });
        }
    }
    assert.equal(await harness.window.applyProofreadingIssue(issues[0].id), true);
    assert.equal(await harness.window.undoProofreadingIssue(issues[0].id), true);
    assert.equal(harness.window.getWpsProofreadingState().issues.every(issue =>
        !Object.hasOwn(issue, "anchorBefore") && !Object.hasOwn(issue, "anchorAfter")), true);
    assert.equal(integrationSource.includes("refreshIssueAnchors"), false);
});

test("context validation clamps safely at the beginning and end of a full document", async () => {
    for (const selectedText of ["错字", "错字保留后文。", "保留前文。错字"]) {
        const harness = createHarness({ prefix: "", suffix: "", selectedText, noSelection: true });
        await harness.window.runProofreading();
        const issue = harness.window.getWpsProofreadingState().issues[0];
        const readsBefore = harness.rangeReads.length;
        assert.equal(await harness.window.applyProofreadingIssue(issue.id), true);
        const reads = harness.rangeReads.slice(readsBefore);
        assert.equal(reads.length, 2, "pre-write validation and deferred post-write verification");
        assert.equal(reads[0][0] >= 0 && reads[0][1] <= selectedText.length, true);
        assert.equal(reads[1][0] >= 0 && reads[1][1] <= selectedText.length + 1, true);
        assert.equal(harness.readDocument(), selectedText.replace("错字", "错别字"));
        assert.equal(await harness.window.undoProofreadingIssue(issue.id), true);
        assert.equal(harness.readDocument(), selectedText);
    }
});

test("truncated context or invalid issue coordinates cannot be written", async () => {
    for (const change of ["truncated", "negative", "fractional", "outside"]) {
        const harness = createHarness({ selectedText: "前文错字后文必须保留。" });
        await harness.window.runProofreading();
        const issue = harness.window.getWpsProofreadingState().issues[0];
        if (change === "truncated") harness.changeDocument(harness.prefix + "前文错字");
        if (change === "negative") { issue.start = -2; issue.end = 0; }
        if (change === "fractional") { issue.start += 0.5; issue.end += 0.5; }
        if (change === "outside") { issue.start += 100; issue.end += 100; }
        const before = harness.readDocument();
        assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
        assert.equal(harness.readDocument(), before);
        assert.equal(issue.status, "stale");
        assert.equal(harness.actionTimers.length, 0);
    }
});

test("a stale issue cannot write even when its original text still matches", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    issue.status = "stale";
    const before = harness.readDocument();
    const readsBefore = harness.rangeReads.length;
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(harness.readDocument(), before);
    assert.equal(harness.rangeReads.length, readsBefore);
});

test("next location checks stale candidates safely and renders the list only once", async () => {
    const separator = "普通正文。".repeat(30);
    const harness = createHarness({
        selectedText: "错字" + separator + "误字" + separator + "漏字。",
        issues: ["错字", "误字", "漏字"].map(original => ({ category: "typo", paragraphIndex: 1,
            original, suggestion: original + "改", reason: "测试", confidence: 0.98, needsReview: false }))
    });
    await harness.window.runProofreading();
    const [first, second, third] = harness.window.getWpsProofreadingState().issues;
    const edited = harness.readDocument().replace("误字", "人工");
    harness.changeDocument(edited);
    let renders = 0;
    const render = harness.window.setProofreadingIssues;
    harness.window.setProofreadingIssues = value => { renders++; render(value); };
    const readsBefore = harness.rangeReads.length;
    assert.equal(await harness.window.applyProofreadingIssue(first.id), true);
    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.find(issue => issue.id === second.id).status, "stale");
    const next = issues.find(issue => issue.id === third.id);
    assert.deepEqual(harness.selectedRange, [next.start, next.end]);
    assert.equal(renders, 1, "failed candidates must not trigger individual full renders");
    assert.equal(harness.rangeReads.length - readsBefore, 4, "pre-write, deferred verification, and two next candidates");
    assert.equal(harness.readDocument(), edited.replace("错字", "错字改"));
    assert.equal(await harness.window.applyProofreadingIssue(second.id), false);
});

test("automatic location acquires the current document after the timer instead of selecting the previous document", async () => {
    const harness = twoIssueHarness({ manualActions: true });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    const operation = harness.window.applyProofreadingIssue(id);
    let rangeCalls = 0;
    harness.window.Application.ActiveDocument = {
        FullName: "C:\\temp\\另一个文档.docx",
        Range() { rangeCalls++; throw new Error("must not select a different document"); }
    };
    await harness.flushAction();
    assert.equal(await operation, false);
    assert.equal(rangeCalls, 0);
    assert.equal(harness.selectedRange, null);
    assert.equal(harness.records.length, 0);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, null);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "stale");
    assert.equal(harness.window.getWpsProofreadingState().issues[1].status, "stale");
});

test("history and render failures after writing preserve accepted state, snapshot, and undo safety", async () => {
    for (const failingCallback of ["pushProofreadingRecord", "setProofreadingIssues"]) {
        const harness = createHarness({ manualActions: true });
        await harness.window.runProofreading();
        const issue = harness.window.getWpsProofreadingState().issues[0];
        const operation = harness.window.applyProofreadingIssue(issue.id);
        const originalCallback = harness.window[failingCallback];
        harness.window[failingCallback] = () => { throw new Error("private diagnostic data"); };
        await harness.flushAction();
        assert.equal(await operation, true);
        const state = harness.window.getWpsProofreadingState();
        assert.equal(state.snapshot.selectedText, "本段有错别字。");
        assert.equal(state.issues[0].status, "accepted");
        assert.equal(state.actionBusy, false);
        assert.match(harness.status.text, /正文修改已完成/);
        harness.window[failingCallback] = originalCallback;
        const undo = harness.window.undoProofreadingIssue(issue.id);
        await harness.flushAction();
        assert.equal(await undo, true);
        assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
    }
});

test("failed deferred coordinate finalization keeps the successful write and invalidates unsafe future actions", async () => {
    const harness = twoIssueHarness({ manualActions: true });
    await harness.window.runProofreading();
    const [first, second] = harness.window.getWpsProofreadingState().issues;
    const operation = harness.window.applyProofreadingIssue(first.id);
    harness.window.WpsProofreadingCore.shiftIssuesAfterReplacement = () => { throw new Error("shift failed"); };
    await harness.flushAction();
    assert.equal(await operation, true);
    const state = harness.window.getWpsProofreadingState();
    assert.equal(state.snapshot, null);
    assert.equal(state.issues[0].status, "accepted");
    assert.equal(state.issues[0].end - state.issues[0].start, "错别字".length);
    assert.equal(state.issues[1].status, "stale");
    assert.equal(state.actionBusy, false);
    assert.match(harness.readDocument(), /错别字/);
    assert.equal(harness.records.length, 1);
    const written = harness.readDocument();
    assert.equal(await harness.window.applyProofreadingIssue(second.id), false);
    assert.equal(await harness.window.undoProofreadingIssue(first.id), false);
    assert.equal(harness.readDocument(), written);
});

test("an unconfirmed WPS write invalidates the snapshot and all issues instead of assuming success", async () => {
    const harness = twoIssueHarness({ onWrite() { throw new Error("COM failed after write"); } });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(await harness.window.applyProofreadingIssue(id), false);
    assert.match(harness.readDocument(), /错别字/);
    const state = harness.window.getWpsProofreadingState();
    assert.equal(state.snapshot, null);
    assert.equal(state.issues.every(issue => issue.status === "stale"), true);
    assert.equal(state.actionBusy, false);
    assert.match(harness.status.text, /未能确认写入结果/);
});

test("validation COM errors mark the issue stale without writing", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    harness.window.Application.ActiveDocument.Range = () => { throw new Error("COM read failed"); };
    const before = harness.readDocument();
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(harness.readDocument(), before);
    assert.equal(issue.status, "stale");
});

test("development performance diagnostics contain only fixed labels and numeric timing data", async () => {
    const harness = createHarness({ perf: true, manualActions: true, password: "secret-fixture-key" });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    const operation = harness.window.applyProofreadingIssue(id);
    assert.equal(harness.perfLogs.length, 0);
    await harness.flushAction();
    await operation;
    const log = harness.perfLogs[0];
    assert.equal(log.label, "applyIssue perf:");
    assert.equal(log.report.outcome, "completed");
    for (const field of ["issueLookup", "validation", "rangeRead", "write", "postWriteVerification", "stateShift", "snapshotUpdate",
        "historyRecord", "render", "locateNext", "writeComplete", "deferredDelay", "total"]) {
        assert.equal(typeof log.report[field], "number", field);
        assert.equal(Number.isFinite(log.report[field]) && log.report[field] >= 0, true, field);
    }
    const serialized = JSON.stringify(harness.perfLogs);
    for (const forbidden of [harness.prefix, harness.selectedText, "错字", "错别字", "用词错误", "secret-fixture-key"]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(harness.window.locateProofreadingIssue("missing"), false);
    const undo = harness.window.undoProofreadingIssue(id);
    await harness.flushAction();
    await undo;
    assert.deepEqual(harness.perfLogs.map(log => log.report.action), ["apply", "locate", "undo"]);
    harness.window.pushProofreadingRecord = () => { throw new Error("secret-fixture-key " + harness.selectedText); };
    const failedHistory = harness.window.applyProofreadingIssue(id);
    await harness.flushAction();
    assert.equal(await failedHistory, true);
    assert.equal(harness.perfLogs.at(-1).report.outcome, "written-with-warning");
    assert.equal(JSON.stringify(harness.perfLogs).includes("secret-fixture-key"), false);
    assert.equal(JSON.stringify(harness.perfLogs).includes(harness.selectedText), false);
});

test("performance diagnostics are opt-in outside development hosts and can be disabled locally", async () => {
    for (const hostname of ["published.example", "localhost", "127.0.0.1"]) {
        const harness = createHarness();
        harness.window.location = { hostname };
        if (hostname === "published.example") delete harness.window.WpsIssueActionPerf;
        await harness.window.runProofreading();
        const id = harness.window.getWpsProofreadingState().issues[0].id;
        assert.equal(await harness.window.applyProofreadingIssue(id), true);
        assert.equal(harness.perfLogs.length, 0);
        delete harness.window.WpsIssueActionPerf;
        assert.equal(await harness.window.undoProofreadingIssue(id), true);
        assert.equal(harness.perfLogs.length, hostname === "published.example" ? 0 : 1);
    }
});

test("single correction validates a long document with one bounded context Text read", async () => {
    const selectedText = Array(180).fill("这是普通正文，用于验证长文档局部校验。").join("\n") +
        "\n本段有错字。";
    const harness = createHarness({
        selectedText,
        manualActions: true,
        noSelection: true,
        issues: [{ category: "typo", paragraphIndex: 181, original: "错字",
            suggestion: "错别字", reason: "错字", confidence: 0.98, needsReview: false }]
    });
    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    assert.equal(Object.hasOwn(issue, "anchorBefore"), false);
    assert.equal(Object.hasOwn(issue, "anchorAfter"), false);
    const readsBefore = harness.rangeReads.length;
    const creationsBefore = harness.rangeCreations.length;
    const contentReadsBefore = harness.contentReads;

    const operation = harness.window.applyProofreadingIssue(issue.id);
    assert.equal(harness.rangeReads.length - readsBefore, 1, "only one context read before yielding");
    assert.equal(harness.rangeCreations.length - creationsBefore, 2, "context plus short-lived write Range before yielding");
    await harness.flushAction();
    assert.equal(await operation, true);
    const reads = harness.rangeReads.slice(readsBefore);
    assert.equal(reads.length, 2, "one pre-write read plus one deferred verification read");
    assert.equal(reads[0][1] - reads[0][0] <= 80 + issue.original.length, true);
    assert.equal(reads[1][1] - reads[1][0] <= 80 + issue.suggestion.length, true);
    assert.equal(harness.rangeCreations.length - creationsBefore, 3);
    assert.equal(harness.contentReads, contentReadsBefore);
    assert.match(harness.readDocument(), /本段有错别字。/);
});

test("matching anchors allow a correction and changed nearby text blocks it", async () => {
    const original = "引言文字。前置说明本段有错字，后置说明请复核。";
    const before = createHarness({ selectedText: original });
    await before.window.runProofreading();
    const beforeIssue = before.window.getWpsProofreadingState().issues[0];
    const editedBefore = before.prefix + original.replace("前置", "另有") + before.suffix;
    before.changeDocument(editedBefore);
    assert.equal(await before.window.applyProofreadingIssue(beforeIssue.id), false);
    assert.equal(before.readDocument(), editedBefore);
    assert.equal(before.window.getWpsProofreadingState().issues[0].status, "stale");

    const after = createHarness({ selectedText: original });
    await after.window.runProofreading();
    const afterIssue = after.window.getWpsProofreadingState().issues[0];
    const editedAfter = after.prefix + original.replace("后置", "其他") + after.suffix;
    after.changeDocument(editedAfter);
    assert.equal(await after.window.applyProofreadingIssue(afterIssue.id), false);
    assert.equal(after.readDocument(), editedAfter);
    assert.equal(after.window.getWpsProofreadingState().issues[0].status, "stale");

    const matching = createHarness({ selectedText: original });
    await matching.window.runProofreading();
    const matchingIssue = matching.window.getWpsProofreadingState().issues[0];
    assert.equal(await matching.window.applyProofreadingIssue(matchingIssue.id), true);
    assert.match(matching.readDocument(), /本段有错别字/);
});

test("correction shifts the next issue, locates it, and undo restores offsets", async () => {
    const harness = createHarness({
        selectedText: "这里有错字，那里有误字。",
        issues: [
            { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字",
                reason: "错字", confidence: 0.98, needsReview: false },
            { category: "typo", paragraphIndex: 1, original: "误字", suggestion: "正确字",
                reason: "误字", confidence: 0.98, needsReview: false }
        ]
    });
    await harness.window.runProofreading();
    const initial = harness.window.getWpsProofreadingState().issues;
    const firstId = initial[0].id;
    const secondId = initial[1].id;
    const secondStart = initial[1].start;
    const readsBefore = harness.rangeReads.length;

    assert.equal(await harness.window.applyProofreadingIssue(firstId), true);
    assert.equal(harness.rangeReads.length - readsBefore, 3, "pre-write, deferred verification, and next location");
    assert.equal(harness.rangeReads.slice(readsBefore).every(([start, end]) => end - start <= 83), true);
    let issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues[0].status, "accepted");
    assert.equal(issues[0].end, issues[0].start + "错别字".length);
    assert.equal(issues[1].start, secondStart + 1);
    assert.deepEqual(harness.selectedRange, [issues[1].start, issues[1].end]);
    assert.match(harness.status.text, /下一条/);

    assert.equal(await harness.window.undoProofreadingIssue(firstId), true);
    issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues[0].status, "pending");
    assert.equal(issues[1].start, secondStart);
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
    assert.deepEqual(harness.records.map((record) => record.action), ["applied", "undone"]);
    assert.equal(await harness.window.applyProofreadingIssue(secondId), true);
    assert.deepEqual(harness.selectedRange, [issues[0].start, issues[0].end]);
});

test("undo rejects manual edits to the accepted text or its anchors", async () => {
    const harness = createHarness({ selectedText: "前文有错字，后文保留。" });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(await harness.window.applyProofreadingIssue(id), true);
    const edited = harness.readDocument().replace("错别字", "人工字");
    harness.changeDocument(edited);
    assert.equal(await harness.window.undoProofreadingIssue(id), false);
    assert.equal(harness.readDocument(), edited);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "stale");

    const anchorHarness = createHarness({ selectedText: "前文有错字，后文保留。" });
    await anchorHarness.window.runProofreading();
    const anchorId = anchorHarness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(await anchorHarness.window.applyProofreadingIssue(anchorId), true);
    const changedAnchor = anchorHarness.readDocument().replace("后文", "别文");
    anchorHarness.changeDocument(changedAnchor);
    assert.equal(await anchorHarness.window.undoProofreadingIssue(anchorId), false);
    assert.equal(anchorHarness.readDocument(), changedAnchor);
});

test("applying the last pending issue reports completion and remains undoable", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(await harness.window.applyProofreadingIssue(id), true);
    assert.match(harness.status.text, /待处理问题已经处理完成/);
    assert.equal(await harness.window.undoProofreadingIssue(id), true);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].status, "pending");
});

test("a deletion can be undone using its surrounding anchors", async () => {
    const harness = createHarness({
        selectedText: "前文有多余词，后文保留。",
        issues: [{ category: "redundancy", paragraphIndex: 1, original: "多余词",
            suggestion: "", reason: "冗余", confidence: 0.95, needsReview: false }]
    });
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    assert.equal(await harness.window.applyProofreadingIssue(id), true);
    assert.equal(harness.window.getWpsProofreadingState().issues[0].end,
        harness.window.getWpsProofreadingState().issues[0].start);
    assert.equal(await harness.window.undoProofreadingIssue(id), true);
    assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
});

test("edits after the selected range do not invalidate safe positions", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    harness.changeDocument(harness.prefix + harness.selectedText + "新增的文末内容。" );

    assert.equal(await harness.window.applyProofreadingIssue(id), true);
    assert.equal(harness.readDocument(), harness.prefix + "本段有错别字。" + "新增的文末内容。");
});

test("edits before the selected range invalidate old offsets", async () => {
    const harness = createHarness();
    await harness.window.runProofreading();
    const id = harness.window.getWpsProofreadingState().issues[0].id;
    harness.changeDocument("机密前文已变化。" + harness.selectedText + harness.suffix);

    assert.equal(await harness.window.applyProofreadingIssue(id), false);
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

test("one-click fix applies only fixed low-risk punctuation rules", async () => {
    const harness = createHarness({
        selectedText: "本段,有错字。。",
        issues: [],
        rules: [basicRule("basic-ascii-comma-between-hanzi"), basicRule("basic-duplicate-period")]
    });
    await harness.window.runProofreading();
    assert.equal(harness.window.getWpsProofreadingState().issues.length, 2);

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 2);
    assert.equal(result.failed, 0);
    assert.equal(harness.readDocument(), harness.prefix + "本段，有错字。" + harness.suffix);
    assert.equal(harness.window.getWpsProofreadingState().issues.every((issue) => issue.status === "accepted"), true);
    assert.equal(harness.records.filter((record) => record.action === "applied").length, 2);
    assert.equal(harness.status.text.includes("已一键修正 2 条"), true);
});

test("one-click fix skips every AI suggestion regardless of confidence", async () => {
    const harness = createHarness({
        selectedText: "本段,有错字，也有可疑表述，另有建议。",
        rules: [basicRule("basic-ascii-comma-between-hanzi")],
        issues: [
            { category: "typo", paragraphIndex: 1, original: "错字", suggestion: "错别字", reason: "明确错字", confidence: 0.98, needsReview: false },
            { category: "wording", paragraphIndex: 1, original: "可疑表述", suggestion: "建议表述", reason: "需要人工判断语境", confidence: 0.99, needsReview: true },
            { category: "grammar", paragraphIndex: 1, original: "另有建议", suggestion: "另有方案", reason: "置信度不足", confidence: 0.72, needsReview: false }
        ]
    });
    await harness.window.runProofreading();

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 1);
    assert.equal(result.skipped, 3);
    assert.equal(harness.readDocument(), harness.prefix + "本段，有错字，也有可疑表述，另有建议。" + harness.suffix);

    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.find((issue) => issue.original === "错字").status, "pending");
    assert.equal(issues.find((issue) => issue.original === "可疑表述").status, "pending");
    assert.equal(issues.find((issue) => issue.original === "另有建议").status, "pending");
    assert.match(harness.status.text, /另有 3 条/);
});

test("one-click fix stops without writing when the document changed first", async () => {
    const harness = createHarness({
        selectedText: "本段,有错字。", issues: [],
        rules: [basicRule("basic-ascii-comma-between-hanzi")]
    });
    await harness.window.runProofreading();
    const edited = harness.prefix + "本段已人工改过。" + harness.suffix;
    harness.changeDocument(edited);

    const result = harness.window.applyAllProofreadingIssues();
    assert.equal(result.applied, 0);
    assert.equal(harness.readDocument(), edited);
    assert.equal(harness.window.getWpsProofreadingState().issues.every((issue) => issue.status === "stale"), true);
});

test("issues cannot be applied or ignored while an AI batch is pending", async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const harness = createHarness({
        selectedText: "本段,有错字。", issues: [],
        rules: [basicRule("basic-ascii-comma-between-hanzi")],
        waitForRequest: () => waiting
    });
    const running = harness.window.runProofreading();
    try {
        for (let attempt = 0; attempt < 10 && !harness.requests.length; attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(harness.busy, true);
        const issue = harness.window.getWpsProofreadingState().issues[0];
        assert.ok(issue);
        assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
        assert.equal(harness.window.ignoreProofreadingIssue(issue.id), false);
        assert.equal(harness.window.applyAllProofreadingIssues().applied, 0);
        assert.equal(harness.readDocument(), harness.prefix + harness.selectedText + harness.suffix);
    } finally {
        release();
        await running;
    }
    assert.equal(harness.window.applyAllProofreadingIssues().applied, 1);
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
    assert.equal(harness.confirmationDetails.length, 1);
    assert.equal(harness.confirmationDetails[0].characterCount, harness.readDocument().length);
    assert.equal(harness.confirmationDetails[0].providerLabel, "Ollama");
    assert.equal(Object.values(harness.confirmationDetails[0]).includes(harness.readDocument()), false);
    assert.equal(harness.contentReads >= 1, true);
    assert.equal(JSON.stringify(harness.sentRequest.body).includes(harness.readDocument()), true);
    assert.equal(harness.statuses.some((entry) => String(entry.text).includes("全文")), true);
    assert.equal(harness.status.tone, "success");
    assert.equal(harness.progress.some((entry) => entry.percent === 100), true);
    assert.equal(harness.busy, false);
});

test("pane confirmation starts full-document proofreading even when both native confirm APIs return false", async () => {
    const harness = createHarness({ noSelection: true });
    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(harness.applicationConfirmMessages.length, 0);
    assert.equal(harness.confirmMessages.length, 0);
    assert.equal(harness.confirmationDetails.length, 1);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.status.tone, "success");
});

test("declining whole-document confirmation sends no model request", async () => {
    const harness = createHarness({ noSelection: true, confirmFullDocument: false });
    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "full-document-not-confirmed");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.confirmationDetails.length, 1);
    assert.match(harness.status.text, /没有发送/);
    assert.equal(harness.busy, false);
});

test("cancelling a rerun keeps the previous suggestions and does not reset the view", async () => {
    const options = { deferConfirmation: true };
    const harness = createHarness(options);
    let begun = 0;
    harness.window.beginProofreadingRun = () => {
        begun += 1;
        harness.window.clearProofreadingIssues();
    };
    assert.equal((await harness.window.runProofreading()).accepted, true);
    const previousIssue = harness.window.getWpsProofreadingState().issues[0];
    const previousSnapshot = harness.window.getWpsProofreadingState().snapshot;
    assert.equal(begun, 1);

    options.noSelection = true;
    const rerun = harness.window.runProofreading();
    await harness.confirmationRequested;
    assert.equal(begun, 1);
    assert.equal(harness.renderedIssues.length, 1);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    harness.resolveConfirmation(false);
    assert.equal((await rerun).reason, "full-document-not-confirmed");
    assert.equal(begun, 1);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
});

test("failed rerun capture and model configuration preserve the previous suggestions", async () => {
    const options = {};
    const harness = createHarness(options);
    assert.equal((await harness.window.runProofreading()).accepted, true);
    const previousSnapshot = harness.window.getWpsProofreadingState().snapshot;
    const previousIssue = harness.window.getWpsProofreadingState().issues[0];
    const previousRequestCount = harness.requests.length;

    options.noSelection = true;
    options.requireSelection = true;
    assert.equal((await harness.window.runProofreading()).accepted, false);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);

    options.noSelection = false;
    options.requireSelection = false;
    const loadSettings = harness.window.WpsSettingsStore.loadSettings;
    harness.window.WpsSettingsStore.loadSettings = () => { throw new Error("模型配置不可用"); };
    assert.equal((await harness.window.runProofreading()).accepted, false);
    harness.window.WpsSettingsStore.loadSettings = loadSettings;
    assert.equal(harness.requests.length, previousRequestCount);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);
});

test("invalid OpenCode model configuration preserves previous suggestions before rerun starts", async () => {
    const harness = createHarness();
    assert.equal((await harness.window.runProofreading()).accepted, true);
    const previousSnapshot = harness.window.getWpsProofreadingState().snapshot;
    const previousIssue = harness.window.getWpsProofreadingState().issues[0];
    const previousRequestCount = harness.requests.length;

    harness.window.WpsOpenCodeClient = require("../js/opencode-client.js");
    harness.window.WpsSettingsStore.updateSettings({
        provider: "opencode",
        profile: { endpoint: "http://127.0.0.1:4096", model: "invalid-model-name" }
    });

    const rerun = await harness.window.runProofreading();
    assert.equal(rerun.accepted, false);
    assert.equal(rerun.reason, "error");
    assert.match(harness.status.text, /provider\/model/);
    assert.equal(harness.requests.length, previousRequestCount);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);
});

test("invalid compatible API endpoint preserves previous suggestions before rerun starts", async () => {
    const harness = createHarness();
    assert.equal((await harness.window.runProofreading()).accepted, true);
    const previousSnapshot = harness.window.getWpsProofreadingState().snapshot;
    const previousIssue = harness.window.getWpsProofreadingState().issues[0];
    const previousRequestCount = harness.requests.length;

    harness.window.WpsSettingsStore.updateSettings({
        provider: "openai",
        profile: { endpoint: "not-a-url", model: "test-model" }
    });

    const rerun = await harness.window.runProofreading();
    assert.equal(rerun.accepted, false);
    assert.equal(rerun.reason, "error");
    assert.match(harness.status.text, /http:\/\//);
    assert.equal(harness.requests.length, previousRequestCount);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);
});

test("empty compatible API model preserves previous suggestions before rerun starts", async () => {
    const harness = createHarness();
    assert.equal((await harness.window.runProofreading()).accepted, true);
    const previousSnapshot = harness.window.getWpsProofreadingState().snapshot;
    const previousIssue = harness.window.getWpsProofreadingState().issues[0];
    const previousRequestCount = harness.requests.length;

    const loadSettings = harness.window.WpsSettingsStore.loadSettings;
    harness.window.WpsSettingsStore.loadSettings = () => ({
        provider: "openai",
        deep: false,
        profiles: {
            ollama: { endpoint: "http://127.0.0.1:11434", model: "qwen3:8b" },
            opencode: { endpoint: "http://127.0.0.1:4096", model: "opencode/mimo-v2.6-flash-free" },
            openai: { endpoint: "https://models.example/v1/chat/completions", model: "" }
        }
    });

    const rerun = await harness.window.runProofreading();
    harness.window.WpsSettingsStore.loadSettings = loadSettings;
    assert.equal(rerun.accepted, false);
    assert.equal(rerun.reason, "error");
    assert.match(harness.status.text, /模型名称/);
    assert.equal(harness.requests.length, previousRequestCount);
    assert.equal(harness.window.getWpsProofreadingState().snapshot, previousSnapshot);
    assert.equal(harness.renderedIssues[0].id, previousIssue.id);
});

test("a confirmed rerun resets suggestions only when the new run starts", async () => {
    const options = { deferConfirmation: true };
    const harness = createHarness(options);
    let begun = 0;
    harness.window.beginProofreadingRun = () => {
        begun += 1;
        harness.window.clearProofreadingIssues();
    };
    assert.equal((await harness.window.runProofreading()).accepted, true);
    options.noSelection = true;
    const rerun = harness.window.runProofreading();
    await harness.confirmationRequested;
    assert.equal(begun, 1);
    assert.equal(harness.renderedIssues.length, 1);
    harness.resolveConfirmation(true);
    assert.equal((await rerun).accepted, true);
    assert.equal(begun, 2);
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.window.getWpsProofreadingState().snapshot.mode, "full");
});

test("a legacy parenthesized deletion explanation removes only the original text and can be undone", async () => {
    const errorText = "[API 错误] [Ollama:transport] 发送请求时出错。 → 无法连接到远程服务器 → 由于目标计算机积极拒绝，无法连接。 127.0.0.1:11434";
    const harness = createHarness({
        selectedText: errorText,
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: errorText,
            suggestion: "（删除此段错误提示内容）",
            reason: "模型认为这是一段连接错误提示",
            confidence: 0.99,
            needsReview: false
        }]
    });

    const result = await harness.window.runProofreading();
    assert.equal(result.accepted, true);
    const issue = harness.window.getWpsProofreadingState().issues[0];
    assert.equal(issue.action, "delete");
    assert.equal(issue.suggestion, "");
    assert.equal(issue.actionable, true);
    assert.equal(issue.needsReview, true);
    assert.equal(issue.reason.includes("（删除此段错误提示内容）"), true);

    assert.equal(await harness.window.applyProofreadingIssue(issue.id), true);
    assert.equal(harness.readDocument(), harness.prefix + harness.suffix);
    assert.equal(harness.readDocument().includes("删除此段错误提示内容"), false);
    assert.equal(await harness.window.undoProofreadingIssue(issue.id), true);
    assert.equal(harness.readDocument(), harness.prefix + errorText + harness.suffix);
});

test("an ambiguous edit annotation is review-only and does not change the document", async () => {
    const selectedText = "这段文字需要核对。";
    const harness = createHarness({
        selectedText,
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "需要核对",
            suggestion: "正确表述（说明：需结合上下文）",
            reason: "模型给出了带编辑注释的建议",
            confidence: 0.99,
            needsReview: false
        }]
    });

    await harness.window.runProofreading();
    const issue = harness.window.getWpsProofreadingState().issues[0];
    const before = harness.readDocument();
    assert.equal(issue.actionable, false);
    assert.equal(issue.needsReview, true);
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(harness.readDocument(), before);
});

test("no request is sent while pane confirmation is pending, and confirming resumes the same full-document run", async () => {
    const harness = createHarness({ noSelection: true, deferConfirmation: true });
    const run = harness.window.runProofreading();
    await harness.confirmationRequested;

    assert.equal(harness.requests.length, 0);
    assert.equal(harness.busy, true);
    assert.equal((await harness.window.runProofreading()).reason, "busy");
    harness.resolveConfirmation(true);
    assert.equal((await run).accepted, true);
    assert.equal(JSON.stringify(harness.sentRequest.body).includes(harness.readDocument()), true);
    assert.equal(harness.busy, false);
});

test("proofreading does not start while rewrite is busy", async () => {
    const harness = createHarness();
    harness.window.getTaskBusyState = () => ({ rewrite: true });
    assert.equal((await harness.window.runProofreading()).reason, "rewrite-busy");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.busy, false);
});

test("cancelling while pane confirmation is pending sends nothing and returns to idle without AbortController", async () => {
    const harness = createHarness({ noSelection: true, deferConfirmation: true });
    const run = harness.window.runProofreading();
    await harness.confirmationRequested;

    assert.equal(harness.window.cancelProofreading(), true);
    assert.equal((await run).reason, "full-document-not-confirmed");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.busy, false);
    assert.match(harness.status.text, /没有发送/);
});

test("appending text while confirmation is pending prevents the old full-document snapshot from being sent", async () => {
    const harness = createHarness({ noSelection: true, deferConfirmation: true });
    const run = harness.window.runProofreading();
    await harness.confirmationRequested;

    harness.changeDocument(harness.readDocument() + "新增内容。");
    harness.resolveConfirmation(true);
    assert.equal((await run).reason, "document-changed-before-request");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.busy, false);
    assert.match(harness.status.text, /文档内容已变化/);
});

test("selected-text proofreading starts without full-document confirmation", async () => {
    const harness = createHarness({ requireSelection: true, deferConfirmation: true });
    assert.equal((await harness.window.runProofreading()).accepted, true);
    assert.equal(harness.confirmationDetails.length, 0);
    assert.equal(harness.confirmMessages.length, 0);
    assert.equal(harness.applicationConfirmMessages.length, 0);
    assert.equal(harness.contentReads, 0);
});

test("a missing pane confirmation API fails without using native confirmation or sending text", async () => {
    const harness = createHarness({ noSelection: true });
    delete harness.window.requestFullDocumentConfirmation;
    assert.equal((await harness.window.runProofreading()).reason, "full-document-confirmation-unavailable");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.confirmMessages.length, 0);
    assert.equal(harness.applicationConfirmMessages.length, 0);
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
    const first = "甲市综协办负责统筹。" + "第一部分工作内容。".repeat(180);
    const second = "甲市综合协调办公室负责统筹。" + "第二部分工作内容。".repeat(180);
    const harness = createHarness({
        selectedText: first + "\n" + second,
        issuesForRequest: ({ body }) => {
            const prompt = body && body.messages && body.messages[0] && body.messages[0].content || "";
            if (prompt.includes("第二遍跨段落一致性复核")) {
                return [{
                    category: "consistency",
                    paragraphIndex: 2,
                    original: "甲市综合协调办公室",
                    suggestion: "甲市综协办",
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
    const first = "第一段由甲市综协办统筹，有错字。" + "第一部分工作内容。".repeat(180);
    const second = "第二段由甲市综合协调办公室协调。" + "第二部分工作内容。".repeat(180);
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

test("long text with no conflicting variants skips the second model pass", async () => {
    const selectedText = Array(200).fill("甲市综协办负责统筹普通工作内容。").join("\n");
    const harness = createHarness({ selectedText, issues: [] });

    const result = await harness.window.runProofreading();

    assert.equal(result.accepted, true);
    assert.equal(result.batches > 1, true);
    assert.equal(result.consistencyAttempted, false);
    assert.equal(harness.requests.length, result.batches);
    assert.equal(harness.requests.some((request) =>
        JSON.stringify(request.body).includes("第二遍跨段落一致性复核")), false);
});

test("many global candidates are reviewed in batches without losing distant groups", async () => {
    const names = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
    const lines = [];
    for (const name of names) lines.push(`${name.repeat(5)}项目定于9月26日启动。`);
    for (const name of names) lines.push(`${name.repeat(5)}项目定于9月27日启动。`);
    const harness = createHarness({ selectedText: lines.join("\n"), issues: [] });

    const result = await harness.window.runProofreading();
    const prompts = harness.requests.map((request) =>
        request.body && request.body.messages && request.body.messages[0].content || "");
    const consistencyPrompts = prompts.filter((prompt) =>
        prompt.includes("第二遍跨段落一致性复核"));

    assert.equal(result.accepted, true);
    assert.equal(result.consistencyCompleted, true);
    assert.equal(consistencyPrompts.length > 1, true);
    assert.equal(harness.requests.length, result.batches + consistencyPrompts.length);
    assert.equal(consistencyPrompts.some((prompt) =>
        prompt.includes("paragraphIndex\":1") && prompt.includes("paragraphIndex\":23")), true);
    assert.equal(consistencyPrompts.some((prompt) =>
        prompt.includes("paragraphIndex\":22") && prompt.includes("paragraphIndex\":44")), true);
    assert.equal(consistencyPrompts.every((prompt) =>
        !prompt.includes("普通正文")), true);
});

test("a document edit during global consistency review discards old findings", async () => {
    const selectedText = "甲市综协办负责统筹，有错字。\n甲市综合协调办公室负责协调。";
    let requestCount = 0;
    let harness;
    harness = createHarness({
        selectedText,
        waitForRequest: () => {
            requestCount += 1;
            if (requestCount === 2) {
                harness.changeDocument(harness.prefix +
                    selectedText.replace("负责协调", "负责处理") + harness.suffix);
            }
        },
        issuesForRequest: ({ body }) => {
            const prompt = body && body.messages && body.messages[0].content || "";
            if (prompt.includes("第二遍跨段落一致性复核")) {
                return [{
                    category: "consistency", paragraphIndex: 2,
                    original: "甲市综合协调办公室", suggestion: "甲市综协办",
                    reason: "请核实", confidence: 0.9, needsReview: false
                }];
            }
            return [{
                category: "typo", paragraphIndex: 1, original: "错字",
                suggestion: "错别字", reason: "错字", confidence: 0.98, needsReview: false
            }];
        }
    });

    const result = await harness.window.runProofreading();

    assert.equal(requestCount, 2);
    assert.equal(result.accepted, false);
    assert.equal(harness.window.getWpsProofreadingState().issues.length, 0);
    assert.equal(harness.renderedIssues.length, 0);
    assert.match(harness.status.text, /结果已丢弃/);
    assert.equal(harness.window.applyAllProofreadingIssues().applied, 0);
    assert.equal(harness.readDocument(), harness.prefix +
        selectedText.replace("负责协调", "负责处理") + harness.suffix);
});


test("semantic local rules run before AI and require individual confirmation", async () => {
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
    assert.equal(harness.statuses.some((item) => /规则扫描完成/.test(item.text)), true);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("本地规则上下文"), true);
    assert.equal(JSON.stringify(harness.requests[0].body).includes("单位名称规范"), true);

    const issues = harness.window.getWpsProofreadingState().issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].category, "rule");
    assert.equal(issues[0].needsReview, true);
    assert.equal(issues[0].actionable, true);

    const applied = harness.window.applyAllProofreadingIssues();
    assert.equal(applied.applied, 0);
    assert.equal(await harness.window.applyProofreadingIssue(issues[0].id), true);
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
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
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

test("AI-confirmed review rules become one applyable finding with rule provenance", async () => {
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
    assert.equal(issues[0].action, "replace");
    assert.equal(issues[0].actionable, true);

    const before = harness.readDocument();
    const batch = harness.window.applyAllProofreadingIssues();
    assert.equal(batch.applied, 0);
    assert.equal(batch.skipped, 1);
    assert.equal(harness.readDocument(), before);

    assert.equal(await harness.window.applyProofreadingIssue(issues[0].id), true);
    assert.equal(harness.readDocument(), harness.prefix +
        "检查发现企业存在高处作业管理不到位问题。" + harness.suffix);
});

test("AI review action stays non-writable when mapped to a matching review rule", async () => {
    const harness = createHarness({
        selectedText: "检查发现企业存在高空作业管理不到位问题。",
        issues: [{
            category: "wording",
            paragraphIndex: 1,
            original: "高空作业",
            suggestion: "高处作业",
            action: "review",
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
    const issue = harness.window.getWpsProofreadingState().issues[0];
    const before = harness.readDocument();
    assert.equal(issue.origin, "ai-review");
    assert.equal(issue.action, "review");
    assert.equal(issue.needsReview, true);
    assert.equal(issue.actionable, false);
    assert.equal(await harness.window.applyProofreadingIssue(issue.id), false);
    assert.equal(harness.readDocument(), before);
});
