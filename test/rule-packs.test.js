const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const rulesDir = path.join(projectRoot, "rules");
const engineSource = fs.readFileSync(path.join(projectRoot, "js/rules-center.js"), "utf8");
const catalog = JSON.parse(fs.readFileSync(path.join(rulesDir, "catalog.json"), "utf8"));

function createEngine() {
    const storage = new Map();
    const windowObject = {
        localStorage: {
            getItem: (key) => storage.get(key) || "",
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        }
    };
    const context = vm.createContext({ window: windowObject, URL, Date });
    vm.runInContext(engineSource, context, { filename: "rules-center.js" });
    return windowObject.WpsRulesCenter;
}

function readPack(file) {
    return JSON.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
}

test("built-in rule catalog references valid importable packs", () => {
    assert.equal(catalog.version, 1);
    assert.equal(Array.isArray(catalog.packs), true);
    assert.equal(catalog.packs.length, 3);

    const engine = createEngine();
    const seenIds = new Set();

    catalog.packs.forEach((entry) => {
        assert.match(entry.file, /^[a-z0-9-]+\.json$/);
        assert.equal(fs.existsSync(path.join(rulesDir, entry.file)), true);

        const pack = readPack(entry.file);
        assert.equal(pack.format, "wps-text-proofreading-rules");
        assert.equal(pack.version, 1);
        assert.equal(typeof pack.name, "string");
        assert.equal(Array.isArray(pack.rules), true);
        assert.equal(pack.rules.length > 0, true);

        pack.rules.forEach((rule) => {
            assert.equal(typeof rule.id, "string");
            assert.equal(rule.id.length > 0, true);
            assert.equal(seenIds.has(rule.id), false, "duplicate rule id: " + rule.id);
            seenIds.add(rule.id);

            assert.equal(["replace", "regex", "reminder", "ai_review"].includes(rule.type), true);
            assert.equal(typeof rule.pattern, "string");
            assert.equal(rule.pattern.length > 0, true);

            if (rule.autoFix === true) {
                assert.notEqual(rule.type, "reminder", "reminder must not auto-fix: " + rule.id);
                assert.notEqual(rule.type, "ai_review", "AI review must not auto-fix: " + rule.id);
                assert.equal(typeof rule.replacement, "string");
                assert.equal(rule.replacement.length > 0, true, "auto-fix must have replacement: " + rule.id);
            }

            if (rule.type === "regex") {
                assert.equal(typeof rule.replacement, "string");
                assert.equal(rule.replacement.length > 0, true, "regex rules must have explicit replacement: " + rule.id);
            }
        });

        assert.doesNotThrow(() => engine.importPack(pack, "merge"));
    });

    assert.equal(engine.getRules().length, seenIds.size);
});

test("base pack catches a formal date written with 号", () => {
    const engine = createEngine();
    engine.importPack(readPack("chinese-writing-basic.json"), "merge");

    const issues = engine.evaluate("会议于9月26号召开。", 0);
    const date = issues.find((issue) => issue.ruleId === "basic-date-hao-to-ri");

    assert.ok(date);
    assert.equal(date.original, "9月26号");
    assert.equal(date.suggestion, "9月26日");
    assert.equal(date.needsReview, true);
});

test("government pack normalizes a square-bracket document year", () => {
    const engine = createEngine();
    engine.importPack(readPack("party-government-document.json"), "merge");

    const issues = engine.evaluate("韶府[2026]12号", 0);
    const documentNumber = issues.find((issue) => issue.ruleId === "gov-doc-number-square-brackets");

    assert.ok(documentNumber);
    assert.equal(documentNumber.suggestion, "韶府〔2026〕12号");
    assert.equal(documentNumber.needsReview, true);
});

test("work-safety pack catches the wrong confined-space work sequence", () => {
    const engine = createEngine();
    engine.importPack(readPack("work-safety.json"), "merge");

    const issues = engine.evaluate("必须落实先检测、再通风、后作业要求。", 0);
    const confined = issues.find((issue) => issue.ruleId === "safety-confined-order-detect-first");

    assert.ok(confined);
    assert.equal(confined.suggestion, "先通风、再检测、后作业");
    assert.equal(confined.needsReview, true);
});

test("built-in packs include contextual AI review rules with explicit instructions", () => {
    const government = readPack("party-government-document.json");
    const safety = readPack("work-safety.json");
    const aiRules = government.rules.concat(safety.rules)
        .filter((rule) => rule.type === "ai_review");

    assert.equal(aiRules.length, 8);
    aiRules.forEach((rule) => {
        assert.equal(rule.enabled, true);
        assert.equal(rule.autoFix, false);
        assert.equal(typeof rule.instruction, "string");
        assert.equal(rule.instruction.length > 20, true, "instruction too short: " + rule.id);
        assert.equal(["literal", "regex"].includes(rule.matchMode), true);
    });

    assert.equal(
        government.rules.find((rule) => rule.id === "gov-report-with-request").type,
        "ai_review"
    );
    assert.equal(
        safety.rules.find((rule) => rule.id === "safety-high-altitude-work").type,
        "ai_review"
    );
    assert.equal(
        safety.rules.find((rule) => rule.id === "safety-major-hidden-danger-term").type,
        "ai_review"
    );
});

test("context-sensitive abbreviation reminders are disabled by default", () => {
    const base = readPack("party-government-document.json");
    const safety = readPack("work-safety.json");

    assert.equal(base.rules.find((rule) => rule.id === "gov-short-name-first-use").enabled, false);
    assert.equal(base.rules.find((rule) => rule.id === "gov-title-punctuation").enabled, false);
    assert.equal(safety.rules.find((rule) => rule.id === "safety-hazchem-short-name").enabled, false);
    assert.equal(safety.rules.find((rule) => rule.id === "safety-two-key-one-major").enabled, false);
});
