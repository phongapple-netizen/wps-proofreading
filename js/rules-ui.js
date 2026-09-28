(function (root) {
    "use strict";

    var lastTestCounts = Object.create(null);
    var builtinCatalog = [];
    var simpleDraftIssueId = "";

    function byId(id) {
        return root.document && root.document.getElementById
            ? root.document.getElementById(id)
            : null;
    }

    function api() {
        return root.WpsRulesCenter || null;
    }

    function setStatus(message, tone) {
        var element = byId("rules-status");
        if (!element) return;
        element.textContent = String(message || "");
        element.className = "status status-" + String(tone || "idle");
    }

    function setOpen(open) {
        var panel = byId("rules-center");
        var toggle = byId("rules-toggle");
        var visible = open === true;
        if (visible && typeof root.openProofreadingSettings === "function") {
            root.openProofreadingSettings();
        }
        if (panel) panel.hidden = !visible;
        if (toggle) {
            toggle.setAttribute("aria-expanded", visible ? "true" : "false");
            toggle.classList.toggle("is-active", visible);
        }
        if (visible) renderRules();
        return visible;
    }

    function typeLabel(type) {
        return type === "regex" ? "正则" :
            type === "reminder" ? "提醒" :
                type === "ai_review" ? "AI核查" : "替换";
    }

    function severityLabel(severity) {
        return severity === "high" ? "高" : severity === "low" ? "低" : "中";
    }

    function clearEditor() {
        [
            "rule-id", "rule-name", "rule-pattern", "rule-flags",
            "rule-replacement", "rule-instruction", "rule-notes"
        ].forEach(function (id) {
            var field = byId(id);
            if (field) field.value = "";
        });
        var group = byId("rule-group");
        var type = byId("rule-type");
        var severity = byId("rule-severity");
        var priority = byId("rule-priority");
        var source = byId("rule-source");
        var autoFix = byId("rule-auto-fix");
        var matchMode = byId("rule-match-mode");
        if (group) group.value = "我的规则";
        if (type) type.value = "replace";
        if (severity) severity.value = "medium";
        if (priority) priority.value = "50";
        if (source) source.value = "用户自定义";
        if (matchMode) matchMode.value = "literal";
        if (autoFix) autoFix.checked = false;
        syncEditorType();
    }

    function syncEditorType() {
        var type = byId("rule-type");
        var matchMode = byId("rule-match-mode");
        var regexOptions = byId("rule-regex-options");
        var aiOptions = byId("rule-ai-review-options");
        var autoFix = byId("rule-auto-fix");
        var replacement = byId("rule-replacement");
        var replacementLabel = byId("rule-replacement-label");
        var value = type ? type.value : "replace";
        var aiReview = value === "ai_review";
        var aiRegex = aiReview && matchMode && matchMode.value === "regex";

        if (aiOptions) aiOptions.hidden = !aiReview;
        if (regexOptions) regexOptions.hidden = !(value === "regex" || aiRegex);
        if (autoFix) {
            if (value === "reminder" || aiReview) autoFix.checked = false;
            autoFix.disabled = value === "reminder" || aiReview;
        }
        if (replacementLabel) {
            replacementLabel.textContent = aiReview ? "参考建议写法（可选）" : "建议写法";
        }
        if (replacement) {
            replacement.placeholder = aiReview
                ? "可留空；仅作为 AI 判断时的参考，不会机械替换"
                : value === "reminder"
                    ? "可留空；如填写则作为人工建议"
                    : "命中后建议替换成的文字";
        }
    }

    function openEditor(rule) {
        var editor = byId("rule-editor");
        if (!editor) return;
        clearEditor();
        var value = rule || {};
        var mapping = {
            "rule-id": value.id || "",
            "rule-name": value.name || "",
            "rule-group": value.group || "我的规则",
            "rule-type": value.type || "replace",
            "rule-pattern": value.pattern || "",
            "rule-flags": value.flags || "",
            "rule-match-mode": value.matchMode || "literal",
            "rule-replacement": value.replacement || "",
            "rule-instruction": value.instruction || "",
            "rule-severity": value.severity || "medium",
            "rule-priority": value.priority == null ? 50 : value.priority,
            "rule-source": value.source || "用户自定义",
            "rule-notes": value.notes || ""
        };
        Object.keys(mapping).forEach(function (id) {
            var field = byId(id);
            if (field) field.value = mapping[id];
        });
        var autoFix = byId("rule-auto-fix");
        if (autoFix) autoFix.checked = value.autoFix === true;
        var deleteButton = byId("rule-delete");
        if (deleteButton) deleteButton.hidden = !value.id;
        syncEditorType();
        editor.hidden = false;
        var name = byId("rule-name");
        if (name && typeof name.focus === "function") name.focus();
    }

    function closeEditor() {
        var editor = byId("rule-editor");
        if (editor) editor.hidden = true;
        clearEditor();
    }

    function closeFixedEditor() {
        var editor = byId("fixed-rule-editor");
        if (editor) editor.hidden = true;
        ["fixed-rule-pattern", "fixed-rule-replacement", "fixed-rule-name", "fixed-rule-notes"]
            .forEach(function (id) {
                var field = byId(id);
                if (field) field.value = "";
            });
        var context = byId("fixed-rule-context");
        if (context) {
            context.hidden = true;
            context.textContent = "";
        }
        simpleDraftIssueId = "";
    }

    function openFixedEditor(issue) {
        var editor = byId("fixed-rule-editor");
        if (!editor || !api()) return false;
        closeEditor();
        closeFixedEditor();
        var value = issue || {};
        var fromIssue = Boolean(issue);
        if (fromIssue && (!value.hasOriginal || !value.hasSuggestion ||
            value.original === value.suggestion || value.actionable === false ||
            value.origin === "rule" ||
            (value.origin === "rule+ai" && value.ruleType === "replace"))) return false;

        var pattern = byId("fixed-rule-pattern");
        var replacement = byId("fixed-rule-replacement");
        var name = byId("fixed-rule-name");
        var notes = byId("fixed-rule-notes");
        if (pattern) pattern.value = fromIssue ? value.original : "";
        if (replacement) replacement.value = fromIssue ? value.suggestion : "";
        if (name) name.value = fromIssue
            ? (value.original + " → " + (value.suggestion || "删除"))
            : "";
        if (notes) notes.value = "";
        var context = byId("fixed-rule-context");
        if (context) {
            context.hidden = !fromIssue;
            context.textContent = fromIssue
                ? "校对建议：" + value.original + " → " + (value.suggestion === "" ? "建议删除" : value.suggestion)
                : "";
        }
        simpleDraftIssueId = fromIssue ? String(value.id || "") : "";
        editor.hidden = false;
        if (typeof editor.scrollIntoView === "function") editor.scrollIntoView({ block: "nearest" });
        if (pattern && !fromIssue && typeof pattern.focus === "function") pattern.focus();
        return true;
    }

    function saveFixedEditor(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (!api() || typeof api().saveUserReplacementRule !== "function") return false;
        function value(id) {
            var field = byId(id);
            return field ? field.value : "";
        }
        try {
            api().saveUserReplacementRule({
                pattern: value("fixed-rule-pattern"),
                replacement: value("fixed-rule-replacement"),
                name: value("fixed-rule-name"),
                notes: value("fixed-rule-notes")
            });
            var issueId = simpleDraftIssueId;
            closeFixedEditor();
            lastTestCounts = Object.create(null);
            renderRules();
            setStatus("规则已保存。", "success");
            if (issueId && typeof root.markProofreadingIssueRuleSaved === "function") {
                root.markProofreadingIssueRuleSaved(issueId);
                if (typeof root.setProofreadingStatus === "function") {
                    root.setProofreadingStatus("已保存为固定替换规则，下次校对时生效。", "success");
                }
            }
            return true;
        } catch (error) {
            var message = error && error.message ? error.message : "规则保存失败。";
            if (message === "已有相同匹配内容但不同替换结果的规则，请到规则中心确认。") {
                closeFixedEditor();
                renderRules();
            }
            setStatus(message, "warning");
            return false;
        }
    }

    function openIssueRuleDraft(issue) {
        setOpen(true);
        var opened = openFixedEditor(issue);
        if (!opened) setStatus("这条建议不能保存为固定替换规则。", "warning");
        return opened;
    }

    function readEditor() {
        function value(id) {
            var field = byId(id);
            return field ? field.value : "";
        }
        var autoFix = byId("rule-auto-fix");
        return {
            id: value("rule-id"),
            name: value("rule-name"),
            group: value("rule-group"),
            type: value("rule-type") || "replace",
            pattern: value("rule-pattern"),
            flags: value("rule-flags"),
            matchMode: value("rule-match-mode") || "literal",
            replacement: value("rule-replacement"),
            instruction: value("rule-instruction"),
            severity: value("rule-severity") || "medium",
            priority: Number(value("rule-priority") || 50),
            autoFix: autoFix ? autoFix.checked === true : false,
            source: value("rule-source"),
            notes: value("rule-notes"),
            enabled: true
        };
    }

    function findRule(id) {
        var center = api();
        if (!center) return null;
        return center.getRules().find(function (rule) {
            return rule.id === String(id);
        }) || null;
    }

    function ruleCard(rule) {
        var card = root.document.createElement("article");
        card.className = "rule-card";
        card.setAttribute("data-rule-id", rule.id);

        var head = root.document.createElement("div");
        head.className = "rule-card-head";

        var title = root.document.createElement("div");
        title.className = "rule-card-title";
        var strong = root.document.createElement("strong");
        strong.textContent = rule.name;
        title.appendChild(strong);

        var meta = root.document.createElement("div");
        meta.className = "rule-meta";
        meta.textContent = rule.group + " · " + typeLabel(rule.type) +
            " · " + severityLabel(rule.severity) + "风险 · 优先级 " + rule.priority;
        if (lastTestCounts[rule.id]) {
            var hit = root.document.createElement("span");
            hit.className = "rule-hit-badge";
            hit.textContent = "命中 " + lastTestCounts[rule.id] + " 处";
            meta.appendChild(hit);
        }
        title.appendChild(meta);
        head.appendChild(title);

        var actions = root.document.createElement("div");
        actions.className = "rule-card-actions";

        var toggleLabel = root.document.createElement("label");
        toggleLabel.className = "rule-toggle";
        var checkbox = root.document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = rule.enabled !== false;
        checkbox.addEventListener("change", function () {
            try {
                api().setRuleEnabled(rule.id, checkbox.checked);
                setStatus(checkbox.checked ? "规则已启用。" : "规则已停用。", "success");
                renderRules();
            } catch (error) {
                checkbox.checked = !checkbox.checked;
                setStatus(error && error.message ? error.message : "规则状态更新失败。", "error");
            }
        });
        var enabledText = root.document.createElement("span");
        enabledText.textContent = "启用";
        toggleLabel.appendChild(checkbox);
        toggleLabel.appendChild(enabledText);
        actions.appendChild(toggleLabel);

        var edit = root.document.createElement("button");
        edit.type = "button";
        edit.className = "issue-action issue-action-secondary";
        edit.textContent = "编辑";
        edit.addEventListener("click", function () { openEditor(rule); });
        actions.appendChild(edit);

        head.appendChild(actions);
        card.appendChild(head);

        var preview = root.document.createElement("p");
        preview.className = "rule-pattern-preview";
        var arrow = rule.type === "reminder"
            ? " → 提醒"
            : rule.type === "ai_review"
                ? " → AI结合上下文核查"
                : " → " + (rule.replacement === "" ? "删除" : rule.replacement);
        preview.textContent = rule.pattern + arrow;
        card.appendChild(preview);

        var source = root.document.createElement("div");
        source.className = "rule-meta";
        source.textContent = "来源：" + (rule.source || "未填写") +
            (rule.type === "ai_review"
                ? " · AI判断后人工确认"
                : (api().isSafeAutoFix(rule) ? " · 可一键修正" : " · 需人工确认"));
        card.appendChild(source);

        return card;
    }

    function renderRules() {
        var center = api();
        var list = byId("rules-list");
        var empty = byId("rules-empty");
        if (!center || !list) return [];
        var rules = center.getRules();
        list.textContent = "";
        var lastGroup = "";
        rules.forEach(function (rule) {
            if (rule.group !== lastGroup) {
                lastGroup = rule.group;
                var groupHeading = root.document.createElement("div");
                groupHeading.className = "rule-group-heading";
                groupHeading.textContent = rule.group;
                list.appendChild(groupHeading);
            }
            list.appendChild(ruleCard(rule));
        });
        list.hidden = rules.length === 0;
        if (empty) empty.hidden = rules.length > 0;
        return rules;
    }

    function saveEditor(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        var center = api();
        if (!center) return false;
        try {
            var draft = readEditor();
            var existing = draft.id ? findRule(draft.id) : null;
            if (existing) draft.enabled = existing.enabled !== false;
            center.saveRule(draft);
            lastTestCounts = Object.create(null);
            closeEditor();
            renderRules();
            setStatus("规则已保存。", "success");
            return true;
        } catch (error) {
            setStatus(error && error.message ? error.message : "规则保存失败。", "error");
            return false;
        }
    }

    function deleteCurrentRule() {
        var idField = byId("rule-id");
        var id = idField ? idField.value : "";
        if (!id || !api()) return false;
        if (typeof root.confirm === "function" && !root.confirm("确定删除这条规则吗？")) return false;
        if (!api().removeRule(id)) {
            setStatus("规则不存在或删除失败。", "warning");
            return false;
        }
        delete lastTestCounts[id];
        closeEditor();
        renderRules();
        setStatus("规则已删除。", "success");
        return true;
    }

    function testDocument() {
        if (!api()) return false;
        try {
            var result = api().testCurrentDocument();
            lastTestCounts = result.byRule || Object.create(null);
            renderRules();
            setStatus("已测试 " + result.characters + " 字，共命中 " + result.count + " 处。", "success");
            return result;
        } catch (error) {
            setStatus(error && error.message ? error.message : "当前文档测试失败。", "error");
            return false;
        }
    }

    function downloadJson(filename, content) {
        if (typeof root.Blob !== "function" || !root.URL ||
            typeof root.URL.createObjectURL !== "function") {
            if (typeof root.prompt === "function") {
                root.prompt("当前内核不能直接下载文件，请复制以下规则 JSON：", content);
                return true;
            }
            return false;
        }
        var blob = new root.Blob([content], { type: "application/json;charset=utf-8" });
        var url = root.URL.createObjectURL(blob);
        var anchor = root.document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        root.document.body.appendChild(anchor);
        anchor.click();
        root.document.body.removeChild(anchor);
        if (typeof root.URL.revokeObjectURL === "function") root.URL.revokeObjectURL(url);
        return true;
    }

    function exportRules() {
        if (!api()) return false;
        try {
            var content = api().exportPack("WPS 校对规则包");
            if (!downloadJson("wps-proofreading-rules.json", content)) {
                throw new Error("当前 WPS 内核不支持规则文件导出。");
            }
            setStatus("规则包已导出。", "success");
            return true;
        } catch (error) {
            setStatus(error && error.message ? error.message : "规则导出失败。", "error");
            return false;
        }
    }

    function updateBuiltinDescription() {
        var select = byId("builtin-rule-pack");
        var description = byId("builtin-rule-description");
        var install = byId("builtin-rule-install");
        var selected = select ? builtinCatalog.find(function (pack) {
            return pack.file === select.value;
        }) : null;
        if (description) {
            description.textContent = selected
                ? selected.description
                : "可直接安装随插件提供的规则包，也可以继续导入自定义 JSON。";
        }
        if (install) install.disabled = !selected;
    }

    async function loadBuiltinCatalog() {
        var select = byId("builtin-rule-pack");
        if (!select || typeof root.fetch !== "function") return false;
        try {
            var response = await root.fetch("../rules/catalog.json", { cache: "no-store" });
            if (!response || !response.ok) throw new Error("catalog");
            var catalog = await response.json();
            builtinCatalog = catalog && Array.isArray(catalog.packs)
                ? catalog.packs.filter(function (pack) {
                    return pack && typeof pack.file === "string" &&
                        /^[a-z0-9-]+\.json$/.test(pack.file) &&
                        typeof pack.name === "string";
                })
                : [];
            select.textContent = "";
            var placeholder = root.document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = builtinCatalog.length ? "选择一个内置规则包" : "暂无可用规则包";
            select.appendChild(placeholder);
            builtinCatalog.forEach(function (pack) {
                var option = root.document.createElement("option");
                option.value = pack.file;
                option.textContent = pack.name;
                select.appendChild(option);
            });
            updateBuiltinDescription();
            if (api() && typeof api().hasStoredRules === "function" &&
                !api().hasStoredRules()) {
                var initialResponse = await root.fetch("../rules/chinese-writing-basic.json", { cache: "no-store" });
                if (!initialResponse || !initialResponse.ok) throw new Error("基础规则包读取失败。");
                api().importPack(await initialResponse.json(), "merge");
                renderRules();
                setStatus("已启用中文及公文基础规范规则。", "success");
            }
            return builtinCatalog.length > 0;
        } catch (error) {
            select.textContent = "";
            var failed = root.document.createElement("option");
            failed.value = "";
            failed.textContent = "内置规则包读取失败";
            select.appendChild(failed);
            updateBuiltinDescription();
            return false;
        }
    }

    async function installBuiltinPack() {
        var select = byId("builtin-rule-pack");
        var selected = select ? builtinCatalog.find(function (pack) {
            return pack.file === select.value;
        }) : null;
        if (!selected || !api() || typeof root.fetch !== "function") return false;

        var install = byId("builtin-rule-install");
        if (install) install.disabled = true;
        setStatus("正在安装“" + selected.name + "”…", "working");
        try {
            var response = await root.fetch("../rules/" + selected.file, { cache: "no-store" });
            if (!response || !response.ok) throw new Error("规则包文件读取失败。");
            var pack = await response.json();
            var result = api().importPack(pack, "merge");
            lastTestCounts = Object.create(null);
            renderRules();
            setStatus("已安装“" + selected.name + "”：新增 " + result.added +
                " 条，更新 " + result.updated + " 条。", "success");
            return result;
        } catch (error) {
            setStatus(error && error.message ? error.message : "内置规则包安装失败。", "error");
            return false;
        } finally {
            updateBuiltinDescription();
        }
    }

    function importFile(file) {
        if (!file || typeof root.FileReader !== "function") {
            setStatus("当前 WPS 内核不支持读取本地规则文件。", "error");
            return false;
        }
        var reader = new root.FileReader();
        reader.onload = function () {
            try {
                var result = api().importPack(String(reader.result || ""), "merge");
                lastTestCounts = Object.create(null);
                renderRules();
                setStatus("导入完成：新增 " + result.added + " 条，更新 " +
                    result.updated + " 条，共 " + result.total + " 条。", "success");
            } catch (error) {
                setStatus(error && error.message ? error.message : "规则导入失败。", "error");
            }
        };
        reader.onerror = function () {
            setStatus("规则文件读取失败。", "error");
        };
        reader.readAsText(file, "utf-8");
        return true;
    }

    function bind() {
        var toggle = byId("rules-toggle");
        var newFixedButton = byId("rule-new-fixed");
        var newAdvancedButton = byId("rule-new-advanced");
        var fixedEditor = byId("fixed-rule-editor");
        var fixedCancel = byId("fixed-rule-cancel");
        var editor = byId("rule-editor");
        var cancel = byId("rule-cancel");
        var remove = byId("rule-delete");
        var type = byId("rule-type");
        var test = byId("rule-test-document");
        var exportButton = byId("rule-export");
        var importButton = byId("rule-import");
        var fileInput = byId("rule-import-file");
        var builtinSelect = byId("builtin-rule-pack");
        var builtinInstall = byId("builtin-rule-install");

        if (toggle) toggle.addEventListener("click", function () {
            var panel = byId("rules-center");
            setOpen(panel ? panel.hidden : true);
        });
        if (newFixedButton) newFixedButton.addEventListener("click", function () { openFixedEditor(null); });
        if (newAdvancedButton) newAdvancedButton.addEventListener("click", function () { openEditor(null); });
        if (fixedEditor) fixedEditor.addEventListener("submit", saveFixedEditor);
        if (fixedCancel) fixedCancel.addEventListener("click", closeFixedEditor);
        if (editor) editor.addEventListener("submit", saveEditor);
        if (cancel) cancel.addEventListener("click", closeEditor);
        if (remove) remove.addEventListener("click", deleteCurrentRule);
        if (type) type.addEventListener("change", syncEditorType);
        var matchMode = byId("rule-match-mode");
        if (matchMode) matchMode.addEventListener("change", syncEditorType);
        if (test) test.addEventListener("click", testDocument);
        if (exportButton) exportButton.addEventListener("click", exportRules);
        if (builtinSelect) builtinSelect.addEventListener("change", updateBuiltinDescription);
        if (builtinInstall) builtinInstall.addEventListener("click", function () {
            installBuiltinPack();
        });
        if (importButton && fileInput) {
            importButton.addEventListener("click", function () { fileInput.click(); });
            fileInput.addEventListener("change", function () {
                var file = fileInput.files && fileInput.files[0];
                importFile(file);
                fileInput.value = "";
            });
        }

        renderRules();
        root.WpsRulesReady = loadBuiltinCatalog();
    }

    root.openRulesCenter = function () { return setOpen(true); };
    root.closeRulesCenter = function () { return setOpen(false); };
    root.renderRulesCenter = renderRules;
    root.testRulesAgainstCurrentDocument = testDocument;
    root.openIssueRuleDraft = openIssueRuleDraft;

    if (root.document) {
        if (root.document.readyState === "loading") {
            root.document.addEventListener("DOMContentLoaded", bind);
        } else {
            bind();
        }
    }
})(typeof window !== "undefined" ? window : globalThis);
