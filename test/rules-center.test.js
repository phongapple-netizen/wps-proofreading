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
    assert.equal(literal.needsReview, false);
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
