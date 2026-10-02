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
    var issueActionDocumentKey = null;
    var waitingForFullDocumentConfirmation = false;
    var runCounter = 0;
    var runAttemptCounter = 0;
    var actionCounter = 0;
    var documentSessions = Object.create(null);
    var activeDocumentKey = null;
    var currentResultRunId = 0;
    var currentStatus = { text: "当前文档尚未校对", tone: "idle" };
    var documentEventSource = null;
    var documentEventsBound = false;
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
        issueActionDocumentKey = issueActionBusy ? activeDocumentKey : null;
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
        currentStatus = { text: message, tone: tone || "idle" };
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

    function syncDocumentSession() {
        var document = activeDocument(app());
        var key = document ? documentKey(document) : "";
        if (key === activeDocumentKey) return false;
        if (typeof root.getProofreadingStatus === "function") {
            currentStatus = root.getProofreadingStatus();
        }
        if (busy) {
            if (currentController) currentController.abort();
            runAttemptCounter += 1;
            currentController = null;
            waitingForFullDocumentConfirmation = false;
            if (typeof root.dismissFullDocumentConfirmation === "function") {
                root.dismissFullDocumentConfirmation();
            }
            setStatus("校对已取消 · 已保留已完成的 " + currentIssues.length + " 项结果", "warning");
        }
        // A write may be awaiting its existing deferred verification. Its old
        // coordinates must not become usable if the user switches away and back.
        if (issueActionBusy && issueActionDocumentKey === activeDocumentKey) {
            currentSnapshot = null;
            currentIssues = currentIssues.map(function (issue) {
                return Object.assign({}, issue, { status: "stale" });
            });
            setStatus("正文在写入后发生变化，请重新校对。", "warning");
        }
        if (activeDocumentKey) {
            documentSessions[activeDocumentKey] = {
                snapshot: currentSnapshot,
                issues: currentIssues,
                runId: currentResultRunId,
                status: currentStatus,
                view: typeof root.captureProofreadingView === "function"
                    ? root.captureProofreadingView() : null
            };
        }
        activeDocumentKey = key;
        var session = key ? documentSessions[key] : null;
        currentSnapshot = session ? session.snapshot : null;
        currentIssues = session ? session.issues : [];
        currentResultRunId = session ? session.runId : 0;
        currentStatus = session ? session.status : { text: "当前文档尚未校对", tone: "idle" };
        // Clear the previous view before rendering, so UI-local saved-rule and
        // expanded-card state cannot be inherited from another document.
        if (typeof root.restoreProofreadingView === "function") {
            root.restoreProofreadingView(session && session.view);
        }
        setBusy(false);
        viewIssues();
        setStatus(currentStatus.text, currentStatus.tone);
        return true;
    }

    function bindDocumentEvents() {
        if (documentEventsBound) return;
        try {
            var application = app();
            var events = application && application.ApiEvent || root.wps && root.wps.ApiEvent;
            if (!events || typeof events.AddApiEventListener !== "function") return;
            events.AddApiEventListener("WindowActivate", syncDocumentSession);
            documentEventSource = events;
            documentEventsBound = true;
            try {
                events.AddApiEventListener("DocumentAfterClose", documentAfterClose);
            } catch (error) { /* Older versions can leave cleanup to pane teardown. */ }
        } catch (error) { /* Identity-only polling remains available. */ }
    }

    function documentAfterClose(document) {
        var key = document ? documentKey(document) : "";
        syncDocumentSession();
        if (key && key !== activeDocumentKey) delete documentSessions[key];
    }

    function proofreadDocumentMatches() {
        var document = activeDocument(app());
        return !!document && !!activeDocumentKey &&
            documentKey(document) === activeDocumentKey;
    }

    function canUseProofreadingIssue(issueId, runId) {
        if (!proofreadDocumentMatches() || (runId != null && runId !== currentResultRunId) ||
            !findPendingIssue(issueId)) {
            setStatus("请切回原文档或在当前文档重新校对。", "warning");
            return false;
        }
        return true;
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

    function revisionSnapshotMatches(snapshot) {
        try {
            var document = activeDocument(app());
            if (!document || documentKey(document) !== snapshot.documentKey) return false;
            var bounds = revisionSearchBounds(document);
            return !!bounds && text(document.Range(0, snapshot.start).Text) === snapshot.prefixText &&
                text(document.Range(snapshot.start, bounds.end).Text) === snapshot.selectedText;
        } catch (error) { return false; }
    }

    function isTrackRevisionsEnabled(document) {
        try {
            var value = document && document.TrackRevisions;
            if (value === false || value === 0 || value === "false" || value === "0") return false;
            if (value === true || value === 1 || value === -1 ||
                value === "true" || value === "1" || value === "-1") return true;
        } catch (error) { /* An unreadable flag must not make delta-based coordinates trusted. */ }
        return true;
    }

    function revisionSearchBounds(document, selectedText, allowMissingTail) {
        var content = document.Content;
        var start = Number(content && content.Start);
        var end = Number(content && content.End);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
        if (!currentSnapshot || currentSnapshot.mode !== "selection") return { start: start, end: end };
        var scopeStart = Math.max(start, currentSnapshot.start - ANCHOR_CHARACTERS);
        var selected = selectedText === undefined ? currentSnapshot.selectedText : selectedText;
        if (!selected) return null;
        // Find the first occurrence of the selection's tail after its original start.
        // Later copies outside the selection must not make an issue ambiguous.
        var tail = selected.slice(-Math.min(160, selected.length));
        var tailRange = firstRevisionTextRange(document, tail, currentSnapshot.start, end);
        return tailRange ? { start: scopeStart, end: tailRange.end }
            : allowMissingTail ? { start: scopeStart, end: end } : null;
    }

    function firstRevisionTextRange(document, needle, start, end) {
        if (!needle || end <= start) return null;
        try {
            var range = document.Range(start, end);
            var finder = range && range.Find;
            if (finder && typeof finder.Execute === "function") {
                if (typeof finder.ClearFormatting === "function") finder.ClearFormatting();
                finder.MatchCase = true;
                finder.MatchWildcards = false;
                finder.Wrap = 0;
                var result = finder.Execute(needle);
                if (!(result === true || result === 1 || result === -1 || finder.Found === true)) return null;
                return text(range.Text) === needle ? { start: Number(range.Start), end: Number(range.End) } : null;
            }
            // Without Find, inspect only a bounded area around the expected end.
            // If revision coordinates have moved farther, fail closed instead of
            // scanning the whole document for every pending issue.
            var nearStart = Math.max(start, currentSnapshot.end - 2048);
            var nearEnd = Math.min(end, currentSnapshot.end + 2048);
            var source = text(document.Range(nearStart, nearEnd).Text);
            var offset = source.indexOf(needle);
            if (offset < 0) return null;
            var candidate = document.Range(nearStart + offset, nearStart + offset + needle.length);
            return text(candidate.Text) === needle
                ? { start: Number(candidate.Start), end: Number(candidate.End) } : null;
        } catch (error) { return null; }
    }

    function uniqueRevisionTextRange(document, needle, start, end, hint) {
        if (!needle || end <= start) return null;
        var cursor = start;
        var found = null;
        try {
            while (cursor < end) {
                var range = document.Range(cursor, end);
                var finder = range && range.Find;
                if (!finder || typeof finder.Execute !== "function") {
                    if (found) return null;
                    break;
                }
                if (typeof finder.ClearFormatting === "function") finder.ClearFormatting();
                finder.MatchCase = true;
                finder.MatchWildcards = false;
                finder.Wrap = 0;
                var result = finder.Execute(needle);
                if (!(result === true || result === 1 || result === -1 || finder.Found === true)) {
                    return found;
                }
                var matchStart = Number(range.Start);
                var matchEnd = Number(range.End);
                if (!Number.isInteger(matchStart) || !Number.isInteger(matchEnd) ||
                    matchStart < cursor || matchEnd > end || matchEnd <= matchStart ||
                    text(range.Text) !== needle || found) return null;
                found = { start: matchStart, end: matchEnd };
                cursor = matchStart + 1;
            }
            if (found) return found;
            // Older WPS versions may omit Range.Find. A text-offset fallback is
            // accepted only when a fresh Range independently confirms its position.
            if (Number.isInteger(hint)) {
                start = Math.max(start, hint - 512);
                end = Math.min(end, hint + needle.length + 512);
            }
            var source = text(document.Range(start, end).Text);
            var offset = source.indexOf(needle);
            if (offset < 0 || source.indexOf(needle, offset + 1) >= 0) return null;
            var fallback = document.Range(start + offset, start + offset + needle.length);
            return text(fallback.Text) === needle
                ? { start: Number(fallback.Start), end: Number(fallback.End) } : null;
        } catch (error) {
            return null;
        }
    }

    function findAnchoredRevisionRange(document, expected, before, after, selectedText, hint, allowMissingTail) {
        var bounds = revisionSearchBounds(document, selectedText, allowMissingTail);
        var query = before + expected + after;
        if (!bounds || !query) return null;
        var context = uniqueRevisionTextRange(document, query, bounds.start, bounds.end, hint);
        if (!context) return null;
        var beforeRange = before
            ? firstRevisionTextRange(document, before, context.start, context.end) : null;
        if (before && (!beforeRange || beforeRange.start !== context.start)) return null;
        var innerStart = beforeRange ? beforeRange.end : context.start;
        var inner;
        if (expected) {
            inner = firstRevisionTextRange(document, expected, innerStart, context.end);
        } else if (after) {
            inner = firstRevisionTextRange(document, after, innerStart, context.end);
            if (inner) inner = { start: inner.start, end: inner.start };
        } else if (before) {
            inner = { start: innerStart, end: innerStart };
        }
        if (!inner || inner.start < context.start || inner.end > context.end) return null;
        try {
            if (text(document.Range(context.start, inner.start).Text) !== before ||
                text(document.Range(inner.start, inner.end).Text) !== expected ||
                text(document.Range(inner.end, context.end).Text) !== after) return null;
            return inner;
        } catch (error) {
            return null;
        }
    }

    function revisionAnchors(snapshot, relativeStart, expected) {
        if (!snapshot || relativeStart < 0 ||
            snapshot.selectedText.slice(relativeStart, relativeStart + expected.length) !== expected) return null;
        var before = snapshot.selectedText.slice(
            Math.max(0, relativeStart - ANCHOR_CHARACTERS), relativeStart);
        if (relativeStart < ANCHOR_CHARACTERS) {
            before = snapshot.prefixText.slice(-(ANCHOR_CHARACTERS - relativeStart)) + before;
        }
        var after = snapshot.selectedText.slice(
            relativeStart + expected.length,
            relativeStart + expected.length + ANCHOR_CHARACTERS);
        return before || after || expected ? { before: before, after: after } : null;
    }

    function issueContext(issue, expected) {
        if (!currentSnapshot || !Number.isInteger(issue.start) || !Number.isInteger(issue.end) ||
            issue.start < 0) return null;
        var relativeStart = Number.isInteger(issue.textOffset)
            ? issue.textOffset : issue.start - currentSnapshot.start;
        var relativeEnd = relativeStart + expected.length;
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
        var end = Number.isInteger(issue.textOffset)
            ? issue.end + after.length : Math.min(currentSnapshot.end, issue.end + after.length);
        return {
            start: start,
            end: end,
            relativeStart: relativeStart,
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
        if (isTrackRevisionsEnabled(document) || Number.isInteger(issue.textOffset)) {
            var anchored = findAnchoredRevisionRange(document, expected, context.before, context.after,
                undefined, issue.start);
            return anchored ? document.Range(anchored.start, anchored.end) : null;
        }
        var contextRange = document.Range(context.start, context.end);
        if (actionStage(perf, "rangeRead", function () { return text(contextRange.Text); }) !== context.text) return null;
        // Keep the write/selection Range short-lived; do not reuse it after a write or timer.
        return context.start === issue.start && context.end === issue.end
            ? contextRange : document.Range(issue.start, issue.end);
    }

    function updateSnapshotAfterReplacement(start, end, replacement, relativeStart, expectedLength) {
        if (!Number.isInteger(relativeStart)) relativeStart = start - currentSnapshot.start;
        var relativeEnd = relativeStart + (Number.isInteger(expectedLength)
            ? expectedLength : end - start);
        return Object.assign({}, currentSnapshot, {
            selectedText: currentSnapshot.selectedText.slice(0, relativeStart) +
                replacement + currentSnapshot.selectedText.slice(relativeEnd),
            end: currentSnapshot.end + replacement.length - (Number.isInteger(expectedLength)
                ? expectedLength : end - start)
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
            signal: currentController ? currentController.signal : undefined,
            maxOutputTokens: settings.provider === "openai" && profile &&
                /deepseek/i.test(profile.model || "")
                ? (String(profile.model || "").trim().toLowerCase() === "deepseek-flash" ? 64 * 1024 : 10000)
                : undefined
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
                runId: currentResultRunId,
                category: issue.category,
                categoryLabel: categoryLabel(issue.category),
                title: categoryLabel(issue.category) + (issue.needsReview ? " · 请复核" : ""),
                original: issue.original,
                reason: issue.reason,
                stateLabel: issueStateLabel(issue),
                confidence: issue.confidence,
                message: (issue.reason ? "原因：" + issue.reason + "\n" : "") + "状态：" + issueStateLabel(issue),
                action: issue.action || "",
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
            runId: currentResultRunId,
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
        return "当前设置：" + parts.join(" · ");
    }

    // Connection results belong to one configuration and one detection request.
    // Credentials are compared in memory only, never serialized into store keys.
    var connectionConfiguration = null;
    var connectionRevision = 0;
    var renderedConnectionRevision = 0;
    var modelDetectionCounter = 0;
    var connectionResult = null;

    function observeConnectionConfiguration() {
        var options = modelOptions();
        if (connectionConfiguration && connectionConfiguration.provider === options.provider &&
            connectionConfiguration.endpoint === options.endpoint && connectionConfiguration.apiKey === options.apiKey) return false;
        connectionConfiguration = { provider: options.provider, endpoint: options.endpoint, apiKey: options.apiKey };
        connectionRevision++;
        connectionResult = null;
        return true;
    }

    function modelConnectionState() {
        observeConnectionConfiguration();
        return Object.assign({ provider: connectionConfiguration.provider, detected: false, modelCount: 0 },
            connectionResult || { text: connectionRevision > 1 ? "配置已更改，需重新检测" : "尚未检测", tone: "idle" });
    }

    function renderModelSummary() {
        var summary = byId("model-summary");
        if (summary) summary.textContent = modelSummaryText();
        var connection = modelConnectionState();
        setConnectionStatus(connection.text, connection.tone);
        renderedConnectionRevision = connectionRevision;
        if (typeof root.syncSettingsForm === "function") root.syncSettingsForm();
    }

    function invalidateModelConnection() {
        connectionConfiguration = null;
        renderModelSummary();
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
        var connectionChanged = observeConnectionConfiguration();
        var key = storeStateKey();
        if (key === lastKnownStoreState && !connectionChanged && renderedConnectionRevision === connectionRevision) return false;
        lastKnownStoreState = key;
        renderModelSummary();
        return true;
    }

    function initConfiguration() {
        syncDocumentSession();
        bindDocumentEvents();
        syncFromStore();
        if (modelOptions().provider === "opencode" && canManageOpenCode()) {
            // The native service is already running when this page is served.
            refreshProviderModels();
        }
        if (root.document && typeof root.setInterval === "function") {
            root.setInterval(function () {
                syncDocumentSession();
                bindDocumentEvents();
                syncFromStore();
            }, 1000);
        }
        if (typeof root.addEventListener === "function") {
            root.addEventListener("unload", function () {
                if (currentController) currentController.abort();
                if (!documentEventSource) return;
                ["WindowActivate", "DocumentAfterClose"].forEach(function (event) {
                    try { documentEventSource.RemoveApiEventListener(event); }
                    catch (error) { /* The host may already be tearing down. */ }
                });
            });
        }
    }

    function canManageOpenCode() {
        return root.location && root.location.origin === "http://127.0.0.1:3891" &&
            typeof root.fetch === "function" &&
            !modelOptions().apiKey &&
            modelOptions().endpoint.replace(/\/+$/, "") === "http://127.0.0.1:4096";
    }

    async function nativeOpenCodeRequest(method, path) {
        var controller = makeAbortController();
        var timer;
        try {
            return await Promise.race([
                (async function () {
                    var response = await root.fetch("http://127.0.0.1:3891/api/opencode/" + path, {
                        method: method,
                        headers: method === "POST" ? { "Content-Type": "application/json" } : {},
                        credentials: "same-origin",
                        signal: controller ? controller.signal : undefined
                    });
                    if (!response.ok) throw new Error("OpenCode 本机管理服务暂时不可用，请查看高级 / 故障排查。");
                    return response.json();
                })(),
                new Promise(function (_, reject) {
                    timer = setTimeout(function () {
                        if (controller) controller.abort();
                        reject(new Error("OpenCode 自动连接超时，请重试。"));
                    }, method === "POST" ? 30000 : 5000);
                })
            ]);
        } finally { clearTimeout(timer); }
    }

    async function ensureOpenCodeReady(isCurrentDetection, showState) {
        if (!canManageOpenCode()) return null;
        var status;
        try {
            status = await nativeOpenCodeRequest("GET", "status");
        } catch (error) {
            // Older asset servers lack the manager API. An already running
            // OpenCode can still be used through its own health/model endpoints.
            return null;
        }
        if (!isCurrentDetection()) return { stale: true };
        if (status.state === "stopped") {
            showState("正在启动 OpenCode…", "working");
            status = await nativeOpenCodeRequest("POST", "start");
            if (!isCurrentDetection()) return { stale: true };
        }
        if (status.state === "ready") return status;
        var messages = {
            missing: "未检测到 OpenCode。请查看安装方法。",
            port_conflict: "4096 端口被其他程序占用，无法自动启动 OpenCode。",
            error: "已检测到 OpenCode，但服务启动失败。请重试或查看详情。",
            stopped: "已检测到 OpenCode，但服务启动失败。请重试或查看详情。"
        };
        var detail = typeof status.detail === "string" ? status.detail.trim() : "";
        throw new Error((messages[status.state] || messages.error) + (detail ? " " + detail : ""));
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
        var options;
        var request = ++modelDetectionCounter;
        var revision;
        var api = settingsStore();
        function isCurrentDetection() {
            observeConnectionConfiguration();
            return request === modelDetectionCounter && revision === connectionRevision;
        }
        try {
            options = modelOptions();
            observeConnectionConfiguration();
            revision = connectionRevision;
            connectionResult = { text: "正在检测…", tone: "working" };
            renderModelSummary();
            if (!root.WpsModelCatalog) throw new Error("模型检测模块没有加载。");
            var nativeStatus = options.provider === "opencode" && canManageOpenCode()
                ? await ensureOpenCodeReady(isCurrentDetection, function (text, tone) {
                    connectionResult = { text: text, tone: tone };
                    renderModelSummary();
                }) : null;
            if (nativeStatus && nativeStatus.stale) return { models: [], defaultModel: "", stale: true };
            var result = await root.WpsModelCatalog.detect(options, root.fetch);
            if (!isCurrentDetection()) {
                syncFromStore();
                return { models: [], defaultModel: "", stale: true };
            }
            if (result.provider !== options.provider) throw new Error("检测结果与当前服务类型不一致，请重新检测。");
            saveCatalogResult(result.provider, result, result.models.length ? "success" : "error");
            if (result.models.length && result.defaultModel && api && typeof api.updateSettings === "function") {
                var profile = currentSettings().profiles[result.provider] || { model: "" };
                if (!profile.model || result.models.indexOf(profile.model) < 0) {
                    api.updateSettings({ provider: result.provider, profile: { model: result.defaultModel } });
                }
            }
            connectionResult = result.models.length ? {
                text: nativeStatus && nativeStatus.version
                    ? "OpenCode " + nativeStatus.version + " · 已发现 " + result.models.length + " 个模型"
                    : (result.detail || "已检测") + " · " + result.models.length + " 个模型",
                tone: "success", detected: true, modelCount: result.models.length
            } : { text: "模型服务已连接，但未读取到可用模型。", tone: "warning" };
            syncFromStore();
            // Detection changes the UI even when the stored catalog is unchanged.
            renderModelSummary();
            if (!result.models.length) {
                return { models: [], defaultModel: "" };
            }
            return { models: result.models, defaultModel: result.defaultModel };
        } catch (error) {
            if (!isCurrentDetection()) {
                syncFromStore();
                return { models: [], defaultModel: "", stale: true };
            }
            var existing = api && typeof api.loadCatalog === "function" ? api.loadCatalog() : null;
            if (options) {
                saveCatalogResult(options.provider, {
                    models: existing && existing.provider === options.provider ? existing.models : [],
                    defaultModel: existing && existing.provider === options.provider ? existing.defaultModel : "",
                    detail: "连接失败"
                }, "error");
            }
            connectionResult = { text: error && error.message
                ? error.message : "模型服务检测失败。请确认服务已启动并允许加载项跨域访问。", tone: "error" };
            syncFromStore();
            renderModelSummary();
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
            await ensureOpenCodeConnection(options);
            return root.WpsOpenCodeClient.request({
                endpoint: options.endpoint,
                model: options.model,
                password: options.apiKey,
                signal: options.signal
            }, prompt, root.fetch);
        }
        return root.WpsProofreadingCore.requestModel(options, prompt);
    }

    async function ensureOpenCodeConnection(options) {
        if (options.provider !== "opencode" || !canManageOpenCode() || options.apiKey ||
            options.endpoint.replace(/\/+$/, "") !== "http://127.0.0.1:4096") return;
        function isCurrent() {
            var current = modelOptions();
            return !(options.signal && options.signal.aborted) && current.provider === options.provider &&
                current.endpoint === options.endpoint && current.apiKey === options.apiKey;
        }
        if (!isCurrent()) throw new Error("模型设置已变化或请求已取消，请重试。");
        var status = await ensureOpenCodeReady(isCurrent, function () {});
        if ((status && status.stale) || !isCurrent()) throw new Error("模型设置已变化或请求已取消，请重试。");
    }

    function reportProgress(percent, label) {
        if (typeof root.setProofreadingProgress === "function") {
            root.setProofreadingProgress(percent, label || "");
        }
    }

    function resultCountLabel() {
        return currentIssues.length ? "已发现 " + currentIssues.length + " 项" : "暂未发现问题";
    }

    function ensureRunActive(controller, runId, attempt) {
        syncDocumentSession();
        if (attempt !== runAttemptCounter || controller !== currentController || runId !== runCounter ||
            (controller && controller.signal && controller.signal.aborted)) {
            var error = new Error("已取消校对。");
            error.name = "AbortError";
            throw error;
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
                ruleId: ruleIssue.ruleId || "",
                ruleName: ruleIssue.ruleName || "",
                ruleGroup: ruleIssue.ruleGroup || "",
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

    function stableIssueId(issue) {
        var source = issueOrigin(issue).indexOf("rule") >= 0 ? "rule" : "ai";
        var identity = [runCounter, source, issue.start, issue.end, issue.original,
            source === "rule" ? (issue.ruleId || issue.ruleName || "") : (issue.action || ""),
            source === "rule" ? "" : (issue.suggestion || "")].join("\u0000");
        var hash = 2166136261;
        for (var i = 0; i < identity.length; i += 1) {
            hash ^= identity.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return "issue-" + runCounter + "-" + issue.start + "-" + (hash >>> 0).toString(36);
    }

    function mergeMappedIssues(list) {
        var input = (list || []).slice().filter(function (issue) {
            return issue && Number.isFinite(Number(issue.start)) && Number.isFinite(Number(issue.end));
        }).map(function (issue, index) {
            return Object.assign({ origin: issueOrigin(issue), insertionOrder: index }, issue);
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

            if (sameOriginal && existing.suggestion === issue.suggestion &&
                existing.action === issue.action) return;

            var existingRule = existingOrigin.indexOf("rule") >= 0;
            var incomingRule = incomingOrigin.indexOf("rule") >= 0;
            if (sameOriginal && !existingRule && !incomingRule &&
                (existing.suggestion !== issue.suggestion || existing.action !== issue.action)) {
                kept.push(issue);
                return;
            }
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
            var leftRule = issueOrigin(left).indexOf("rule") >= 0;
            var rightRule = issueOrigin(right).indexOf("rule") >= 0;
            return left.start - right.start || left.end - right.end ||
                Number(rightRule) - Number(leftRule) ||
                left.insertionOrder - right.insertionOrder;
        });
        kept.forEach(function (issue) {
            issue.id = stableIssueId(issue);
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
                ruleSource: candidate.ruleSource || "",
                severity: candidate.severity || "",
                priority: Number(candidate.priority) || 0,
                needsReview: true,
                actionable: issue.actionable !== false,
                reason: mergeReasons(
                    issue.reason,
                    candidate.instruction,
                    "该建议由 AI 核查规则结合上下文确认，需人工复核后再应用。"
                )
            });
        });
    }

    function providerDisplayName(provider) {
        return provider === "opencode" ? "OpenCode" :
            provider === "ollama" ? "Ollama" : "兼容接口";
    }

    async function runProofreading(restart) {
        syncDocumentSession();
        if (issueActionBusy) return { accepted: false, reason: "action-busy" };
        if (busy && restart !== true) return { accepted: false, reason: "busy" };
        if (typeof root.getTaskBusyState === "function" && root.getTaskBusyState().rewrite) {
            return { accepted: false, reason: "rewrite-busy" };
        }
        if (busy && currentController) {
            currentController.abort();
            if (waitingForFullDocumentConfirmation &&
                typeof root.dismissFullDocumentConfirmation === "function") {
                root.dismissFullDocumentConfirmation();
            }
        }
        currentController = makeAbortController();
        var runController = currentController;
        var runAttempt = ++runAttemptCounter;
        setBusy(true);

        var snapshot = null;
        var collected = [];
        var discarded = false;
        try {
            if (root.WpsRulesReady && typeof root.WpsRulesReady.then === "function") {
                await root.WpsRulesReady;
            }
            syncDocumentSession();
            if (runAttempt !== runAttemptCounter ||
                (runController && runController.signal && runController.signal.aborted)) {
                return { accepted: false, reason: "cancelled" };
            }
            snapshot = captureSnapshot();
            if (!snapshot.documentKey) throw new Error("无法确认当前文档身份，请重新打开文档后重试。");
            var options = validateModelOptions(modelOptions());
            var providerLabel = providerDisplayName(options.provider);
            var scopeLabel = snapshot.mode === "full" ? "全文" : "选区";
            if (snapshot.mode === "full") {
                if (typeof root.requestFullDocumentConfirmation !== "function") {
                    setStatus("全文确认面板尚未加载，请完全退出 WPS 后重新打开插件。", "warning");
                    return { accepted: false, reason: "full-document-confirmation-unavailable" };
                }
                waitingForFullDocumentConfirmation = true;
                setStatus("当前未选择文字，等待确认校对全文…", "warning");
                var confirmed = await root.requestFullDocumentConfirmation({
                    characterCount: snapshot.selectedText.length,
                    providerLabel: providerLabel,
                    model: options.model || ""
                });
                syncDocumentSession();
                if (runAttempt !== runAttemptCounter ||
                    (runController && runController.signal && runController.signal.aborted)) {
                    return { accepted: false, reason: "cancelled" };
                }
                waitingForFullDocumentConfirmation = false;
                if (confirmed !== true) {
                    setStatus("已取消全文校对，文档内容没有发送。", "warning");
                    return { accepted: false, reason: "full-document-not-confirmed" };
                }
                if (!currentDocumentMatches(snapshot)) {
                    setStatus("等待确认期间文档内容已变化，文档内容没有发送。请重新开始校对。", "warning");
                    return { accepted: false, reason: "document-changed-before-request" };
                }
            }
            // Replace the previous run only after the new range and any full-document
            // confirmation have succeeded. Cancellations leave old findings usable.
            currentSnapshot = null;
            currentIssues = [];
            runCounter += 1;
            currentResultRunId = runCounter;
            var activeRunId = runCounter;
            if (typeof root.beginProofreadingRun === "function") {
                root.beginProofreadingRun();
            } else {
                viewIssues();
                if (typeof root.clearProofreadingIssues === "function") root.clearProofreadingIssues();
            }
            setStatus("正在通过 " + providerLabel + " 校对" + scopeLabel +
                "（按段落分批发送，只发送待校对的文字）…", "working");
            reportProgress(0, "已读取" + scopeLabel);

            var localRuleIssues = root.WpsRulesCenter &&
                typeof root.WpsRulesCenter.evaluate === "function"
                ? root.WpsRulesCenter.evaluate(snapshot.selectedText, snapshot.start)
                : [];
            var aiReviewCandidates = root.WpsRulesCenter &&
                typeof root.WpsRulesCenter.collectAiReviewCandidates === "function"
                ? root.WpsRulesCenter.collectAiReviewCandidates(snapshot.selectedText, snapshot.start)
                : [];
            collected = collected.concat(localRuleIssues);
            currentSnapshot = snapshot;
            currentIssues = mergeMappedIssues(collected);
            viewIssues();
            setStatus("规则扫描完成 · 本地检查完成 · " + resultCountLabel() +
                (aiReviewCandidates.length ? " · AI核查点 " + aiReviewCandidates.length + " 处" : ""), "working");
            reportProgress(0, "本地检查完成 · " + resultCountLabel());

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
                ensureRunActive(runController, activeRunId, runAttempt);
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
                setStatus("AI 校对 " + firstPassPercent + "% · " + resultCountLabel(), "working");
                reportProgress(firstPassPercent, "AI 校对 " + firstPassPercent + "% · " +
                    resultCountLabel() + " · " + batchLabel);
            }

            if (runConsistencyPass) {
                if (currentController && currentController.signal && currentController.signal.aborted) {
                    var consistencyAbortError = new Error("已取消校对。");
                    consistencyAbortError.name = "AbortError";
                    throw consistencyAbortError;
                }
                setStatus("正在进行全文一致性复核 · " + resultCountLabel(), "working");
                reportProgress(firstPassProgressCeiling, "全文一致性复核中 · " + resultCountLabel());
                try {
                    for (var candidateBatchIndex = 0; candidateBatchIndex < consistencyBatches.length; candidateBatchIndex += 1) {
                        var consistencyBatch = consistencyBatches[candidateBatchIndex];
                        var consistencyPrompt = root.WpsProofreadingCore.buildConsistencyPrompt(consistencyBatch);
                        var consistencyResponse = await requestProofreadingModel(options, consistencyPrompt);
                        ensureRunActive(runController, activeRunId, runAttempt);
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
                        setStatus("正在进行全文一致性复核 · " + resultCountLabel(), "working");
                        reportProgress(firstPassProgressCeiling + Math.round(
                            ((candidateBatchIndex + 1) / consistencyBatches.length) * (100 - firstPassProgressCeiling)),
                            "全文一致性复核 · " + resultCountLabel() + " · 第 " +
                            (candidateBatchIndex + 1) + "/" + consistencyBatches.length + " 批候选组");
                    }
                    consistencyCompleted = true;
                    reportProgress(100, "全文一致性复核完成");
                } catch (consistencyError) {
                    ensureRunActive(runController, activeRunId, runAttempt);
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

            ensureRunActive(runController, activeRunId, runAttempt);
            if (!currentDocumentMatches(snapshot)) {
                currentSnapshot = null;
                currentIssues = [];
                discarded = true;
                viewIssues();
                throw new Error("校对期间" + scopeLabel + "内容已变化，结果已丢弃。请重新校对。");
            }
            currentIssues = mergeMappedIssues(collected);
            currentSnapshot = snapshot;
            reportProgress(100, currentIssues.length
                ? "校对完成 · 共发现 " + currentIssues.length + " 项"
                : "校对完成 · 未发现明显问题");
            var consistencyText = runConsistencyPass
                ? (consistencyCompleted
                    ? "；已复核 " + consistencyCandidates.length + " 组全文一致性候选"
                    : "；逐段校对已完成，但一致性复核未完成")
                : "";
            var finalTone = consistencyWarning ? "warning" : "success";
            setStatus(currentIssues.length
                ? "校对完成 · 共发现 " + currentIssues.length + " 项（" +
                    batches.length + " 批" + consistencyText + "）。点击问题卡片可定位，再选择修正或忽略。" +
                    (consistencyWarning ? " " + consistencyWarning : "")
                : "校对完成 · 未发现明显问题" + consistencyText + "。" +
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
            syncDocumentSession();
            if (runAttempt !== runAttemptCounter || currentController !== runController) {
                return { accepted: false, reason: "cancelled" };
            }
            var cancelled = runController && runController.signal && runController.signal.aborted;
            var partial = collected.length > 0 && !discarded && snapshot &&
                currentDocumentMatches(snapshot);
            if (partial) {
                currentIssues = mergeMappedIssues(collected);
                currentSnapshot = snapshot;
                viewIssues();
            }
            if (cancelled || (error && error.name === "AbortError")) {
                setStatus("校对已取消 · 已保留已完成的 " + currentIssues.length + " 项结果", "warning");
                return { accepted: false, reason: "cancelled" };
            }
            setStatus(partial
                ? "校对中断 · 已保留已完成的 " + currentIssues.length + " 项结果。" +
                    (error && error.message ? error.message : "请重试。")
                : (error && error.message ? error.message : "校对失败，请重试。"), "error");
            return { accepted: false, reason: "error" };
        } finally {
            syncDocumentSession();
            if (runAttempt === runAttemptCounter && currentController === runController) {
                waitingForFullDocumentConfirmation = false;
                if (typeof root.dismissFullDocumentConfirmation === "function") {
                    root.dismissFullDocumentConfirmation();
                }
                currentController = null;
                setBusy(false);
            }
        }
    }

    function cancelProofreading() {
        if (syncDocumentSession()) return false;
        if (busy && waitingForFullDocumentConfirmation &&
            typeof root.dismissFullDocumentConfirmation === "function") {
            if (currentController) currentController.abort();
            root.dismissFullDocumentConfirmation();
            return true;
        }
        if (!busy) {
            setStatus("当前没有正在进行的校对。", "warning");
            return false;
        }
        if (currentController) currentController.abort();
        else {
            runAttemptCounter += 1;
            setBusy(false);
        }
        setStatus("校对已取消 · 已保留已完成的 " + currentIssues.length + " 项结果", "warning");
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
        if (!proofreadDocumentMatches()) {
            setStatus("请切回原文档或在当前文档重新校对。", "warning");
            return true;
        }
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
        if (issueActionBusy) return false;
        var perf = startActionPerf("locate");
        var outcome = "rejected";
        setIssueActionBusy(true);
        try {
            if (!canUseProofreadingIssue(issueId)) return false;
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
        if (!canUseProofreadingIssue(issueId)) return false;
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
                var operationDocument = activeDocument(app());
                change.trackRevisionsAtWrite = isTrackRevisionsEnabled(operationDocument);
                change.revisionMode = change.trackRevisionsAtWrite ||
                    Number.isInteger(issue.textOffset) || currentIssues.some(function (candidate) {
                        return Number.isInteger(candidate.textOffset);
                    });
                context = issueContext(issue, change.expected);
                if (context && change.replacement === "" && !context.before && !context.after) {
                    change.unverifiableDeletion = true;
                    return null;
                }
                return checkedIssueRange(issue, change.expected, perf, operationDocument, context);
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
        change.snapshotOffset = context.relativeStart;
        change.start = Number(range.Start);
        change.end = Number(range.End);
        if (!Number.isInteger(change.start) || !Number.isInteger(change.end) ||
            change.end < change.start) return false;
        change.attempted = true;
        actionStage(perf, "write", function () { range.Text = change.replacement; });
        change.written = true;
        // No live WPS Range is carried into the next event-loop turn.
        return true;
    }

    function completeIssueReplacement(change, perf) {
        if (change.revisionMode) {
            var document = activeDocument(app());
            if (!document || documentKey(document) !== change.documentKey) {
                throw new Error("document-changed");
            }
            var revisedSnapshot = actionStage(perf, "snapshotUpdate", function () {
                return updateSnapshotAfterReplacement(change.start, change.end,
                    change.replacement, change.snapshotOffset, change.expected.length);
            });
            var revisedIssues = actionStage(perf, "stateShift", function () {
                return currentIssues.map(function (issue) {
                    var updated = Object.assign({}, issue);
                    if (issue.id === change.issue.id) {
                        updated.start = change.verifiedStart;
                        updated.end = change.verifiedEnd;
                        updated.textOffset = change.snapshotOffset;
                        updated.status = change.action === "undone" ? "pending" : "accepted";
                        return updated;
                    }
                    if (issue.status !== "pending" && issue.status !== "accepted") return updated;
                    var expected = issue.status === "accepted" ? issue.suggestion : issue.original;
                    var relative = Number.isInteger(issue.textOffset)
                        ? issue.textOffset : issue.start - currentSnapshot.start;
                    if (relative >= change.snapshotOffset + change.expected.length) {
                        relative += change.delta;
                    } else if (relative + expected.length > change.snapshotOffset) {
                        updated.status = "stale";
                        return updated;
                    }
                    var anchors = revisionAnchors(revisedSnapshot, relative, expected);
                    var location = null;
                    if (anchors) {
                        try {
                            location = findAnchoredRevisionRange(
                                document, expected, anchors.before, anchors.after,
                                revisedSnapshot.selectedText, issue.start);
                        } catch (error) { /* A failed WPS lookup leaves this issue stale. */ }
                    }
                    if (!location) {
                        updated.status = "stale";
                    } else {
                        updated.start = location.start;
                        updated.end = location.end;
                        updated.textOffset = relative;
                    }
                    return updated;
                });
            });
            currentIssues = revisedIssues;
            currentSnapshot = revisedSnapshot;
            return;
        }
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
                if (isTrackRevisionsEnabled(document) !== change.trackRevisionsAtWrite) return false;
                if (change.revisionMode) {
                    var revisedText = updateSnapshotAfterReplacement(change.start, change.end,
                        change.replacement, change.snapshotOffset, change.expected.length).selectedText;
                    var revised = findAnchoredRevisionRange(
                        document, change.replacement, change.before, change.after,
                        revisedText, change.start, true);
                    if (!revised || findAnchoredRevisionRange(
                        document, change.expected, change.before, change.after,
                        revisedText, change.start, true)) return false;
                    change.verifiedStart = revised.start;
                    change.verifiedEnd = revised.end;
                    return true;
                }
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
        if (change.revisionMode && !verifyWrittenChange(change)) {
            invalidateWrittenAction(change);
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
        var operationKey = activeDocumentKey;
        var operationSnapshot = currentSnapshot;
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
            if (operationKey !== activeDocumentKey || operationSnapshot !== currentSnapshot) {
                outcome = "post-write-changed";
                return false;
            }
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
            var autoAdvance = !undo && currentSettings().autoAdvance !== false;
            if (autoAdvance) {
                try {
                    navigation = actionStage(perf, "locateNext", function () {
                        return locateNextPendingIssue(issue.id, perf);
                    });
                } catch (error) { warning = true; }
            } else if (!undo) {
                navigation.hadPending = currentIssues.some(function (candidate) {
                    return candidate.status === "pending";
                });
            }
            try { actionStage(perf, "render", viewIssues); }
            catch (error) { warning = true; }
            outcome = warning ? "written-with-warning" : "completed";
            var hasStale = currentIssues.some(function (candidate) {
                return candidate.status === "stale";
            });
            setStatus(warning
                ? "正文修改已完成，但部分记录或界面收尾失败。请检查正文后重新校对。"
                : undo ? "已撤销这条修改，建议恢复为待确认。"
                    : !autoAdvance && navigation.hadPending ? "已应用一条建议，其余建议待确认。"
                    : navigation.located ? "已应用一条建议，并定位到下一条待处理问题。"
                        : navigation.hadPending || hasStale ? "已应用一条建议；其他原文已变化，请重新校对。"
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
        var document = activeDocument(app());
        var uncertainCoordinates = isTrackRevisionsEnabled(document) || currentIssues.some(function (issue) {
            return Number.isInteger(issue.textOffset);
        });
        if (!(uncertainCoordinates ? revisionSnapshotMatches(currentSnapshot)
            : currentDocumentMatches(currentSnapshot))) {
            markAllPendingStale("选区内容已变化，未写入任何建议。请重新校对。");
            return { applied: 0, failed: pendingIds.length, skipped: skipped, stale: true };
        }

        var applied = 0;
        var failed = 0;
        for (var index = 0; index < pendingIds.length; index += 1) {
            var issue = findPendingIssue(pendingIds[index]);
            if (!issue || !isAutoFixableIssue(issue)) {
                failed = pendingIds.length - applied;
                markAllPendingStale("原文或上下文已变化，剩余建议未写入。已修正 " +
                    applied + " 条，请重新校对。");
                return { applied: applied, failed: failed, skipped: skipped, stale: true };
            }
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
                failed = pendingIds.length - applied;
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
    root.ensureOpenCodeConnection = ensureOpenCodeConnection;
    root.getModelConnectionState = modelConnectionState;
    root.invalidateModelConnection = invalidateModelConnection;
    root.locateProofreadingIssue = locateProofreadingIssue;
    root.ignoreProofreadingIssue = ignoreProofreadingIssue;
    root.applyProofreadingIssue = applyProofreadingIssue;
    root.undoProofreadingIssue = undoProofreadingIssue;
    root.applyAllProofreadingIssues = applyAllProofreadingIssues;
    root.canUseProofreadingIssue = canUseProofreadingIssue;
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
