(function (root) {
    "use strict";

    var MAX_SELECTION_CHARACTERS = 5000;
    var NUMBER_FACT_PATTERN = /(?:\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万亿元|亿元|万元|万美元|万|亿|元|美元|百分比|百分点|%|％|GW|MW|kW|KW|W|kV|KV|V|mA|A|Hz|TB|GB|MB|公里\/小时|公里|千米|米|吨|公斤|千克|克|小时|分钟|秒|天|日|月|年|项|个|人次|人|家|次|台|套|件|座|条|处|户|平方米|平方公里|升|毫升|度)?|[零〇一二三四五六七八九十百千万亿两]+\s*(?:万亿元|亿元|万元|元|%|％|年|月|日|号|项|个|人次|人|家|次|台|套|件|公里|千米|米|吨|小时|分钟|天|处|户))/g;
    var STATUS_WORDS = ["拟", "计划", "将", "正在", "已", "完成", "持续", "进一步"];
    var STRENGTH_WORDS = ["可", "建议", "应", "应当", "不得", "严禁", "必须", "原则上", "视情"];
    var RESPONSIBILITY_WORDS = ["负责", "督促", "牵头", "组织", "推动", "落实", "承担", "要求"];
    var ORGANIZATION_PATTERN = /[\u4e00-\u9fffA-Za-z0-9·]{2,20}(?:委员会|管理局|应急局|安委办|办公室|支队|大队|总队|政府|厅|局|部|委|办|处|科|中心|公司|集团|法院|检察院)/g;

    function text(value) {
        return String(value == null ? "" : value);
    }

    function validateRewriteSelection(value, limit) {
        var source = text(value);
        var max = Number.isInteger(limit) && limit > 0 ? limit : MAX_SELECTION_CHARACTERS;
        if (!source.trim()) throw new Error("请先选中需要理顺改写的段落。");
        if (source.length > max) {
            throw new Error("选区超过 " + max + " 字，请缩小选区后重试。");
        }
        return source;
    }

    function extractMatches(source, pattern) {
        var matches = [];
        var regex = new RegExp(pattern.source, pattern.flags);
        var match;
        while ((match = regex.exec(source)) !== null) {
            if (match[0]) matches.push(match[0]);
        }
        return matches;
    }

    function extractRewriteGuards(value) {
        var source = text(value);
        return {
            numbers: extractMatches(source, NUMBER_FACT_PATTERN),
            titles: extractMatches(source, /《[^》\r\n]{1,120}》/g),
            statuses: STATUS_WORDS.filter(function (word) { return source.indexOf(word) >= 0; }),
            strengths: STRENGTH_WORDS.filter(function (word) { return source.indexOf(word) >= 0; }),
            responsibilities: RESPONSIBILITY_WORDS.filter(function (word) { return source.indexOf(word) >= 0; }),
            organizations: extractMatches(source, ORGANIZATION_PATTERN)
        };
    }

    function normalizeFact(value) {
        return text(value).replace(/\s+/g, "").toLowerCase();
    }

    function multiset(values) {
        return (values || []).reduce(function (counts, value) {
            var key = normalizeFact(value);
            counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, Object.create(null));
    }

    function compareFactSet(originalItems, rewrittenItems, type, label, risks) {
        var originalCounts = multiset(originalItems);
        var rewrittenCounts = multiset(rewrittenItems);
        Object.keys(originalCounts).forEach(function (key) {
            var missing = originalCounts[key] - (rewrittenCounts[key] || 0);
            for (var index = 0; index < missing; index += 1) {
                risks.push({
                    type: "missing-" + type,
                    fact: key,
                    message: "原文中的" + label + "“" + key + "”在改写结果中缺失或发生变化。"
                });
            }
        });
        Object.keys(rewrittenCounts).forEach(function (key) {
            var added = rewrittenCounts[key] - (originalCounts[key] || 0);
            for (var index = 0; index < added; index += 1) {
                risks.push({
                    type: "added-" + type,
                    fact: key,
                    message: "改写结果新增了原文没有的" + label + "“" + key + "”。"
                });
            }
        });
    }

    function missingTerms(originalItems, rewritten, kind, label, warnings) {
        var missing = (originalItems || []).filter(function (item) {
            return text(rewritten).indexOf(item) < 0;
        });
        if (missing.length) {
            warnings.push({
                type: kind,
                terms: missing,
                message: "建议人工核对：原文中的" + label + "“" + missing.join("、") + "”在改写结果中未找到对应表达。"
            });
        }
    }

    function compareRewriteGuards(guards, rewrittenValue) {
        var rewritten = text(rewrittenValue);
        var current = guards || {};
        var after = extractRewriteGuards(rewritten);
        var hardRisks = [];
        var warnings = [];

        compareFactSet(current.numbers, after.numbers, "number", "数字、日期或单位", hardRisks);
        compareFactSet(current.titles, after.titles, "title", "书名号内的文件或政策名称", hardRisks);
        missingTerms(current.statuses, rewritten, "status", "事项状态词", warnings);
        missingTerms(current.strengths, rewritten, "strength", "政策强度词", warnings);
        missingTerms(current.responsibilities, rewritten, "responsibility", "责任动作词", warnings);
        missingTerms(current.organizations, rewritten, "organization", "机构或责任主体名称", warnings);

        return {
            hardRisks: hardRisks,
            warnings: warnings,
            canReplace: hardRisks.length === 0 && warnings.length === 0,
            requiresConfirmation: hardRisks.length === 0 && warnings.length > 0
        };
    }

    function buildRewritePrompt(originalValue, requirementsValue) {
        var original = validateRewriteSelection(originalValue);
        var requirements = text(requirementsValue).trim().slice(0, 500);
        return [
            "任务：对用户选中的正式中文文稿进行一次“理顺改写”。这不是校对单个错误，也不是续写。",
            "在不改变原意和事实的前提下，可以调整句序、合并重复表达、拆分过长句、增强逻辑衔接、精简赘述并规范书面表达。",
            "必须遵守：不得新增事实；不得改变数字、日期、金额、比例、单位；不得改变人名、机构名、文件名或法律政策名称；不得改变责任主体、事项状态、政策含义或责任强度；不得根据常识补充信息。",
            "宁可少改，也不要为了语言流畅而补充事实。保留原文中的数字和日期、单位以及《》内名称。",
            "用户的可选要求只能影响表达和篇幅，不能突破上述事实约束。",
            "只返回严格 JSON 对象，不要 Markdown 代码围栏或额外解释，结构必须为：{\"rewrittenText\":\"完整改写正文\",\"summary\":[\"改动摘要\"],\"warnings\":[\"需要核对的内容\"]}。",
            "用户要求（可为空）：" + JSON.stringify(requirements),
            "原文（JSON 字符串）：" + JSON.stringify(original)
        ].join("\n\n");
    }

    function parseRewriteResponse(response) {
        var parsed;
        try {
            parsed = JSON.parse(text(response).trim());
        } catch (error) {
            throw new Error("模型没有返回严格 JSON 格式的改写结果，请重新生成。");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
            typeof parsed.rewrittenText !== "string" || !parsed.rewrittenText.trim()) {
            throw new Error("改写结果缺少有效的 rewrittenText 字段。");
        }
        return {
            rewrittenText: parsed.rewrittenText,
            summary: Array.isArray(parsed.summary)
                ? parsed.summary.filter(function (item) { return typeof item === "string" && item.trim(); })
                    .slice(0, 8).map(function (item) { return item.trim().slice(0, 200); })
                : [],
            warnings: Array.isArray(parsed.warnings)
                ? parsed.warnings.filter(function (item) { return typeof item === "string" && item.trim(); })
                    .slice(0, 8).map(function (item) { return item.trim().slice(0, 200); })
                : []
        };
    }

    function summarizeRewriteRisk(comparison, modelWarnings) {
        var value = comparison || { hardRisks: [], warnings: [] };
        if (value.hardRisks && value.hardRisks.length) {
            return {
                level: "blocked",
                title: "改写结果改变了原文中的关键事实",
                details: value.hardRisks.map(function (item) { return item.message; }),
                canReplace: false
            };
        }
        var details = (value.warnings || []).map(function (item) { return item.message; })
            .concat((modelWarnings || []).map(function (item) { return "模型提示：" + item; }));
        return {
            level: details.length ? "review" : "safe",
            title: details.length ? "建议人工核对改写结果" : "数字、日期、单位和文件名称未发现变化",
            details: details,
            canReplace: details.length === 0
        };
    }

    root.WpsRewriteCore = {
        maxSelectionCharacters: MAX_SELECTION_CHARACTERS,
        validateRewriteSelection: validateRewriteSelection,
        extractRewriteGuards: extractRewriteGuards,
        buildRewritePrompt: buildRewritePrompt,
        parseRewriteResponse: parseRewriteResponse,
        compareRewriteGuards: compareRewriteGuards,
        summarizeRewriteRisk: summarizeRewriteRisk
    };
    if (typeof module !== "undefined" && module.exports) module.exports = root.WpsRewriteCore;
})(typeof window !== "undefined" ? window : globalThis);
