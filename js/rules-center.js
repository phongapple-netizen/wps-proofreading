(function (root) {
    "use strict";

    var STORAGE_KEY = "wps_text_proofreading_rules_v1";
    var SCHEMA_VERSION = 1;
    var MAX_RULES = 1000;
    var SAFE_AUTOFIX = {
        "basic-space-before-cn-punct": ["[ \\t]+([，。；：！？])", "$1"],
        "basic-duplicate-comma": ["，{2,}", "，"],
        "basic-duplicate-period": ["。{2,}", "。"],
        "basic-duplicate-semicolon": ["；{2,}", "；"],
        "basic-ascii-comma-between-hanzi": ["([\\u4e00-\\u9fff]),([\\u4e00-\\u9fff])", "$1，$2"],
        "basic-ascii-colon-between-hanzi": ["([\\u4e00-\\u9fff]):([\\u4e00-\\u9fff])", "$1：$2"]
    };
    var idCounter = 0;

    function text(value) {
        return String(value == null ? "" : value);
    }

    function trim(value, max) {
        var result = text(value).trim();
        return typeof max === "number" ? result.slice(0, max) : result;
    }

    function getStorage() {
        try {
            if (root.localStorage && typeof root.localStorage.getItem === "function" &&
                typeof root.localStorage.setItem === "function") {
                return root.localStorage;
            }
        } catch (error) {
            // Continue with WPS storage.
        }
        try {
            var api = root.WpsNativeDocument;
            var storage = api && api.getPluginStorage ? api.getPluginStorage() : null;
            if (storage && typeof storage.getItem === "function" &&
                typeof storage.setItem === "function") {
                return storage;
            }
        } catch (error) {
            // No persistent storage is available.
        }
        return null;
    }

    function readState() {
        var storage = getStorage();
        if (!storage) return { version: SCHEMA_VERSION, rules: [] };
        try {
            var parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
            if (!parsed || !Array.isArray(parsed.rules)) {
                return { version: SCHEMA_VERSION, rules: [] };
            }
            return {
                version: SCHEMA_VERSION,
                rules: parsed.rules.slice(0, MAX_RULES).map(safelyReadRule).filter(Boolean)
            };
        } catch (error) {
            return { version: SCHEMA_VERSION, rules: [] };
        }
    }

    function hasStoredRules() {
        var storage = getStorage();
        if (!storage) return false;
        try {
            var saved = storage.getItem(STORAGE_KEY);
            return saved !== null && saved !== "";
        } catch (error) { return false; }
    }

    function writeState(state) {
        var storage = getStorage();
        if (!storage) return false;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify({
                version: SCHEMA_VERSION,
                rules: (state && Array.isArray(state.rules) ? state.rules : [])
                    .slice(0, MAX_RULES)
                    .map(safelyReadRule)
                    .filter(Boolean)
            }));
            return true;
        } catch (error) {
            return false;
        }
    }

    function newId(prefix) {
        idCounter += 1;
        return (prefix || "rule") + "-" + Date.now().toString(36) + "-" + idCounter.toString(36);
    }

    function normalizeFlags(value) {
        var flags = trim(value, 8).replace(/[^imsu]/g, "");
        var unique = "";
        for (var index = 0; index < flags.length; index += 1) {
            if (unique.indexOf(flags.charAt(index)) < 0) unique += flags.charAt(index);
        }
        return unique;
    }

    function normalizeRule(candidate) {
        var value = candidate && typeof candidate === "object" ? candidate : {};
        var type = ["replace", "regex", "reminder", "ai_review"].indexOf(value.type) >= 0
            ? value.type
            : "replace";
        var pattern = trim(value.pattern, 500);
        if (!pattern) return null;
        var severity = ["low", "medium", "high"].indexOf(value.severity) >= 0
            ? value.severity
            : "medium";
        var priority = Number(value.priority);
        if (!Number.isFinite(priority)) priority = 50;
        priority = Math.max(0, Math.min(1000, Math.round(priority)));
        var replacement = text(value.replacement).slice(0, 1000);
        var matchMode = value.matchMode === "regex" ? "regex" : "literal";
        var instruction = trim(value.instruction, 1200);

        return {
            id: trim(value.id, 120) || newId("rule"),
            name: trim(value.name, 120) || pattern.slice(0, 40),
            enabled: value.enabled !== false,
            group: trim(value.group, 80) || "我的规则",
            type: type,
            pattern: pattern,
            flags: type === "regex" || (type === "ai_review" && matchMode === "regex")
                ? normalizeFlags(value.flags)
                : "",
            matchMode: type === "ai_review" ? matchMode : "",
            replacement: replacement,
            instruction: type === "ai_review" ? instruction : "",
            severity: severity,
            autoFix: type !== "reminder" && type !== "ai_review" &&
                value.autoFix === true && replacement !== "",
            priority: priority,
            source: trim(value.source, 160) || "用户自定义",
            notes: trim(value.notes, 500)
        };
    }

    function getRules() {
        return readState().rules.slice().sort(function (left, right) {
            return right.priority - left.priority ||
                left.group.localeCompare(right.group) ||
                left.name.localeCompare(right.name);
        });
    }

    function validateRule(rule) {
        if (!rule) throw new Error("规则必须填写匹配内容。");
        if (rule.type === "ai_review" && !rule.instruction) {
            throw new Error("AI核查规则「" + (rule.name || rule.pattern) + "」必须填写核查要求。");
        }
        var usesRegex = rule.type === "regex" ||
            (rule.type === "ai_review" && rule.matchMode === "regex");
        if (!usesRegex) return rule;
        // Quantifying a group with another variable-width expression can freeze
        // WPS's synchronous JavaScript thread on a short malicious input.
        if (/\\[1-9]|\([^)]*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(rule.pattern)) {
            throw new Error("规则「" + (rule.name || rule.pattern) + "」包含可能导致卡顿的正则结构。");
        }
        if (/\$[`']/.test(rule.replacement)) {
            throw new Error("规则替换内容不能引用整段匹配前后的文本。");
        }
        try {
            var regex = new RegExp(rule.pattern, rule.flags + "g");
            var probe = regex.exec("");
            if (probe && probe[0] === "") throw new Error("empty");
        } catch (error) {
            throw new Error("规则「" + (rule.name || rule.pattern) +
                "」的正则表达式无效，或可能匹配空字符串。");
        }
        return rule;
    }

    function safelyReadRule(candidate) {
        var rule = normalizeRule(candidate);
        if (!rule) return null;
        try { return validateRule(rule); }
        catch (error) { return null; }
    }

    function saveRule(candidate) {
        var rule = validateRule(normalizeRule(candidate));
        var state = readState();
        var found = false;
        state.rules = state.rules.map(function (existing) {
            if (existing.id !== rule.id) return existing;
            found = true;
            return rule;
        });
        if (!found) {
            if (state.rules.length >= MAX_RULES) {
                throw new Error("规则数量已达到 " + MAX_RULES + " 条上限。");
            }
            state.rules.push(rule);
        }
        if (!writeState(state)) throw new Error("规则保存失败，当前环境没有可用存储。");
        return rule;
    }

    function saveUserReplacementRule(candidate) {
        var value = candidate && typeof candidate === "object" ? candidate : {};
        var pattern = trim(value.pattern, 500);
        var replacement = text(value.replacement).slice(0, 1000);
        if (!pattern) throw new Error("查找文字不能为空。");
        if (pattern === replacement) throw new Error("查找文字和替换文字不能完全相同。");

        var rules = getRules();
        var exact = rules.some(function (rule) {
            return rule.type === "replace" && rule.pattern === pattern &&
                rule.replacement === replacement;
        });
        if (exact) throw new Error("这条固定替换规则已经存在。");
        var conflicting = rules.some(function (rule) {
            return rule.type === "replace" && rule.pattern === pattern &&
                rule.replacement !== replacement;
        });
        if (conflicting) {
            throw new Error("已有相同匹配内容但不同替换结果的规则，请到规则中心确认。");
        }

        var rule = createRule({
            name: trim(value.name, 120) || (pattern + " → " + (replacement || "删除")),
            group: "我的规则",
            type: "replace",
            pattern: pattern,
            replacement: replacement,
            severity: "medium",
            autoFix: false,
            priority: 50,
            source: "用户自定义",
            notes: value.notes
        });
        return saveRule(rule);
    }

    function removeRule(id) {
        var key = text(id);
        var state = readState();
        var before = state.rules.length;
        state.rules = state.rules.filter(function (rule) { return rule.id !== key; });
        if (state.rules.length === before) return false;
        return writeState(state);
    }

    function setRuleEnabled(id, enabled) {
        var rules = getRules();
        var rule = rules.find(function (item) { return item.id === text(id); });
        if (!rule) return false;
        rule.enabled = enabled === true;
        saveRule(rule);
        return true;
    }

    function clearRules() {
        return writeState({ version: SCHEMA_VERSION, rules: [] });
    }

    function escapeRegex(value) {
        return text(value).replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
    }

    function replacementForRegex(rule, match) {
        return rule.replacement.replace(/\$(\$|&|\d{1,2})/g, function (token, reference) {
            if (reference === "$") return "$";
            if (reference === "&") return match[0];
            var index = Number(reference);
            return index > 0 && index < match.length
                ? text(match[index]) : token;
        });
    }

    function safeAutoFix(rule) {
        var signature = SAFE_AUTOFIX[rule.id];
        return Boolean(rule.autoFix && rule.type === "regex" && !rule.flags &&
            signature && rule.pattern === signature[0] && rule.replacement === signature[1]);
    }

    function candidatesForRule(rule, value, baseStart) {
        var matches = [];
        var regex;
        try {
            regex = rule.type === "regex"
                ? new RegExp(rule.pattern, rule.flags + "g")
                : new RegExp(escapeRegex(rule.pattern), "g");
        } catch (error) {
            return matches;
        }

        var match;
        var guard = 0;
        while ((match = regex.exec(value)) !== null && guard < 5000) {
            guard += 1;
            if (!match[0]) {
                regex.lastIndex += 1;
                continue;
            }
            var original = match[0];
            var suggestion = rule.type === "regex"
                ? replacementForRegex(rule, match)
                : rule.replacement;
            var actionable = suggestion !== "" || rule.type !== "reminder";
            if (rule.type === "reminder" && !rule.replacement) {
                suggestion = original;
                actionable = false;
            }
            if (suggestion === original && rule.type !== "reminder") continue;

            matches.push({
                id: "rule-" + rule.id + "-" + (baseStart + match.index),
                category: "rule",
                origin: "rule",
                ruleId: rule.id,
                ruleName: rule.name,
                ruleGroup: rule.group,
                ruleSource: rule.source,
                ruleType: rule.type,
                severity: rule.severity,
                priority: rule.priority,
                original: original,
                suggestion: suggestion,
                reason: rule.notes || ("命中规则「" + rule.name + "」" +
                    (rule.source ? "；来源：" + rule.source : "")),
                confidence: 1,
                needsReview: rule.type === "reminder" || !safeAutoFix(rule),
                autoFixable: safeAutoFix(rule),
                actionable: actionable,
                start: baseStart + match.index,
                end: baseStart + match.index + original.length,
                status: "pending"
            });
        }
        return matches;
    }

    function overlaps(left, right) {
        return left.start < right.end && right.start < left.end;
    }

    function evaluate(value, baseStart) {
        var source = text(value);
        var start = Number(baseStart) || 0;
        var candidates = [];

        getRules().filter(function (rule) {
            return rule.enabled && rule.type !== "ai_review";
        }).forEach(function (rule) {
            candidates = candidates.concat(candidatesForRule(rule, source, start));
        });

        candidates.sort(function (left, right) {
            return right.priority - left.priority ||
                left.start - right.start ||
                left.end - right.end;
        });

        var selected = [];
        candidates.forEach(function (candidate) {
            var conflict = selected.some(function (existing) {
                return overlaps(candidate, existing);
            });
            if (!conflict) selected.push(candidate);
        });

        selected.sort(function (left, right) {
            return left.start - right.start || left.end - right.end;
        });
        return selected;
    }

    function aiReviewCandidatesForRule(rule, value, baseStart) {
        var matches = [];
        var regex;
        try {
            regex = rule.matchMode === "regex"
                ? new RegExp(rule.pattern, rule.flags + "g")
                : new RegExp(escapeRegex(rule.pattern), "g");
        } catch (error) {
            return matches;
        }

        var match;
        var guard = 0;
        while ((match = regex.exec(value)) !== null && guard < 5000) {
            guard += 1;
            if (!match[0]) {
                regex.lastIndex += 1;
                continue;
            }
            matches.push({
                id: "ai-review-" + rule.id + "-" + (baseStart + match.index),
                ruleId: rule.id,
                ruleName: rule.name,
                ruleGroup: rule.group,
                ruleSource: rule.source,
                severity: rule.severity,
                priority: rule.priority,
                trigger: match[0],
                preferredSuggestion: rule.replacement || "",
                instruction: rule.instruction,
                start: baseStart + match.index,
                end: baseStart + match.index + match[0].length
            });
        }
        return matches;
    }

    function collectAiReviewCandidates(value, baseStart) {
        var source = text(value);
        var start = Number(baseStart) || 0;
        var candidates = [];

        getRules().filter(function (rule) {
            return rule.enabled && rule.type === "ai_review";
        }).forEach(function (rule) {
            candidates = candidates.concat(aiReviewCandidatesForRule(rule, source, start));
        });

        candidates.sort(function (left, right) {
            return left.start - right.start ||
                (Number(right.priority) || 0) - (Number(left.priority) || 0) ||
                left.end - right.end;
        });
        return candidates;
    }

    function summarizeMatches(value) {
        var issues = evaluate(value, 0);
        var aiReviewCandidates = collectAiReviewCandidates(value, 0);
        var counts = Object.create(null);
        issues.concat(aiReviewCandidates).forEach(function (item) {
            counts[item.ruleId] = (counts[item.ruleId] || 0) + 1;
        });
        return {
            count: issues.length + aiReviewCandidates.length,
            byRule: counts,
            issues: issues,
            aiReviewCandidates: aiReviewCandidates
        };
    }

    function readCurrentDocument() {
        try {
            var application = root.WpsNativeDocument && root.WpsNativeDocument.getApplication
                ? root.WpsNativeDocument.getApplication()
                : null;
            var document = application && application.ActiveDocument ? application.ActiveDocument : null;
            var content = document && document.Content ? document.Content : null;
            return {
                text: content ? text(content.Text) : "",
                start: content && Number.isFinite(Number(content.Start)) ? Number(content.Start) : 0
            };
        } catch (error) {
            return { text: "", start: 0 };
        }
    }

    function testCurrentDocument() {
        var document = readCurrentDocument();
        if (!document.text.trim()) {
            throw new Error("当前文档没有可测试的文字。");
        }
        var result = summarizeMatches(document.text);
        result.characters = document.text.length;
        return result;
    }

    function exportPack(name) {
        return JSON.stringify({
            format: "wps-text-proofreading-rules",
            version: SCHEMA_VERSION,
            name: trim(name, 120) || "WPS 校对规则包",
            exportedAt: new Date().toISOString(),
            rules: getRules()
        }, null, 2);
    }

    function importPack(input, mode) {
        var parsed;
        try {
            parsed = typeof input === "string" ? JSON.parse(input) : input;
        } catch (error) {
            throw new Error("规则包不是有效的 JSON。");
        }
        if (!parsed || !Array.isArray(parsed.rules)) {
            throw new Error("规则包缺少 rules 数组。");
        }
        if (parsed.rules.length > MAX_RULES) {
            throw new Error("单个规则包不能超过 " + MAX_RULES + " 条规则。");
        }

        var incoming = parsed.rules.map(normalizeRule).filter(Boolean).map(validateRule);
        var state = mode === "replace"
            ? { version: SCHEMA_VERSION, rules: [] }
            : readState();
        var byId = Object.create(null);
        state.rules.forEach(function (rule, index) { byId[rule.id] = index; });
        var added = 0;
        var updated = 0;

        incoming.forEach(function (rule) {
            if (byId[rule.id] != null) {
                state.rules[byId[rule.id]] = rule;
                updated += 1;
            } else if (state.rules.length < MAX_RULES) {
                state.rules.push(rule);
                byId[rule.id] = state.rules.length - 1;
                added += 1;
            }
        });

        if (!writeState(state)) throw new Error("规则导入失败，当前环境没有可用存储。");
        return { added: added, updated: updated, total: state.rules.length };
    }

    function createRule(overrides) {
        return normalizeRule(Object.assign({
            id: newId("rule"),
            name: "",
            enabled: true,
            group: "我的规则",
            type: "replace",
            pattern: "",
            matchMode: "literal",
            replacement: "",
            instruction: "",
            severity: "medium",
            autoFix: false,
            priority: 50,
            source: "用户自定义",
            notes: ""
        }, overrides || {}));
    }

    root.WpsRulesCenter = {
        STORAGE_KEY: STORAGE_KEY,
        schemaVersion: SCHEMA_VERSION,
        maxRules: MAX_RULES,
        getRules: getRules,
        hasStoredRules: hasStoredRules,
        isSafeAutoFix: function (candidate) { return safeAutoFix(normalizeRule(candidate)); },
        saveRule: saveRule,
        removeRule: removeRule,
        setRuleEnabled: setRuleEnabled,
        clearRules: clearRules,
        createRule: createRule,
        saveUserReplacementRule: saveUserReplacementRule,
        evaluate: evaluate,
        collectAiReviewCandidates: collectAiReviewCandidates,
        summarizeMatches: summarizeMatches,
        testCurrentDocument: testCurrentDocument,
        exportPack: exportPack,
        importPack: importPack
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = root.WpsRulesCenter;
    }
})(typeof window !== "undefined" ? window : globalThis);
