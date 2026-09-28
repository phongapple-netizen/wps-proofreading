(function (root) {
    "use strict";

    var ANCHOR_CHARACTERS = 40;
    var REWRITE_SYSTEM_PROMPT = "你是一名中文正式文稿编辑，专门对用户选中的文字进行理顺改写。" +
        "只处理用户提供的选区，不续写、不补充常识、不调用工具。宁可少改，也不要为了语言流畅而改变任何事实。" +
        "必须只按要求返回严格 JSON。";
    var result = null;
    var undoRecord = null;
    var controller = null;
    var busy = false;
    var operationCounter = 0;

    function byId(id) {
        return root.document && root.document.getElementById
            ? root.document.getElementById(id) : null;
    }

    function text(value) { return String(value == null ? "" : value); }
    function normalizedText(value) { return text(value).replace(/\r\n?/g, "\n"); }
    function characterCount(value) { return Array.from(text(value)).length; }

    function setStatus(message, tone) {
        var element = byId("rewrite-status");
        if (!element) return;
        element.textContent = text(message);
        element.className = "status status-" + (tone || "idle");
    }

    function application() {
        try {
            return root.WpsNativeDocument && root.WpsNativeDocument.getApplication
                ? root.WpsNativeDocument.getApplication() : null;
        } catch (error) { return null; }
    }

    function activeDocument(app) {
        try { return app && app.ActiveDocument ? app.ActiveDocument : null; }
        catch (error) { return null; }
    }

    function documentKey(document) {
        try { return text(document && (document.FullName || document.Name)); }
        catch (error) { return ""; }
    }

    function activeSelection() {
        var app = application();
        var document = activeDocument(app);
        if (!document) return null;
        try {
            var selection = app.Selection || (document.Application && document.Application.Selection);
            var range = selection && selection.Range;
            if (!range) return null;
            var selectedText = text(range.Text);
            var start = Number(range.Start);
            var end = Number(range.End);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
            return { app: app, document: document, range: range, selectedText: selectedText,
                start: start, end: end };
        } catch (error) { return null; }
    }

    function captureSnapshot() {
        var selected = activeSelection();
        if (!selected) throw new Error("请先选中需要理顺改写的段落。");
        var core = root.WpsRewriteCore;
        if (!core) throw new Error("改写模块尚未加载，请重新打开插件。");
        var original = core.validateRewriteSelection(selected.selectedText);
        if (selected.end - selected.start !== original.length) {
            throw new Error("选区位置与文字长度不一致，请重新选择后重试。");
        }
        var key = documentKey(selected.document);
        if (!key) throw new Error("无法确认当前文档身份，请保存文档后重试。");

        var contentStart = 0;
        var contentEnd = selected.end;
        try {
            var content = selected.document.Content;
            contentStart = Number(content.Start);
            contentEnd = Number(content.End);
            if (!Number.isFinite(contentStart)) contentStart = 0;
            if (!Number.isFinite(contentEnd)) contentEnd = selected.end;
        } catch (error) { /* Range reads below remain authoritative. */ }

        var beforeStart = Math.max(contentStart, selected.start - ANCHOR_CHARACTERS);
        var afterEnd = Math.min(contentEnd, selected.end + ANCHOR_CHARACTERS);
        var before;
        var after;
        try {
            before = text(selected.document.Range(beforeStart, selected.start).Text);
            after = text(selected.document.Range(selected.end, afterEnd).Text);
        } catch (error) {
            throw new Error("无法安全读取选区前后文字，请重新选择后重试。");
        }
        return {
            documentKey: key,
            start: selected.start,
            end: selected.end,
            original: original,
            beforeStart: beforeStart,
            before: before,
            after: after
        };
    }

    function readRange(document, start, end) {
        try { return text(document.Range(start, end).Text); }
        catch (error) { return null; }
    }

    function contextMatches(expectedText, saved, expectedEnd) {
        var app = application();
        var document = activeDocument(app);
        if (!document || documentKey(document) !== saved.documentKey) return false;
        if (normalizedText(readRange(document, saved.start, expectedEnd)) !== normalizedText(expectedText)) return false;
        var actualBefore = readRange(document, saved.beforeStart, saved.start);
        var contentEnd = expectedEnd + saved.after.length;
        try {
            var content = document.Content;
            var documentEnd = Number(content && content.End);
            if (Number.isFinite(documentEnd)) contentEnd = Math.min(contentEnd, documentEnd);
        } catch (error) { /* Range read remains the final check. */ }
        var actualAfter = readRange(document, expectedEnd, contentEnd);
        return actualBefore !== null && actualAfter !== null &&
            normalizedText(actualBefore) === normalizedText(saved.before) &&
            normalizedText(actualAfter) === normalizedText(saved.after)
            ? { document: document } : false;
    }

    function selectionCount(value) {
        var element = byId("rewrite-selection-count");
        if (!element) return;
        if (!value || !value.trim()) {
            element.textContent = "当前未选中文字";
            return;
        }
        var count = characterCount(value);
        element.textContent = "已选中 " + count + " 字" +
            (count > root.WpsRewriteCore.maxSelectionCharacters ? "（最多 5000 字）" : "");
    }

    function refreshRewriteSelection() {
        var selected = activeSelection();
        var value = selected ? selected.selectedText : "";
        selectionCount(value);
        var button = byId("run-rewrite");
        if (button) button.disabled = busy;
        return { characters: characterCount(value), selected: Boolean(value.trim()) };
    }

    function readRequirements() {
        var field = byId("rewrite-requirements");
        return field ? text(field.value).slice(0, 500) : "";
    }

    function modelOptions() {
        var store = root.WpsSettingsStore;
        var settings = store && typeof store.loadSettings === "function"
            ? store.loadSettings() : null;
        if (!settings && store && typeof store.defaultSettings === "function") settings = store.defaultSettings();
        settings = settings || {};
        var provider = settings.provider || "opencode";
        var profile = settings.profiles && settings.profiles[provider]
            ? settings.profiles[provider] : {};
        var runtime = store && typeof store.loadRuntimeEndpoint === "function"
            ? store.loadRuntimeEndpoint(provider) : null;
        return {
            provider: provider,
            endpoint: runtime && runtime.provider === provider ? runtime.endpoint : (profile.endpoint || ""),
            model: profile.model || "",
            apiKey: store && typeof store.loadPassword === "function" ? store.loadPassword(provider) : "",
            signal: controller ? controller.signal : undefined,
            maxOutputTokens: 10000
        };
    }

    function requestRewriteModel(options, prompt) {
        if (options.provider === "opencode") {
            if (!root.WpsOpenCodeClient) throw new Error("OpenCode 客户端模块没有加载。");
            return root.WpsOpenCodeClient.request({
                endpoint: options.endpoint,
                model: options.model,
                password: options.apiKey,
                signal: options.signal,
                systemPrompt: REWRITE_SYSTEM_PROMPT
            }, prompt, root.fetch);
        }
        if (!root.WpsProofreadingCore || typeof root.WpsProofreadingCore.requestModel !== "function") {
            throw new Error("模型请求模块没有加载。");
        }
        return root.WpsProofreadingCore.requestModel(options, prompt, root.fetch);
    }

    function setBusy(value) {
        busy = value === true;
        var generate = byId("run-rewrite");
        var cancel = byId("cancel-rewrite");
        var replace = byId("replace-rewrite");
        var regenerate = byId("regenerate-rewrite");
        var discard = byId("discard-rewrite");
        if (cancel) {
            cancel.hidden = !busy;
            cancel.disabled = !busy;
        }
        if (generate) generate.disabled = busy;
        if (regenerate) regenerate.disabled = busy;
        if (discard) discard.disabled = busy;
        if (replace) replace.disabled = busy || !result ||
            result.risk.hardRisks.length > 0 ||
            (result.risk.requiresConfirmation && !checked("rewrite-risk-confirm"));
        refreshRewriteSelection();
    }

    function checked(id) {
        var field = byId(id);
        return Boolean(field && field.checked === true);
    }

    function appendList(list, values) {
        if (!list) return;
        list.textContent = "";
        (values || []).forEach(function (value) {
            var item = root.document.createElement("li");
            item.textContent = text(value);
            list.appendChild(item);
        });
        list.hidden = !(values && values.length);
    }

    function renderResult(value) {
        result = value;
        var resultPanel = byId("rewrite-result");
        var original = byId("rewrite-original-preview");
        var rewritten = byId("rewrite-text-preview");
        var lengthSummary = byId("rewrite-length-summary");
        var modelSummary = byId("rewrite-summary-list");
        var riskPanel = byId("rewrite-risk");
        var riskTitle = byId("rewrite-risk-title");
        var riskList = byId("rewrite-risk-list");
        var confirmRow = byId("rewrite-risk-confirm-row");
        var confirm = byId("rewrite-risk-confirm");
        var completed = byId("rewrite-completed");
        if (resultPanel) resultPanel.hidden = false;
        if (original) original.textContent = value.snapshot.original;
        if (rewritten) rewritten.textContent = value.rewrittenText;
        var oldCount = characterCount(value.snapshot.original);
        var newCount = characterCount(value.rewrittenText);
        var delta = oldCount ? ((newCount - oldCount) / oldCount) * 100 : 0;
        var sign = delta > 0 ? "+" : "";
        if (lengthSummary) {
            lengthSummary.textContent = oldCount + " 字 → " + newCount + " 字（" +
                sign + delta.toFixed(1) + "%）";
        }
        appendList(modelSummary, value.summary);
        if (riskPanel) {
            riskPanel.hidden = false;
            riskPanel.className = "rewrite-risk" + (value.risk.level === "blocked" ? " is-blocked" : "");
        }
        if (riskTitle) riskTitle.textContent = value.risk.title;
        appendList(riskList, value.risk.details);
        if (confirmRow) confirmRow.hidden = !value.risk.requiresConfirmation || value.risk.level === "blocked";
        if (confirm) confirm.checked = false;
        if (completed) completed.hidden = true;
        updateReplaceButton();
    }

    function updateReplaceButton() {
        var button = byId("replace-rewrite");
        if (!button) return;
        button.disabled = busy || !result || result.risk.hardRisks.length > 0 ||
            (result.risk.requiresConfirmation && !checked("rewrite-risk-confirm"));
    }

    function clearResult() {
        result = null;
        var panel = byId("rewrite-result");
        var actions = byId("rewrite-result-actions");
        var completed = byId("rewrite-completed");
        var confirm = byId("rewrite-risk-confirm");
        if (panel) panel.hidden = true;
        if (actions) actions.hidden = false;
        if (completed) completed.hidden = true;
        if (confirm) confirm.checked = false;
        updateReplaceButton();
    }

    async function generateRewrite(savedSnapshot) {
        if (busy) return false;
        clearResult();
        var nextSnapshot;
        try {
            nextSnapshot = savedSnapshot || captureSnapshot();
            root.WpsRewriteCore.validateRewriteSelection(nextSnapshot.original);
            if (savedSnapshot && !contextMatches(savedSnapshot.original, savedSnapshot, savedSnapshot.end)) {
                throw new Error("原文在生成改写后已发生变化，请重新选择并生成。");
            }
        } catch (error) {
            setStatus(error && error.message ? error.message : "无法读取选区，请重试。", "warning");
            return false;
        }

        var guards = root.WpsRewriteCore.extractRewriteGuards(nextSnapshot.original);
        var prompt;
        var options;
        try {
            prompt = root.WpsRewriteCore.buildRewritePrompt(nextSnapshot.original, readRequirements());
            options = modelOptions();
            if (options.provider === "opencode") {
                root.WpsOpenCodeClient.normalizeEndpoint(options.endpoint);
                root.WpsOpenCodeClient.parseModelName(options.model);
            } else {
                root.WpsProofreadingCore.createModelRequest(
                    options.provider === "ollama" ? "ollama" : "openai",
                    options.endpoint, options.model, options.apiKey, prompt,
                    { maxOutputTokens: options.maxOutputTokens });
            }
        } catch (error) {
            setStatus(error && error.message ? error.message : "模型设置无效。", "error");
            return false;
        }

        controller = typeof root.AbortController === "function" ? new root.AbortController() : null;
        options.signal = controller ? controller.signal : undefined;
        setBusy(true);
        setStatus("正在生成理顺改写预览…", "working");
        try {
            var response = await requestRewriteModel(options, prompt);
            if (controller && controller.signal.aborted) throw new Error("改写已取消。");
            if (!contextMatches(nextSnapshot.original, nextSnapshot, nextSnapshot.end)) {
                throw new Error("原文在生成改写后已发生变化，请重新选择并生成。");
            }
            var parsed = root.WpsRewriteCore.parseRewriteResponse(response);
            var comparison = root.WpsRewriteCore.compareRewriteGuards(guards, parsed.rewrittenText);
            var risk = root.WpsRewriteCore.summarizeRewriteRisk(comparison, parsed.warnings);
            undoRecord = null;
            renderResult({
                snapshot: nextSnapshot,
                rewrittenText: parsed.rewrittenText,
                summary: parsed.summary,
                modelWarnings: parsed.warnings,
                risk: Object.assign({}, comparison, risk)
            });
            setStatus(risk.level === "blocked"
                ? "改写已生成，但事实护栏发现变化，不能直接替换。"
                : risk.level === "review"
                    ? "改写已生成，请核对提醒后再决定是否替换。"
                    : "改写预览已生成，请检查后再替换。", risk.level === "safe" ? "success" : "warning");
            return true;
        } catch (error) {
            var message = error && error.message ? error.message : "改写生成失败，请重试。";
            setStatus(message, /取消/.test(message) ? "warning" : "error");
            return false;
        } finally {
            controller = null;
            setBusy(false);
        }
    }

    function replaceOriginal() {
        if (!result || result.risk.hardRisks.length ||
            (result.risk.requiresConfirmation && !checked("rewrite-risk-confirm"))) return false;
        var saved = result.snapshot;
        var validation = contextMatches(saved.original, saved, saved.end);
        if (!validation) {
            setStatus("原文在生成改写后已发生变化，请重新生成。", "warning");
            return false;
        }
        try {
            var range = validation.document.Range(saved.start, saved.end);
            range.Text = result.rewrittenText;
            var rewrittenEnd = saved.start + result.rewrittenText.length;
            if (!contextMatches(result.rewrittenText, saved, rewrittenEnd)) {
                setStatus("WPS 未能验证替换结果，请检查正文；为安全起见，暂不可撤销。", "warning");
                undoRecord = null;
                return false;
            }
            operationCounter += 1;
            undoRecord = {
                operationId: "rewrite-" + Date.now().toString(36) + "-" + operationCounter,
                snapshot: saved,
                rewrittenText: result.rewrittenText,
                rewrittenEnd: rewrittenEnd
            };
            var actions = byId("rewrite-result-actions");
            var completed = byId("rewrite-completed");
            if (actions) actions.hidden = true;
            if (completed) completed.hidden = false;
            setStatus("已替换原文。", "success");
            return true;
        } catch (error) {
            setStatus("WPS 未能替换选区，请检查正文后重试。", "error");
            return false;
        }
    }

    function undoRewrite() {
        if (!undoRecord) return false;
        var record = undoRecord;
        var saved = record.snapshot;
        var validation = contextMatches(record.rewrittenText, saved, record.rewrittenEnd);
        if (!validation) {
            setStatus("当前文字已经再次修改，无法安全撤销。", "warning");
            undoRecord = null;
            return false;
        }
        try {
            validation.document.Range(saved.start, record.rewrittenEnd).Text = saved.original;
            if (!contextMatches(saved.original, saved, saved.end)) {
                setStatus("WPS 未能验证撤销结果，请检查正文。", "warning");
                undoRecord = null;
                return false;
            }
            undoRecord = null;
            var completed = byId("rewrite-completed");
            var actions = byId("rewrite-result-actions");
            if (completed) completed.hidden = true;
            if (actions) actions.hidden = false;
            updateReplaceButton();
            setStatus("已撤销本次改写。", "success");
            return true;
        } catch (error) {
            setStatus("WPS 未能安全撤销本次改写。", "warning");
            return false;
        }
    }

    function discardRewrite() {
        if (busy) return false;
        clearResult();
        undoRecord = null;
        setStatus("已放弃改写，正文没有变化。", "idle");
        return true;
    }

    function cancelRewrite() {
        if (!controller) return false;
        controller.abort();
        return true;
    }

    function bind() {
        var generate = byId("run-rewrite");
        var cancel = byId("cancel-rewrite");
        var replace = byId("replace-rewrite");
        var regenerate = byId("regenerate-rewrite");
        var discard = byId("discard-rewrite");
        var undo = byId("undo-rewrite");
        var confirm = byId("rewrite-risk-confirm");
        if (generate) generate.addEventListener("click", function () { generateRewrite(); });
        if (cancel) cancel.addEventListener("click", cancelRewrite);
        if (replace) replace.addEventListener("click", replaceOriginal);
        if (regenerate) regenerate.addEventListener("click", function () {
            if (result) generateRewrite(result.snapshot);
        });
        if (discard) discard.addEventListener("click", discardRewrite);
        if (undo) undo.addEventListener("click", undoRewrite);
        if (confirm) confirm.addEventListener("change", updateReplaceButton);
        refreshRewriteSelection();
        if (typeof root.setInterval === "function") {
            root.setInterval(function () {
                if (typeof root.getAppMode !== "function" || root.getAppMode() === "rewrite") {
                    refreshRewriteSelection();
                }
            }, 800);
        }
    }

    root.refreshRewriteSelection = refreshRewriteSelection;
    root.generateRewrite = generateRewrite;
    root.replaceRewriteSelection = replaceOriginal;
    root.undoRewrite = undoRewrite;
    root.cancelRewrite = cancelRewrite;
    root.discardRewrite = discardRewrite;

    if (root.document) {
        if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", bind);
        else bind();
    }
})(typeof window !== "undefined" ? window : globalThis);
