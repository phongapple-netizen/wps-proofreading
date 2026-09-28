const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "js/rules-center.js"), "utf8");

function createHarness(documentText = "测试正文") {
    const storage = new Map();
    const windowObject = {
        localStorage: {
            getItem: (key) => storage.get(key) || "",
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        WpsNativeDocument: {
            getApplication: () => ({
                ActiveDocument: {
                    Content: { Text: documentText, Start: 0 }
                }
            })
        }
    };
    const context = vm.createContext({ window: windowObject, URL, Date });
    vm.runInContext(source, context, { filename: "rules-center.js" });
    return { api: windowObject.WpsRulesCenter, storage };
}

test("literal, regex and reminder rules produce safe local findings", () => {
    const { api } = createHarness();

    api.saveRule({
        id: "literal",
        name: "单位名称",
        group: "单位规范",
        type: "replace",
        pattern: "旧名称",
        replacement: "新名称",
        autoFix: true,
        priority: 100,
        source: "单位规范"
    });
    api.saveRule({
        id: "regex",
        name: "日期用日",
        type: "regex",
        pattern: "(\\d{1,2})号",
        replacement: "$1日",
        autoFix: false,
        priority: 80
    });
    api.saveRule({
        id: "reminder",
        name: "敏感表述复核",
        type: "reminder",
        pattern: "绝对安全",
        replacement: "",
        autoFix: true,
        priority: 60
    });

    const issues = api.evaluate("旧名称于9月26号表示绝对安全。", 10);
    assert.equal(issues.length, 3);

    const literal = issues.find((issue) => issue.ruleId === "literal");
    assert.equal(literal.suggestion, "新名称");
    assert.equal(literal.needsReview, true);
    assert.equal(literal.autoFixable, false);
    assert.equal(literal.actionable, true);
    assert.equal(literal.start, 10);

    const regex = issues.find((issue) => issue.ruleId === "regex");
    assert.equal(regex.original, "26号");
    assert.equal(regex.suggestion, "26日");
    assert.equal(regex.needsReview, true);

    const reminder = issues.find((issue) => issue.ruleId === "reminder");
    assert.equal(reminder.actionable, false);
    assert.equal(reminder.needsReview, true);
    assert.equal(reminder.suggestion, reminder.original);
});

test("first-run marker survives an intentional clear", () => {
    const { api } = createHarness();
    assert.equal(api.hasStoredRules(), false);
    api.saveRule({ id: "sample", pattern: "甲", replacement: "乙" });
    assert.equal(api.hasStoredRules(), true);
    api.clearRules();
    assert.equal(api.hasStoredRules(), true);
    assert.equal(api.getRules().length, 0);
});

test("regex lookahead keeps the original context and nested quantified groups are rejected", () => {
    const { api } = createHarness();
    api.saveRule({ id: "lookahead", type: "regex", pattern: "甲(?=乙)", replacement: "丙" });
    const issues = api.evaluate("甲乙", 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].suggestion, "丙");
    assert.throws(() => api.saveRule({
        id: "unsafe", type: "regex", pattern: "(a+)+$", replacement: "x"
    }), /卡顿/);
});

test("previously stored unsafe regex rules are ignored on load", () => {
    const { api, storage } = createHarness();
    storage.set(api.STORAGE_KEY, JSON.stringify({ rules: [{
        id: "old-unsafe", type: "regex", pattern: "(a+)+$", replacement: "x"
    }] }));
    assert.equal(api.getRules().length, 0);
});

test("higher-priority overlapping rules win deterministically", () => {
    const { api } = createHarness();
    api.saveRule({
        id: "low",
        name: "短规则",
        type: "replace",
        pattern: "安全生产",
        replacement: "生产安全",
        priority: 10
    });
    api.saveRule({
        id: "high",
        name: "长规则",
        type: "replace",
        pattern: "安全生产工作",
        replacement: "安全工作",
        priority: 100
    });

    const issues = api.evaluate("抓好安全生产工作。", 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ruleId, "high");
    assert.equal(issues[0].original, "安全生产工作");
});

test("disabled rules do not run and can be re-enabled", () => {
    const { api } = createHarness();
    api.saveRule({
        id: "toggle",
        name: "切换规则",
        type: "replace",
        pattern: "甲",
        replacement: "乙",
        enabled: false
    });

    assert.equal(api.evaluate("甲", 0).length, 0);
    assert.equal(api.setRuleEnabled("toggle", true), true);
    assert.equal(api.evaluate("甲", 0).length, 1);
});

test("rule packs export and merge-import without duplicating stable ids", () => {
    const first = createHarness();
    first.api.saveRule({
        id: "shared-rule",
        name: "原规则",
        type: "replace",
        pattern: "旧",
        replacement: "新"
    });
    const exported = first.api.exportPack("测试规则包");
    const parsed = JSON.parse(exported);
    assert.equal(parsed.format, "wps-text-proofreading-rules");
    assert.equal(parsed.rules.length, 1);

    parsed.rules[0].name = "更新后的规则";
    parsed.rules.push({
        id: "new-rule",
        name: "新增规则",
        type: "reminder",
        pattern: "提醒词",
        replacement: ""
    });

    const second = createHarness();
    second.api.saveRule({
        id: "shared-rule",
        name: "本地旧版本",
        type: "replace",
        pattern: "旧",
        replacement: "旧建议"
    });
    const result = second.api.importPack(JSON.stringify(parsed), "merge");

    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.total, 2);
    assert.equal(second.api.getRules().find((rule) => rule.id === "shared-rule").name, "更新后的规则");
});

test("current-document test returns per-rule hit counts without editing text", () => {
    const { api } = createHarness("甲甲乙。");
    api.saveRule({
        id: "a",
        name: "甲转丙",
        type: "replace",
        pattern: "甲",
        replacement: "丙",
        autoFix: true
    });

    const result = api.testCurrentDocument();
    assert.equal(result.characters, 4);
    assert.equal(result.count, 2);
    assert.equal(result.byRule.a, 2);
});

test("invalid or empty-match regex rules are rejected", () => {
    const { api } = createHarness();
    assert.throws(() => api.saveRule({
        name: "坏正则",
        type: "regex",
        pattern: "(",
        replacement: "x"
    }), /正则表达式无效/);

    assert.throws(() => api.saveRule({
        name: "空匹配",
        type: "regex",
        pattern: "a*",
        replacement: "x"
    }), /正则表达式无效/);
});


test("AI review rules create candidates but do not become immediate findings", () => {
    const { api } = createHarness();
    api.saveRule({
        id: "ai-review",
        name: "术语上下文核查",
        type: "ai_review",
        pattern: "高空作业",
        matchMode: "literal",
        replacement: "高处作业",
        instruction: "只有在安全生产专业语境中才建议改为高处作业。",
        autoFix: true,
        priority: 90,
        source: "专业术语"
    });

    assert.equal(api.evaluate("这里提到高空作业。", 5).length, 0);

    const candidates = api.collectAiReviewCandidates("这里提到高空作业。", 5);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].ruleId, "ai-review");
    assert.equal(candidates[0].trigger, "高空作业");
    assert.equal(candidates[0].preferredSuggestion, "高处作业");
    assert.equal(candidates[0].start, 9);

    const saved = api.getRules().find((rule) => rule.id === "ai-review");
    assert.equal(saved.autoFix, false);
    assert.equal(saved.instruction.includes("专业语境"), true);
});

test("AI review rules support regex triggers and are included in document hit counts", () => {
    const { api } = createHarness("报告中写明：妥否，请批示。");
    api.saveRule({
        id: "ai-regex",
        name: "请示语气核查",
        type: "ai_review",
        pattern: "妥否[，,]请批示",
        matchMode: "regex",
        flags: "",
        instruction: "结合文种判断是否属于报告夹带请示事项。"
    });

    const result = api.testCurrentDocument();
    assert.equal(result.count, 1);
    assert.equal(result.byRule["ai-regex"], 1);
    assert.equal(result.issues.length, 0);
    assert.equal(result.aiReviewCandidates.length, 1);
});

test("AI review rules require an instruction and reject empty-match regex triggers", () => {
    const { api } = createHarness();

    assert.throws(() => api.saveRule({
        name: "缺少要求",
        type: "ai_review",
        pattern: "关键词",
        instruction: ""
    }), /必须填写核查要求/);

    assert.throws(() => api.saveRule({
        name: "空匹配AI核查",
        type: "ai_review",
        pattern: "a*",
        matchMode: "regex",
        instruction: "结合上下文判断。"
    }), /正则表达式无效/);
});

test("user replacement rules use safe defaults and run on the next local evaluation", () => {
    const { api } = createHarness();
    const saved = api.saveUserReplacementRule({
        pattern: "市消防救援支队",
        replacement: "市消防救援局",
        name: "消防机构名称规范",
        notes: "按最新机构名称统一"
    });

    assert.equal(saved.type, "replace");
    assert.equal(saved.group, "我的规则");
    assert.equal(saved.enabled, true);
    assert.equal(saved.autoFix, false);
    assert.equal(saved.priority, 50);
    assert.equal(saved.severity, "medium");
    assert.equal(saved.source, "用户自定义");
    assert.equal(saved.notes, "按最新机构名称统一");
    assert.equal(api.isSafeAutoFix(saved), false);

    const issue = api.evaluate("市消防救援支队已到场。", 0)[0];
    assert.equal(issue.original, "市消防救援支队");
    assert.equal(issue.suggestion, "市消防救援局");
    assert.equal(issue.autoFixable, false);
    assert.equal(issue.actionable, true);
});

test("user replacement rules reject exact duplicates and conflicting replacements without overwriting", () => {
    const { api } = createHarness();
    const original = api.saveUserReplacementRule({ pattern: "旧名称", replacement: "新名称A" });

    assert.throws(() => api.saveUserReplacementRule({
        pattern: "旧名称", replacement: "新名称A"
    }), /这条固定替换规则已经存在/);
    assert.throws(() => api.saveUserReplacementRule({
        pattern: "旧名称", replacement: "新名称B"
    }), /已有相同匹配内容但不同替换结果的规则，请到规则中心确认/);
    assert.equal(JSON.stringify(api.getRules().map((rule) => [rule.id, rule.replacement])),
        JSON.stringify([[original.id, "新名称A"]]));
});

test("user replacement rules allow deletion suggestions and reject empty or identical pairs", () => {
    const { api } = createHarness();
    assert.throws(() => api.saveUserReplacementRule({ pattern: "", replacement: "建议" }), /查找文字不能为空/);
    assert.throws(() => api.saveUserReplacementRule({ pattern: "相同", replacement: "相同" }), /不能完全相同/);

    const saved = api.saveUserReplacementRule({ pattern: "多余词", replacement: "" });
    const issue = api.evaluate("这里有多余词。", 0)[0];
    assert.equal(saved.replacement, "");
    assert.equal(issue.suggestion, "");
    assert.equal(issue.actionable, true);
    assert.equal(issue.autoFixable, false);
});

test("stored advanced rule types remain readable and executable alongside user rules", () => {
    const first = createHarness();
    first.api.saveRule({ id: "kept-regex", type: "regex", pattern: "(\\d+)号", replacement: "$1日" });
    first.api.saveRule({ id: "kept-reminder", type: "reminder", pattern: "绝对安全", replacement: "" });
    first.api.saveRule({
        id: "kept-ai", type: "ai_review", pattern: "高空作业", matchMode: "literal",
        instruction: "结合上下文核查是否应使用规范术语。"
    });
    first.api.saveUserReplacementRule({ pattern: "旧称", replacement: "新称" });

    const second = createHarness();
    second.storage.set(second.api.STORAGE_KEY,
        first.storage.get(first.api.STORAGE_KEY));
    assert.equal(JSON.stringify(Array.from(second.api.getRules(), (rule) => rule.id).sort()),
        JSON.stringify(["kept-ai", "kept-regex", "kept-reminder",
            second.api.getRules().find((rule) => rule.pattern === "旧称").id].sort()));
    const issues = second.api.evaluate("9号，绝对安全，旧称", 0);
    assert.equal(issues.some((issue) => issue.ruleId === "kept-regex" && issue.suggestion === "9日"), true);
    assert.equal(issues.some((issue) => issue.ruleId === "kept-reminder" && issue.actionable === false), true);
    assert.equal(issues.some((issue) => issue.original === "旧称" && issue.suggestion === "新称"), true);
    assert.equal(second.api.collectAiReviewCandidates("高空作业", 0)[0].ruleId, "kept-ai");
});
