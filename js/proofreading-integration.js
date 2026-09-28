Warning: truncated output (original token count: 16034)
Total output lines: 1416

(function (root) {
    "use strict";

    var PROVIDER_DEFAULTS = {
        ollama: { endpoint: "http://127.0.0.1:11434", model: "" },
        opencode: { endpoint: "http://127.0.0.1:4096", model: "opencode/mimo-v2.6-flash-free" },
        openai: { endpoint: "", model: "" }
    };
    var currentSnapshot = null;
    var currentIssues = [];
    var currentController = null;
    var busy = false;
    var issueActionBusy = false;
    var waitingForFullDocumentConfirmation = false;
    var runCounter = 0;
    var actionCounter = 0;
    var ANCHOR_CHARACTERS = 40;

    function actionClock() {
        return root.performance && typeof root.performance.now === "function"
            ? root.performance.now() : Date.now();
    }

    function startActionPerf(action) {
        var hostname = root.location && root.location.hostname;
        if (root.WpsIssueActionPerf === false) return null;
        if (root.WpsIssueActionPerf !== true && hostname !== "127.0.0.1" &&
            hostname !== "localhost" && hostname !== "[::1]") return null;
        return { action: action, started: actionClock(), timings: {
            issueLookup: 0, validation: 0, rangeRead: 0, write: 0,
            stateShift: 0, snapshotUpdate: 0, historyRecord: 0,
            render: 0, locateNext: 0, writeComplete: 0, deferredDelay: 0,
            postWriteVerification: 0
        } };
    }

    function actionStage(perf, name, callback) {
        if (!perf) return callback();
        var started = actionClock();
        try { return callback(); }
        finally { perf.timings[name] += actionClock() - started; }
    }

    function finishActionPerf(perf, outcome) {
        if (!perf) return;
        var report = { action: perf.action, outcome: outcome };
        Object.keys(perf.timings).forEach(function (name) {
            report[name] = Math.round(perf.timings[name] * 100) / 100;
        });
        report.total = Math.round((actionClock() - perf.started) * 100) / 100;
        // Fixed labels and numbers only: never log document data or exceptions.
        try {
            if (root.console && typeof root.console.info === "function") {
                root.console.info(perf.action + "Issue perf:", report);
            }
        } catch (error) { /* Diagnostics must not affect document operations. */ }
    }

    function setIssueActionBusy(value) {
        issueActionBusy = value === true;
        try {
            if (typeof root.setProofreadingActionBusy === "function") {
                root.setProofreadingActionBusy(issueActionBusy);
            }
        } catch (error) { /* The integration lock remains authoritative. */ }
    }

    function nextActionTurn() {
        return new Promise(function (resolve) {
            if (typeof root.setTimeout === "function") root.setTimeout(resolve, 0);
            else setTimeout(resolve, 0);
        });
    }

    function byId(id) {
        return root.document && root.document.getElementById
            ? root.document.getElementById(id)
            : null;
    }

    function text(value) {
        return String(value == null ? "" : value);
    }

    function setStatus(message, tone) {
        if (typeof root.setProofreadingStatus === "function") {
            root.setProofreadingStatus({ text: message, tone: tone || "idle" });
        }
    }

    function setConnectionStatus(message, tone) {
        if (typeof root.setModelConnectionStatus === "function") {
            root.setModelConnectionStatus(message, tone || "idle");
        }
    }

    function setBusy(value) {
        busy = value === true;
        if (typeof root.setProofreadingBusy === "function") {
            root.setProofreadingBusy(busy);
            return;
        }
        var runButton = byId("run-proofreading");
        var cancelButton = byId("cancel-proofreading");
        if (runButton) runButton.disabled = busy;
        if (cancelButton) {
            cancelButton.hidden = !busy;
            cancelButton.disabled = !busy;
        }
    }

    function app() {
        return root.WpsNativeDocument && root.WpsNativeDocument.getApplication
            ? root.WpsNativeDocument.getApplication()
            : null;
    }

    function activeDocument(application) {
        try {
            return application ? application.ActiveDocument || null : null;
        } catch (error) {
            return null;
        }
    }

    function documentKey(document) {
        try {
            return text(document.FullName || document.Name);
        } catch (error) {
            return "";
        }
    }

    function getSelectionRange(application, document) {
        try {
            var selection = application && application.Selection
                ? application.Selection
                : (document && document.Application ? document.Application.Selection : null);
            return selection && selection.Range ? selection.Range : null;
        } catch (error) {
            return null;
        }
    }

    function captureSnapshot() {
        var application = app();
        var document = activeDocument(application);
        if (!document) throw new Error("无法读取当前 WPS 文档。");
        var range = getSelectionRange(application, document);

        var selectedText = "";
        var start;
        var end;
        var prefixText = "";
        try {
            if (range) {
                selectedText = text(range.Text);
                start = Number(range.Start);
                end = Number(range.End);
                prefixText = text(document.Range(0, start).Text);
            }
        } catch (error) {
            selectedText = "";
        }

        if (selectedText.trim()) {
            selectedText = root.WpsProofreadingCore.validateSelection(selectedText);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== selectedText.length) {
                throw new Error("WPS 选区位置与文本长度不一致，请重新选择后重试。");
            }
            return {
                mode: "selection",
                documentKey: documentKey(document),
                start: start,
                end: end,
                selectedText: selectedText,
                prefixText: prefixText
            };
        }

        var content;
        var fullText;
        try {
            content = document.Content;
            fullText = text(content && content.Text);
            start = Number(content && content.Start);
        } catch (error) {
            throw new Error("WPS 文档接口暂不可用，无法读取全文，请重新选择文字后重试。");
        }
        fullText = root.WpsProofreadingCore.validateDocument(fullText);
        if (!Number.isFinite(start)) start = 0;
        end = start + fullText.length;
        try {
            prefixText = start > 0 ? text(document.Range(0, start).Text) : "";
        } catch (error) {
            prefixText = "";
        }

        return {
            mode: "full",
            documentKey: documentKey(document),
            start: start,
            end: end,
            selectedText: fullText,
            prefixText: prefixText
        };
    }

    function currentDocumentMatches(snapshot) {
        if (!snapshot) return false;
        var application = app();
        var document = activeDocument(application);
        if (!document || documentKey(document) !== snapshot.documentKey) return false;
        try {
            if (snapshot.mode === "full") {
                var content = document.Content;
                var contentStart = Number(content && content.Start);
                if (!Number.isFinite(contentStart)) contentStart = 0;
                return contentStart === snapshot.start &&
                    text(content && content.Text) === snapshot.selectedText &&
                    text(document.Range(0, snapshot.start).Text) === snapshot.prefixText;
            }
            return text(document.Range(0, snapshot.start).Text) === snapshot.prefixText &&
                text(document.Range(snapshot.start, snapshot.end).Text) === snapshot.selectedText;
        } catch (error) {
            return false;
        }
    }

    function issueContext(issue, expected) {
        if (!currentSnapshot || !Number.isInteger(issue.start) || !Number.isInteger(issue.end) ||
            issue.start < 0 || issue.end - issue.start !== expected.length) return null;
        var relativeStart = issue.start - currentSnapshot.start;
        var relativeEnd = issue.end - currentSnapshot.start;
        var snapshotText = currentSnapshot.selectedText;
        if (relativeStart < 0 || relativeEnd > snapshotText.length ||
            snapshotText.slice(relativeStart, relativeEnd) !== expected) return null;
        // Derive only this issue's anchors from trusted snapshot text, never live WPS text.
        var selectedBefore = snapshotText.slice(Math.max(0, relativeStart - ANCHOR_CHARACTERS), relativeStart);
        var outsideBefore = relativeStart < ANCHOR_CHARACTERS
            ? currentSnapshot.prefixText.slice(-(ANCHOR_CHARACTERS - relativeStart)) : "";
        var before = outsideBefore + selectedBefore;
        var after = snapshotText.slice(relativeEnd, relativeEnd + ANCHOR_CHARACTERS);
        if (expected === "" && !before && !after) return null;
        var start = Math.max(0, issue.start - before.length);
        var end = Math.min(currentSnapshot.end, issue.end + after.length);
        return {
            start: start,
            end: end,
            before: before,
            after: after,
            text: before + expected + after
        };
    }

    function checkedIssueRange(issue, expected, perf, operationDocument, contextOverride) {
        var document = operationDocument || activeDocument(app());
        if (!document || !currentSnapshot ||
            documentKey(document) !== currentSnapshot.documentKey) return null;
        var context = contextOverride || issueContext(issue, expected);
        if (!context) return null;
        var contextRange = document.Range(context.start, context.end);
        if (actionStage(perf, "rangeRead", function () { return text(contextRange.Text); }) !== context.text) return null;
        // Keep the write/selection Range short-lived; do not reuse it after a write or timer.
        return context.start === issue.start && context.end === issue.end
            ? contextRange : document.Range(issue.start, issue.end);
    }

    function updateSnapshotAfterReplacement(start, end, replacement) {
        var relativeStart = start - currentSnapshot.start;
        var relativeEnd = end - currentSnapshot.start;
        return Object.assign({}, currentSnapshot, {
            selectedText: currentSnapshot.selectedText.slice(0, relativeStart) +
                replacement + currentSnapshot.selectedText.slice(relativeEnd),
            end: currentSnapshot.end + replacement.length - (end - start)
        });
    }

    function modelOptions() {
        var settings = currentSettings();
        var profile = settings.profiles && settings.profiles[settings.provider]
            ? settings.profiles[settings.provider]
            : PROVIDER_DEFAULTS[settings.provider];
        var api = settingsStore();
        var runtime = api && typeof api.loadRuntimeEndpoint === "function"
            ? api.loadRuntimeEndpoint(settings.provider)
            : null;
        var endpoint = runtime && runtime.provider === settings.provider
            ? runtime.endpoint
            : (profile ? profile.endpoint : "");
        return {
            provider: settings.provider,
            endpoint: endpoint || "",
            model: profile ? profile.model : "",
            apiKey: api && typeof api.loadPassword === "function" ? api.loadPassword(settings.provider) : "",
            signal: currentController ? currentController.signal : undefined
        };
    }

    function validateModelOptions(options) {
        options = options || {};
        if (options.provider === "opencode") {
            if (!root.WpsOpenCodeClient ||
                typeof root.WpsOpenCodeClient.normalizeEndpoint !== "function" ||
                typeof root.WpsOpenCodeClient.parseModelName !== "function") {
                throw new Error("OpenCode 客户端模块没有加载。");
            }
            root.WpsOpenCodeClient.normalizeEndpoint(options.endpoint);
            root.WpsOpenCodeClient.parseModelName(options.model);
            return options;
        }
        if (!root.WpsProofreadingCore ||
            typeof root.WpsProofreadingCore.createModelRequest !== "function") {
            throw new Error("模型请求模块没有加载。");
        }
        root.WpsProofreadingCore.createModelRequest(
            options.provider === "ollama" ? "ollama" : "openai",
            options.endpoint,
            options.model,
            options.apiKey,
            ""
        );
        return options;
    }

    function isDeepMode() {
        return currentSettings().deep === true;
    }

    function categoryLabel(category) {
        var labels = {
            typo: "错别字",
            punctuation: "标点",
            grammar: "语法",
            redundancy: "重复冗余",
            wording: "用词",
            consistency: "前后统一",
            rule: "规则核对"
        };
        return labels[category] || "校对提示";
    }

    function issueStateLabel(issue) {
        return issue.status === "accepted" ? "已应用" :
            issue.status === "ignored" ? "已忽略" :
                issue.status === "stale" ? "原文已变化，需重查" :
                    issue.needsReview ? "建议人工确认" : "待确认";
    }

    function viewIssues() {
        if (typeof root.setProofreadingIssues !== "function") return;
        root.setProofreadingIssues(currentIssues.map(function (issue) {
            return {
                id: issue.id,
                runId: runCounter,
                category: issue.category,
                categoryLabel: categoryLabel(issue.category),
                title: categoryLabel(issue.category) + (issue.needsReview ? " · 请复核" : ""),
                original: issue.original,
                reason: issue.reason,
                stateLabel: issueStateLabel(issue),
                confidence: issue.confidence,
                message: (issue.reason ? "原因：" + issue.reason + "\n" : "") + "状态：" + issueStateLabel(issue),
                suggestion: issue.suggestion,
                status: issue.status,
                needsReview: issue.needsReview,
                autoFixable: issue.autoFixable === true,
                actionable: issue.actionable !== false,
                ruleName: issue.ruleName || "",
                ruleSource: issue.ruleSource || "",
                ruleType: issue.ruleType || "",
                severity: issue.severity || "",
                origin: issue.origin || issueOrigin(issue),
                confirmedByAI: issue.confirmedByAI === true,
                aiConflict: issue.aiConflict === true,
                reviewRuleId: issue.reviewRuleId || ""
            };
        }));
    }

    function recordAction(action, issue) {
        if (typeof root.pushProofreadingRecord !== "function") return;
        root.pushProofreadingRecord({
            id: issue.id,
            runId: runCounter,
            category: issue.category,
            categoryLabel: categoryLabel(issue.category),
            original: issue.original,
            suggestion: issue.suggestion,
            reason: issue.reason,
            action: action,
            operationId: ++actionCounter
        });
    }

    function settingsStore() {
        return root.WpsSettingsStore || null;
    }

    function currentSettings() {
        var api = settingsStore();
        if (api && typeof api.loadSettings === "function") {
            return api.loadSettings() || api.defaultSettings();
        }
        return { provider: "opencode", deep: false, profiles: PROVIDER_DEFAULTS };
    }

    function modelSummaryText() {
        var options = modelOptions();
        var labels = { ollama: "Ollama", opencode: "OpenCode", openai: "兼容接口" };
        var parts = [labels[options.provider] || options.provider];
        if (options.endpoint) parts.push(options.endpoint);
        if (options.model) parts.push(options.model);
        if (isDeepMode()) parts.push("深度增强");
        return parts.join(" · ");
    }

    function renderModelSummary() {
        var summary = byId("model-summary");
        if (summary) summary.textContent = modelSummaryText();
        var catalog = settingsStore() && typeof settingsStore().loadCatalog === "function"
            ? settingsStore().loadCatalog()
            : null;
        if (catalog) {
            setConnectionStatus(
                (catalog.detail || "已检测") + " · " + catalog.models.length + " 个模型",
                catalog.tone || "success"
            );
        } else {
            setConnectionStatus("尚未检测", "idle");
        }
    }

    var lastKnownStoreState = "";

    function storeStateKey() {
        var api = settingsStore();
        if (!api) return "";
        try {
            var settings = api.loadSettings() || api.defaultSettings();
            return JSON.stringify([
                settings,
                api.loadRuntimeEndpoint(settings.provider),
                api.loadCatalog()
            ]);
        } catch (error) {
            return "";
        }
    }

    function syncFromStore() {
        var key = storeStateKey();
        if (key === lastKnownStoreState) return false;
        lastKnownStoreState = key;
        renderModelSummary();
        if (typeof root.syncSettingsForm === "function") root.syncSettingsForm();
        return true;
    }

    function initConfiguration() {
        syncFromStore();
        if (root.document && typeof root.setInterval === "function") {
            root.setInterval(syncFromStore, 1000);
        }
    }

    function saveCatalogResult(provider, result, tone) {
        var api = settingsStore();
        if (!api || typeof api.saveCatalog !== "function") return;
        api.saveCatalog({
            provider: provider,
            models: result.models || [],
            defaultModel: result.defaultModel || "",
            detail: result.detail || "",
            tone: tone
        });
    }

    async function refreshProviderModels() {
        setConnectionStatus("正在检测…", "working");
        var options;
        var api = settingsStore();
        try {
            options = modelOptions();
            if (!root.WpsModelCatalog) throw new Error("模型检测模块没有加载。");
            var result = await root.WpsModelCatalog.detect(options, root.fetch);
            saveCatalogResult(result.provider, result, result.models.length ? "success" : "error");
            if (result.models.length && result.defaultModel && api && typeof api.updateSettings === "function") {
                var profile = currentSettings().profiles[result.provider] || { model: "" };
                if (!profile.model || result.models.indexOf(profile.model) < 0) {
                    api.updateSettings({ provider: result.provider, profile: { model: result.defaultModel } });
                }
            }
            syncFromStore();
            // Detection changes the UI even when the stored catalog is unchanged.
            renderModelSummary();
            if (!result.models.length) {
                setConnectionStatus("模型服务已连接，但未读取到可用模型。", "warning");
                return { models: [], defaultModel: "" };
            }
            return { models: result.models, defaultModel: result.defaultModel };
        } catch (error) {
            var existing = api && typeof api.loadCatalog === "function" ? api.loadCatalog() : null;
            if (options) {
                saveCatalogResult(options.provider, {
                    models: existing ? existing.models : [],
                    defaultModel: existing ? existing.defaultModel : "",
                    detail: "连接失败"
                }, "error");
            }
            syncFromStore();
            renderModelSummary();
            setConnectionStatus(error && error.message
                ? error.message
                : "模型服务检测失败。请确认服务已启动并允许加载项跨域访问。", "error");
            return { models: [], defaultModel: "", error: true };
        }
    }

    function makeAbortController() {
        var Constructor = root.AbortController;
        if (!Constructor && typeof AbortController !== "undefined") Constructor = AbortController;
        return typeof Constructor === "function" ? new Constructor() : null;
    }

    async function requestProofreadingModel(options, prompt) {
        if (options.provider === "opencode") {
            if (!root.WpsOpenCodeClient) throw new Error("OpenCode 客户端模块没有加载。");
            return root.WpsOpenCodeClient.request({
                endpoint: options.endpoint,
                model: options.model,
                password: options.apiKey,
                signal: options.signal
            }, prompt, root.fetch);
        }
        return root.WpsProofreadingCore.requestModel(options, prompt);
    }

    function reportProgress(percent, label) {
        if (typeof root.setProofreadingProgress === "function") {
            root.setProofreadingProgress(percent, label || "");
        }
    }

    function batchCharacterCount(batch) {
        return (batch || []).reduce(function (total, paragraph) {
            return total + text(paragraph && paragraph.text).length;
        }, 0);
    }

    function issueOrigin(issue) {
        return issue && issue.origin ? String(issue.origin) :
            (issue && issue.category === "rule" ? "rule" : "ai");
    }

    function overlapsIssues(left, right) {
        return left.start < right.end && right.start < left.end;
    }

    function mergeReasons(primary, secondary, suffix) {
        var parts = [];
        [primary, secondary, suffix].forEach(function (value) {
            var item = text(value).trim();
            if (item && parts.indexOf(item) < 0) parts.push(item);
        });
        return parts.join("；");
    }

    function combineRuleAndAi(ruleIssue, aiIssue) {
        var sameSuggestion = ruleIssue.suggestion === aiIssue.suggestion;
        var ruleIsReminder = ruleIssue.actionable === false;
        var combined;

        if (ruleIsReminder) {
            combined = Object.assign({}, aiIssue, {
                origin: "rule+ai",
                ruleName: ruleIssue.ruleName || "",
                ruleSource: ruleIssue.ruleSource || "",
                ruleType: ruleIssue.ruleType || "",
                severity: ruleIssue.severity || "",
                priority: Math.max(Number(ruleIssue.priority) || 0, Number(aiIssue.priority) || 0),
                needsReview: true,
                confirmedByAI: true,
                reason: mergeReasons(ruleIssue.reason, aiIssue.reason, "本地规则提供核对线索，AI 结合上下文给出了具体建议。")
            });
            return combined;
        }

        if (sameSuggestion) {
            combined = Object.assign({}, ruleIssue, {
                category: aiIssue.category || ruleIssue.category,
                origin: "rule+ai",
                confirmedByAI: true,
                confidence: Math.max(Number(ruleIssue.confidence) || 0, Number(aiIssue.confidence) || 0),
                reason: mergeReasons(ruleIssue.reason, aiIssue.reason, "本地规则与 AI 判断一致。")
            });
            return combined;
        }

        return Object.assign({}, ruleIssue, {
            origin: "rule+ai",
            aiConflict: true,
            needsReview: true,
            reason: mergeReasons(ruleIssue.reason, aiIssue.reason, "本地规则与 AI 建议不一致，已保留规则建议并要求人工确认。")
        });
    }

    function mergeMappedIssues(list) {
        var input = (list || []).slice().filter(function (issue) {
            return issue && Number.isFinite(Number(issue.start)) && Number.isFinite(Number(issue.end));
        }).map(function (issue) {
            return Object.assign({ origin: issueOrigin(issue) }, issue);
        }).sort(function (left, right) {
            return left.start - right.start ||
                left.end - right.end ||
                (Number(right.priority) || 0) - (Number(left.priority) || 0);
        });

        var kept = [];
        input.forEach(function (issue) {
            var overlapIndex = -1;
            for (var index = kept.length - 1; index >= 0; index -= 1) {
                if (kept[index].end <= issue.start) break;
                if (overlapsIssues(kept[index], issue)) {
                    overlapIndex = index;
                    break;
                }
            }
            if (overlapIndex < 0) {
                kept.push(issue);
                return;
            }

            var existing = kept[overlapIndex];
            var existingOrigin = issueOrigin(existing);
            var incomingOrigin = issueOrigin(issue);
            var sameOriginal = existing.original === issue.original &&
                existing.start === issue.start && existing.end === issue.end;

            if (sameOriginal && existingOrigin !== incomingOrigin &&
                (existingOrigin.indexOf("rule") >= 0 || incomingOrigin.indexOf("rule") >= 0)) {
                var ruleIssue = existingOrigin.indexOf("rule") >= 0 ? existing : issue;
                var aiIssue = existingOrigin.indexOf("rule") >= 0 ? issue : existing;
                kept[overlapIndex] = combineRuleAndAi(ruleIssue, aiIssue);
                return;
            }

            var existingRule = existingOrigin.indexOf("rule") >= 0;
            var incomingRule = incomingOrigin.indexOf("rule") >= 0;
            var existingPriority = Number(existing.priority) || 0;
            var incomingPriority = Number(issue.priority) || 0;

            if (incomingRule && !existingRule) {
                kept[overlapIndex] = issue;
                return;
            }
            if (existingRule && !incomingRule) {
                return;
            }
            if (incomingPriority > existingPriority) {
                kept[overlapIndex] = issue;
            }
        });

        kept.sort(function (left, right) {
            return left.start - right.start || left.end - right.end;
        });
        kept.forEach(function (issue, index) {
            issue.id = "issue-" + (index + 1) + "-" + issue.start;
        });
        return kept;
    }

    function batchRuleContext(batch, localRuleIssues, selectionStart) {
        var base = Number(selectionStart) || 0;
        var paragraphs = batch || [];
        var matches = (localRuleIssues || []).filter(function (issue) {
            return paragraphs.some(function (paragraph) {
                var start = base + paragraph.offset;
                var end = start + text(paragraph.text).length;
                return issue.start < end && issue.end > start;
            });
        });

        return matches.slice(0, 20).map(function (issue) {
            return {
                original: issue.original,
                suggestion: issue.actionable === false ? "" : issue.suggestion,
                ruleName: issue.ruleName || "",
                source: issue.ruleSource || "",
                confirmed: issue.needsReview !== true && issue.actionable !== false,
                review: issue.needsReview === true || issue.actionable === false
            };
        });
    }

    function batchAiReviewContext(batch, candidates, selectionStart) {
        var base = Number(selectionStart) || 0;
        var paragraphs = batch || [];
        var results = [];
        var usedCharacters = 0;
        var maxCharacters = 6000;

        (candidates || []).forEach(function (candidate) {
            if (results.length >= 20 || usedCharacters >= maxCharacters) return;
            paragraphs.forEach(function (paragraph) {
                if (results.length >= 20 || usedCharacters >= maxCharacters) return;
                var start = base + paragraph.offset;
                var end = start + text(paragraph.text).length;
                if (candidate.start < start || candidate.end > end) return;
                var entry = {
                    ruleId: candidate.ruleId,
                    ruleName: text(candidate.ruleName).slice(0, 120),
                    paragraphIndex: paragraph.paragraphIndex,
                    trigger: text(candidate.trigger).slice(0, 300),
                    preferredSuggestion: text(candidate.preferredSuggestion).slice(0, 300),
                    instruction: text(candidate.instruction).slice(0, 700),
                    source: text(candidate.ruleSource).slice(0, 160),
                    severity: candidate.severity || "medium"
                };
                var size = JSON.stringify(entry).length;
                if (usedCharacters + size > maxCharacters && results.length) return;
                results.push(entry);
                usedCharacters += size;
            });
        });

        return results;
    }

    function annotateAiReviewIssues(issues, candidates) {
        return (issues || []).map(function (issue) {
            var candidate = issue && issue.reviewRuleId
                ? (candidates || []).find(function (item) {
                    return item && item.ruleId === issue.reviewRuleId &&
                        issue.start < item.end && item.start < issue.end;
                })
                : null;
            if (!candidate) return Object.assign({ origin: "ai" }, issue);
            return Object.assign({}, issue, {
                origin: "ai-review",
                ruleName: candidate.ruleName || "",
  …1034 tokens truncated…            collected = collected.concat(localRuleIssues);
            currentSnapshot = snapshot;
            currentIssues = mergeMappedIssues(collected);
            viewIssues();
            var scanParts = [];
            if (localRuleIssues.length) scanParts.push("确定性规则 " + localRuleIssues.length + " 项");
            if (aiReviewCandidates.length) scanParts.push("AI核查点 " + aiReviewCandidates.length + " 处");
            setStatus(scanParts.length
                ? "规则扫描完成：" + scanParts.join("，") + "；AI 正在结合上下文继续校对…"
                : "规则扫描完成，未发现规则命中；AI 正在继续校对…", "working");
            reportProgress(2, aiReviewCandidates.length
                ? "规则扫描完成 · " + aiReviewCandidates.length + " 处待 AI 核查"
                : "规则扫描完成 · AI 校对准备中");

            var paragraphs = root.WpsProofreadingCore.splitIntoParagraphs(snapshot.selectedText);
            if (!paragraphs.length) {
                throw new Error(scopeLabel + "中没有可校对的正文文字。");
            }
            var batches = root.WpsProofreadingCore.batchParagraphs(
                paragraphs, root.WpsProofreadingCore.defaultBatchCharacters);
            var deep = isDeepMode();
            var consistencyCandidates = root.WpsProofreadingCore.buildGlobalConsistencyCandidates(paragraphs);
            var consistencyBatches = root.WpsProofreadingCore.batchGlobalConsistencyCandidates(consistencyCandidates);
            var runConsistencyPass = consistencyBatches.length > 0;
            var firstPassProgressCeiling = runConsistencyPass ? 85 : 100;
            var totalFirstPassCharacters = batches.reduce(function (total, batch) {
                return total + batchCharacterCount(batch);
            }, 0);
            var completedFirstPassCharacters = 0;
            var consistencyCompleted = false;
            var consistencyWarning = "";

            for (var index = 0; index < batches.length; index += 1) {
                if (currentController && currentController.signal && currentController.signal.aborted) {
                    var abortError = new Error("已取消校对。");
                    abortError.name = "AbortError";
                    throw abortError;
                }
                var currentAiReviewContext = batchAiReviewContext(
                    batches[index], aiReviewCandidates, snapshot.start);
                var prompt = root.WpsProofreadingCore.buildPrompt(batches[index], {
                    deep: deep,
                    ruleContext: batchRuleContext(batches[index], localRuleIssues, snapshot.start),
                    aiReviewContext: currentAiReviewContext
                });
                var response = await requestProofreadingModel(options, prompt);
                if (!currentDocumentMatches(snapshot)) {
                    currentSnapshot = null;
                    currentIssues = [];
                    discarded = true;
                    viewIssues();
                    throw new Error("校对期间" + scopeLabel + "内容已变化，结果已丢弃。请重新校对。");
                }
                var parsed = root.WpsProofreadingCore.parseIssues(response);
                var mappedFirstPass = root.WpsProofreadingCore.mapIssuesToRanges(
                    batches[index], parsed, snapshot.start);
                collected = collected.concat(
                    annotateAiReviewIssues(mappedFirstPass, aiReviewCandidates));
                currentIssues = mergeMappedIssues(collected);
                currentSnapshot = snapshot;
                viewIssues();
                completedFirstPassCharacters += batchCharacterCount(batches[index]);
                var firstPassPercent = totalFirstPassCharacters > 0
                    ? Math.round((completedFirstPassCharacters / totalFirstPassCharacters) *
                        firstPassProgressCeiling)
                    : firstPassProgressCeiling;
                var batchLabel = "正文校对";
                if (batches.length > 1) {
                    batchLabel += " · 第 " + (index + 1) + "/" + batches.length + " 批";
                }
                batchLabel += " · 已处理 " + completedFirstPassCharacters +
                    "/" + totalFirstPassCharacters + " 字";
                reportProgress(firstPassPercent, batchLabel);
            }

            if (runConsistencyPass) {
                if (currentController && currentController.signal && currentController.signal.aborted) {
                    var consistencyAbortError = new Error("已取消校对。");
                    consistencyAbortError.name = "AbortError";
                    throw consistencyAbortError;
                }
                setStatus("第一遍逐段校对已完成，正在进行跨段落一致性复核…", "working");
                reportProgress(firstPassProgressCeiling, "正文校对完成 · 全文一致性复核中");
                try {
                    for (var candidateBatchIndex = 0; candidateBatchIndex < consistencyBatches.length; candidateBatchIndex += 1) {
                        var consistencyBatch = consistencyBatches[candidateBatchIndex];
                        var consistencyPrompt = root.WpsProofreadingCore.buildConsistencyPrompt(consistencyBatch);
                        var consistencyResponse = await requestProofreadingModel(options, consistencyPrompt);
                        if (!currentDocumentMatches(snapshot)) {
                            currentSnapshot = null;
                            currentIssues = [];
                            discarded = true;
                            viewIssues();
                            throw new Error("一致性复核期间" + scopeLabel + "内容已变化，结果已丢弃。请重新校对。");
                        }
                        var consistencyParsed = root.WpsProofreadingCore.filterConsistencyIssuesToCandidates(
                            root.WpsProofreadingCore.parseConsistencyIssues(consistencyResponse), consistencyBatch);
                        collected = collected.concat(
                            root.WpsProofreadingCore.mapIssuesToRanges(
                                paragraphs, consistencyParsed, snapshot.start).map(function (issue) {
                                    return Object.assign({ origin: "ai" }, issue);
                                }));
                        currentIssues = mergeMappedIssues(collected);
                        currentSnapshot = snapshot;
                        viewIssues();
                        reportProgress(firstPassProgressCeiling + Math.round(
                            ((candidateBatchIndex + 1) / consistencyBatches.length) * (100 - firstPassProgressCeiling)),
                            "一致性复核 · 第 " + (candidateBatchIndex + 1) + "/" + consistencyBatches.length + " 批候选组");
                    }
                    consistencyCompleted = true;
                    reportProgress(100, "全文一致性复核完成");
                } catch (consistencyError) {
                    if ((currentController && currentController.signal && currentController.signal.aborted) ||
                        (consistencyError && consistencyError.name === "AbortError") ||
                        discarded) {
                        throw consistencyError;
                    }
                    consistencyWarning = consistencyError && consistencyError.message
                        ? consistencyError.message
                        : "一致性复核未完成。";
                    reportProgress(100, "正文校对完成 · 一致性复核未完成");
                }
            }

            currentIssues = mergeMappedIssues(collected);
            currentSnapshot = snapshot;
            viewIssues();
            reportProgress(100, "完成");
            var consistencyText = runConsistencyPass
                ? (consistencyCompleted
                    ? "；已复核 " + consistencyCandidates.length + " 组全文一致性候选"
                    : "；逐段校对已完成，但一致性复核未完成")
                : "";
            var finalTone = consistencyWarning ? "warning" : "success";
            setStatus(currentIssues.length
                ? "校对完成，共发现 " + currentIssues.length + " 项（" +
                    batches.length + " 批" + consistencyText + "）。可先定位，再选择应用或忽略。" +
                    (consistencyWarning ? " " + consistencyWarning : "")
                : "校对完成，没有发现可精确定位的问题" + consistencyText + "。" +
                    (consistencyWarning ? " " + consistencyWarning : ""), finalTone);
            return {
                accepted: true,
                issues: currentIssues.length,
                batches: batches.length,
                consistencyAttempted: runConsistencyPass,
                consistencyCompleted: consistencyCompleted,
                consistencyWarning: consistencyWarning
            };
        } catch (error) {
            var cancelled = currentController && currentController.signal && currentController.signal.aborted;
            var partial = collected.length > 0 && !discarded && snapshot;
            if (partial) {
                currentIssues = mergeMappedIssues(collected);
                currentSnapshot = snapshot;
                viewIssues();
            }
            reportProgress(0, "");
            if (cancelled || (error && error.name === "AbortError")) {
                setStatus(partial
                    ? "已取消校对；已完成的部分结果仍可定位和应用，文档没有修改。"
                    : "已取消校对，文档没有修改。", "warning");
                return { accepted: false, reason: "cancelled" };
            }
            setStatus(partial
                ? "校对中断：" + (error && error.message ? error.message : "请重试。") +
                    "已完成的部分结果仍可使用。"
                : (error && error.message ? error.message : "校对失败，请重试。"), "error");
            return { accepted: false, reason: "error" };
        } finally {
            waitingForFullDocumentConfirmation = false;
            if (typeof root.dismissFullDocumentConfirmation === "function") {
                root.dismissFullDocumentConfirmation();
            }
            currentController = null;
            setBusy(false);
        }
    }

    function cancelProofreading() {
        if (busy && waitingForFullDocumentConfirmation &&
            typeof root.dismissFullDocumentConfirmation === "function") {
            if (currentController) currentController.abort();
            root.dismissFullDocumentConfirmation();
            return true;
        }
        if (!busy || !currentController) {
            setStatus("当前没有正在进行的校对。", "warning");
            return false;
        }
        currentController.abort();
        setStatus("正在取消校对…", "warning");
        return true;
    }

    function findPendingIssue(issueId) {
        return currentIssues.find(function (candidate) {
            return candidate.id === String(issueId);
        });
    }

    function markAllPendingStale(message) {
        currentIssues = currentIssues.map(function (candidate) {
            return candidate.status === "pending"
                ? Object.assign({}, candidate, { status: "stale" })
                : candidate;
        });
        viewIssues();
        setStatus(message, "warning");
    }

    function issueActionUnavailable() {
        if (!busy && !issueActionBusy) return false;
        setStatus(issueActionBusy
            ? "上一条操作正在收尾，请稍候。"
            : "校对进行中，请等待完成或先取消。", "warning");
        return true;
    }

    function locateCheckedIssue(issue, perf, operationDocument) {
        try {
            var range = actionStage(perf, "validation", function () {
                return checkedIssueRange(issue, issue.original, perf, operationDocument);
            });
            if (!range || typeof range.Select !== "function") throw new Error("range-unavailable");
            range.Select();
            return true;
        } catch (error) {
            issue.status = "stale";
            return false;
        }
    }

    function locateProofreadingIssue(issueId) {
        if (issueActionUnavailable()) return false;
        var perf = startActionPerf("locate");
        var outcome = "rejected";
        setIssueActionBusy(true);
        try {
            var issue = actionStage(perf, "issueLookup", function () { return findPendingIssue(issueId); });
            if (!issue || issue.status !== "pending") {
                setStatus("这条建议已处理或已失效，请重新校对。", "warning");
                return false;
            }
            if (locateCheckedIssue(issue, perf)) {
                outcome = "located";
                setStatus("已在文档中定位这条问题。", "success");
                return true;
            }
            actionStage(perf, "render", viewIssues);
            setStatus("WPS 未能定位这条原文，请重新校对。", "warning");
            return false;
        } finally {
            setIssueActionBusy(false);
            finishActionPerf(perf, outcome);
        }
    }

    function ignoreProofreadingIssue(issueId) {
        if (issueActionUnavailable()) return false;
        var issue = findPendingIssue(issueId);
        if (!issue || issue.status !== "pending") {
            setStatus("这条建议已处理或已失效。", "warning");
            return false;
        }
        issue.status = "ignored";
        recordAction("ignored", issue);
        viewIssues();
        setStatus("已忽略这条建议，文档没有修改。", "success");
        return true;
    }

    function writeIssueReplacement(change, perf) {
        var issue = change.issue;
        var context;
        var range = actionStage(perf, "validation", function () {
            try {
                context = issueContext(issue, change.expected);
                if (context && change.replacement === "" && !context.before && !context.after) {
                    change.unverifiableDeletion = true;
                    return null;
                }
                return checkedIssueRange(issue, change.expected, perf, null, context);
            }
            catch (error) { return null; }
        });
        if (!range) {
            if (change.unverifiableDeletion) {
                issue.actionable = false;
                issue.needsReview = true;
            } else {
                issue.status = "stale";
            }
            return false;
        }
        // Keep only immutable snapshot-derived data across the deferred turn.
        // Never carry a WPS Range past the synchronous write.
        change.documentKey = currentSnapshot.documentKey;
        change.contextStart = context.start;
        change.contextEnd = context.end;
        change.before = context.before;
        change.after = context.after;
        change.delta = change.replacement.length - change.expected.length;
        change.start = issue.start;
        change.end = issue.end;
        change.attempted = true;
        actionStage(perf, "write", function () { range.Text = change.replacement; });
        change.written = true;
        // No live WPS Range is carried into the next event-loop turn.
        return true;
    }

    function completeIssueReplacement(change, perf) {
        var nextIssues = actionStage(perf, "stateShift", function () {
            return root.WpsProofreadingCore.shiftIssuesAfterReplacement(
                currentIssues, change.issue.id, change.start, change.end, change.replacement.length);
        });
        var nextSnapshot = actionStage(perf, "snapshotUpdate", function () {
            return updateSnapshotAfterReplacement(change.start, change.end, change.replacement);
        });
        if (change.action === "undone") {
            nextIssues.forEach(function (issue) {
                if (issue.id === change.issue.id) issue.status = "pending";
            });
        }
        // Publish the shifted coordinates and snapshot together before calling UI code.
        currentIssues = nextIssues;
        currentSnapshot = nextSnapshot;
    }

    function invalidateWrittenAction(change) {
        currentSnapshot = null;
        currentIssues = currentIssues.map(function (issue) {
            if (change.postWriteVerified === true && change.written &&
                change.action === "applied" && issue.id === change.issue.id) {
                return Object.assign({}, issue, {
                    status: "accepted", start: change.start, end: change.start + change.replacement.length
                });
            }
            return Object.assign({}, issue, { status: "stale" });
        });
    }

    function verifyWrittenChange(change, perf) {
        return actionStage(perf, "postWriteVerification", function () {
            try {
                var document = activeDocument(app());
                if (!document || !change.documentKey ||
                    documentKey(document) !== change.documentKey) return false;
                var contextEnd = change.contextEnd + change.delta;
                if (!Number.isInteger(change.contextStart) || !Number.isInteger(contextEnd) ||
                    contextEnd < change.contextStart) return false;
                var contextText = change.before + change.replacement + change.after;
                // An empty context cannot distinguish an intact deletion from native undo.
                if (!contextText) return false;
                var contextRange = document.Range(change.contextStart, contextEnd);
                var actualText = actionStage(perf, "rangeRead", function () {
                    return text(contextRange.Text);
                });
                return actualText === contextText;
            } catch (error) {
                return false;
            }
        });
    }

    function applyOneIssue(issue, deferRender) {
        var change = { issue: issue, expected: issue.original, replacement: issue.suggestion, action: "applied" };
        if (!writeIssueReplacement(change)) {
            if (!deferRender) viewIssues();
            return { ok: false, reason: "changed" };
        }
        completeIssueReplacement(change);
        recordAction("applied", issue);
        if (!deferRender) viewIssues();
        return { ok: true };
    }

    function locateNextPendingIssue(afterId, perf) {
        var previous = findPendingIssue(afterId);
        var after = previous ? previous.end : -1;
        var pending = currentIssues.filter(function (candidate) {
            return candidate.status === "pending";
        });
        pending.sort(function (left, right) { return left.start - right.start; });
        var following = pending.filter(function (candidate) { return candidate.start >= after; });
        var ordered = following.concat(pending.filter(function (candidate) {
            return candidate.start < after;
        }));
        // Acquire the current document after yielding, then reuse only during this traversal.
        var operationDocument = ordered.length ? activeDocument(app()) : null;
        for (var index = 0; index < ordered.length; index += 1) {
            if (locateCheckedIssue(ordered[index], perf, operationDocument)) return { located: true, hadPending: true };
        }
        return { located: false, hadPending: ordered.length > 0 };
    }

    async function performIssueReplacement(issueId, undo) {
        var perf = startActionPerf(undo ? "undo" : "apply");
        var outcome = "rejected";
        var locked = false;
        var change = null;
        var committed = false;
        try {
            if (issueActionUnavailable()) return false;
            setIssueActionBusy(true);
            locked = true;
            var issue = actionStage(perf, "issueLookup", function () { return findPendingIssue(issueId); });
            if (!issue || issue.status !== (undo ? "accepted" : "pending")) {
                setStatus("这条建议已处理或已失效，请重新校对。", "warning");
                return false;
            }
            if (!undo && issue.actionable === false) {
                setStatus("这条建议仅供人工核对，没有可直接写入的替换文本。", "warning");
                return false;
            }
            change = { issue: issue, expected: undo ? issue.suggestion : issue.original,
                replacement: undo ? issue.original : issue.suggestion, action: undo ? "undone" : "applied" };
            if (!writeIssueReplacement(change, perf)) {
                actionStage(perf, "render", viewIssues);
                setStatus(change.unverifiableDeletion
                    ? "这条删除建议没有可校验的前后文，未修改正文，请手动处理。"
                    : "原文或上下文已变化，未写入这条修改。请重新校对。", "warning");
                return false;
            }
            var writtenAt = perf ? actionClock() : 0;
            if (perf) perf.timings.writeComplete = writtenAt - perf.started;
            // A timer (not a microtask) releases the synchronous WPS/UI call stack.
            await nextActionTurn();
            if (perf) perf.timings.deferredDelay = actionClock() - writtenAt;
            if (!verifyWrittenChange(change, perf)) {
                // The document may have been edited, undone, switched, or become
                // unreadable while the WPS call stack was yielded. Do not publish
                // shifted state or record a normal action without this proof.
                invalidateWrittenAction(change);
                try { actionStage(perf, "render", viewIssues); }
                catch (renderError) { /* Keep the invalidated state even if UI fails. */ }
                outcome = "post-write-changed";
                try { setStatus("正文在写入后发生变化，请重新校对。", "warning"); }
                catch (statusError) { /* UI errors must not revive the action. */ }
                return false;
            }
            change.postWriteVerified = true;
            completeIssueReplacement(change, perf);
            committed = true;
            var warning = false;
            try { actionStage(perf, "historyRecord", function () { recordAction(change.action, issue); }); }
            catch (error) { warning = true; }
            var navigation = { located: false, hadPending: false };
            if (!undo) {
                try {
                    navigation = actionStage(perf, "locateNext", function () {
                        return locateNextPendingIssue(issue.id, perf);
                    });
                } catch (error) { warning = true; }
            }
            try { actionStage(perf, "render", viewIssues); }
            catch (error) { warning = true; }
            outcome = warning ? "written-with-warning" : "completed";
            setStatus(warning
                ? "正文修改已完成，但部分记录或界面收尾失败。请检查正文后重新校对。"
                : undo ? "已撤销这条修改，建议恢复为待确认。"
                    : navigation.located ? "已应用一条建议，并定位到下一条待处理问题。"
                        : navigation.hadPending ? "已应用一条建议；其他原文已变化，请重新校对。"
                            : "本轮待处理问题已经处理完成。", warning ? "warning" : "success");
            return true;
        } catch (error) {
            if (change && change.attempted) {
                var postWriteUnverified = change.written === true && change.postWriteVerified !== true;
                if (!committed) invalidateWrittenAction(change);
                if (change.written && !committed && change.postWriteVerified === true) {
                    try { actionStage(perf, "historyRecord", function () { recordAction(change.action, change.issue); }); }
                    catch (historyError) { /* Keep the write result even when the history UI fails. */ }
                }
                try { actionStage(perf, "render", viewIssues); } catch (renderError) { /* Backend state stays safe. */ }
                outcome = postWriteUnverified ? "post-write-changed"
                    : change.written ? "written-state-invalidated" : "write-unconfirmed";
                try {
                    setStatus(postWriteUnverified
                        ? "正文在写入后发生变化，请重新校对。"
                        : change.written
                            ? "正文修改已完成，但坐标收尾失败，后续修改已停止。请重新校对。"
                            : "WPS 未能确认写入结果，请检查正文并重新校对。", "warning");
                } catch (statusError) { /* Do not let UI failure alter the safe state. */ }
                return postWriteUnverified ? false : change.written === true;
            }
            try { setStatus("WPS 未能验证这条修改，文档没有写入。请重新校对。", "warning"); }
            catch (statusError) { /* UI errors must not escape the operation. */ }
            return false;
        } finally {
            if (locked) setIssueActionBusy(false);
            finishActionPerf(perf, outcome);
        }
    }

    function applyProofreadingIssue(issueId) { return performIssueReplacement(issueId, false); }

    function undoProofreadingIssue(issueId) { return performIssueReplacement(issueId, true); }

    function isAutoFixableIssue(issue) {
        return issue && issue.status === "pending" &&
            issue.autoFixable === true &&
            issue.actionable !== false &&
            issue.needsReview !== true &&
            Number.isFinite(Number(issue.confidence)) &&
            Number(issue.confidence) >= 0.9;
    }

    function applyAllProofreadingIssues() {
        if (issueActionUnavailable()) {
            return { applied: 0, failed: 0, skipped: currentIssues.length };
        }
        var pending = currentIssues.filter(function (candidate) {
            return candidate.status === "pending";
        });
        var pendingIds = pending.filter(isAutoFixableIssue).map(function (candidate) {
            return candidate.id;
        });
        var skipped = pending.length - pendingIds.length;

        if (!pending.length) {
            setStatus("当前没有可修正的建议。", "warning");
            return { applied: 0, failed: 0, skipped: 0 };
        }
        if (!pendingIds.length) {
            setStatus("当前没有符合安全格式规则的一键修正项，请逐条确认。", "warning");
            return { applied: 0, failed: 0, skipped: skipped };
        }
        if (!currentDocumentMatches(currentSnapshot)) {
            markAllPendingStale("选区内容已变化，未写入任何建议。请重新校对。");
            return { applied: 0, failed: pendingIds.length, skipped: skipped, stale: true };
        }

        var applied = 0;
        var failed = 0;
        for (var index = 0; index < pendingIds.length; index += 1) {
            var issue = findPendingIssue(pendingIds[index]);
            if (!issue || !isAutoFixableIssue(issue)) continue;
            var result;
            try {
                result = applyOneIssue(issue, true);
            } catch (error) {
                result = { ok: false, reason: "error" };
            }
            if (result.ok) {
                applied += 1;
            } else {
                failed += 1;
                if (result.reason === "error") {
                    viewIssues();
                    setStatus("WPS 未能写入剩余建议，已停止批量修正；已修正 " + applied + " 条。", "error");
                    return { applied: applied, failed: failed, skipped: skipped };
                }
                markAllPendingStale("原文已变化，剩余建议未写入。已修正 " + applied + " 条，请重新校对。");
                return { applied: applied, failed: failed, skipped: skipped, stale: true };
            }
        }

        viewIssues();
        var suffix = skipped
            ? "；另有 " + skipped + " 条建议未自动修改，请逐条确认。"
            : "。";
        setStatus(applied
            ? "已一键修正 " + applied + " 条安全格式建议，并在写入前逐条核对了原文" + suffix
            : "没有可安全自动写入的建议。", applied ? "success" : "warning");
        return { applied: applied, failed: failed, skipped: skipped };
    }

    root.runProofreading = runProofreading;
    root.cancelProofreading = cancelProofreading;
    root.refreshProviderModels = refreshProviderModels;
    root.locateProofreadingIssue = locateProofreadingIssue;
    root.ignoreProofreadingIssue = ignoreProofreadingIssue;
    root.applyProofreadingIssue = applyProofreadingIssue;
    root.undoProofreadingIssue = undoProofreadingIssue;
    root.applyAllProofreadingIssues = applyAllProofreadingIssues;
    root.getWpsProofreadingState = function () {
        return {
            snapshot: currentSnapshot,
            issues: currentIssues.slice(),
            busy: busy,
            actionBusy: issueActionBusy,
            provider: currentSettings().provider
        };
    };

    if (root.document) {
        if (root.document.readyState === "loading") {
            root.document.addEventListener("DOMContentLoaded", initConfiguration);
        } else {
            initConfiguration();
        }
    }
})(typeof window !== "undefined" ? window : globalThis);
