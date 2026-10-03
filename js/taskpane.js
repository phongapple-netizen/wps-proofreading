(function (root) {
    "use strict";

    var state = {
        status: { text: "等待开始", tone: "idle" },
        issues: [],
        activeIssueId: "",
        filter: "all",
        busy: false,
        runFinished: false,
        actionBusy: false,
        firstPassComplete: false,
        rewriteBusy: false,
        appMode: "proofread",
        tab: "issues",
        history: [],
        historyIds: {},
        emptyMessage: "校对结果会显示在这里。"
    };
    var pendingFullDocumentConfirmation = null;
    var renderedIssueActionButtons = [];
    var issueCardCache = Object.create(null);
    var processedIssuesDetails = null;
    var processedIssuesSummary = null;
    var processedIssuesList = null;
    var locateToastTimer = null;
    var activeIssueMenu = null;
    var issueMenuDismissBound = false;

    function byId(id) {
        return root.document && root.document.getElementById
            ? root.document.getElementById(id)
            : null;
    }

    function normalizeStatus(status, tone) {
        if (status && typeof status === "object") {
            return {
                text: String(status.text || status.message || ""),
                tone: String(status.tone || status.level || "idle")
            };
        }
        return {
            text: String(status == null ? "" : status),
            tone: String(tone || "idle")
        };
    }

    function setProofreadingStatus(status, tone) {
        var nextStatus = normalizeStatus(status, tone);
        if (nextStatus.text === "已在文档中定位这条问题。") {
            var toast = byId("proofreading-toast");
            if (toast) {
                toast.textContent = nextStatus.text;
                toast.hidden = false;
                if (locateToastTimer !== null && root.clearTimeout) root.clearTimeout(locateToastTimer);
                if (root.setTimeout) locateToastTimer = root.setTimeout(function () {
                    toast.hidden = true;
                    locateToastTimer = null;
                }, 3000);
            }
            return nextStatus;
        }
        state.status = nextStatus;
        if (/^校对完成|^校对已取消|^校对中断/.test(nextStatus.text) ||
            (state.busy && nextStatus.tone === "error")) state.runFinished = true;
        var element = byId("proofreading-status");
        if (element) {
            element.textContent = state.status.text;
            element.className = "status status-" + state.status.tone +
                (state.status.tone === "success" || state.status.tone === "idle" ? " status-compact" : "");
        }
        updatePanelLayout();
        if (state.runFinished && !state.issues.length) {
            var empty = byId("empty-state");
            if (empty) empty.textContent = state.status.text;
        }
        return state.status;
    }

    function setModelConnectionStatus(message, tone) {
        var settings = loadStoredSettings();
        if (settings && settings.rulesOnly === true && state.appMode !== "rewrite") {
            message = "仅规则校对已就绪 · 无需连接模型";
            tone = "success";
        }
        var dot = byId("connection-dot");
        if (dot) {
            dot.className = "connection-dot connection-dot-" + String(tone || "idle");
            dot.title = String(message || "尚未连接");
        }
        var element = byId("connection-status");
        if (element) {
            element.textContent = String(message || "");
            element.className = "connection-status connection-status-" + String(tone || "idle");
        }
        var service = byId("opencode-service-message");
        if (!service) return;
        var provider = currentProvider(loadStoredSettings());
        var text = String(message || "");
        var missing = /未检测到 OpenCode/.test(text);
        var failed = /启动失败|端口被其他程序占用|管理服务暂时不可用/.test(text);
        service.textContent = provider === "opencode" ? text : "";
        var retry = byId("opencode-retry");
        var installHelp = byId("opencode-install-help");
        var details = byId("opencode-details");
        if (retry) retry.hidden = provider !== "opencode" || !failed;
        if (installHelp) installHelp.hidden = provider !== "opencode" || !missing;
        if (details) details.hidden = provider !== "opencode" || !failed;
    }

    function setProofreadingBusy(value) {
        state.busy = value === true;
        updateModeTabs();
        var cancelButton = byId("cancel-proofreading");
        if (cancelButton) {
            cancelButton.hidden = !state.busy || !!pendingFullDocumentConfirmation;
            cancelButton.disabled = !state.busy;
        }
        if (!state.busy) setProofreadingProgress(0, "");
        renderIssues();
        updateIssueBusyControls();
        updateActionControls();
        return state.busy;
    }

    function updateActionControls() {
        var runButton = byId("run-proofreading");
        var applyAllButton = byId("apply-all");
        var rerunButton = byId("rerun-proofreading");

        if (runButton) runButton.disabled = state.busy || state.actionBusy;
        if (applyAllButton) {
            applyAllButton.disabled = issueWriteLocked() || state.actionBusy || !autoFixableCount();
            applyAllButton.title = issueWriteLocked() ? "校对完成后可修改正文；仅处理低风险格式规则" :
                "仅处理低风险格式规则，其他建议需逐条确认";
        }
        if (rerunButton) rerunButton.disabled = state.actionBusy;
        renderedIssueActionButtons.forEach(function (button) {
            button.disabled = state.actionBusy || button._proofreadingActionDisabled === true ||
                (state.busy && button._proofreadingWriteAction === true && !state.firstPassComplete) ||
                (state.busy && button._proofreadingRuleAction === true);
        });
    }

    function issueWriteLocked() { return state.busy && !state.firstPassComplete; }

    function updateIssueBusyControls() {
        renderedIssueActionButtons.forEach(function (button) {
            button.disabled = state.actionBusy || button._proofreadingActionDisabled === true ||
                (state.busy && button._proofreadingWriteAction === true && !state.firstPassComplete) ||
                (state.busy && button._proofreadingRuleAction === true);
            if (button._proofreadingWriteAction) button.title = issueWriteLocked() ? "校对完成后可修改正文" : "";
        });
        updateActionControls();
    }

    function setProofreadingFirstPassComplete(value) {
        state.firstPassComplete = value === true;
        updateIssueBusyControls();
        return state.firstPassComplete;
    }

    function setProofreadingActionBusy(value) {
        state.actionBusy = value === true;
        updateModeTabs();
        updateActionControls();
        return state.actionBusy;
    }

    function taskBusyState() {
        return { proofreading: state.busy, actionBusy: state.actionBusy, rewrite: state.rewriteBusy };
    }

    function updateModeTabs() {
        var locked = state.busy || state.actionBusy || state.rewriteBusy;
        var proofreadingTab = byId("mode-proofread");
        var rewriteTab = byId("mode-rewrite");
        if (proofreadingTab) proofreadingTab.disabled = locked;
        if (rewriteTab) rewriteTab.disabled = locked;
    }

    function setRewriteBusy(value) {
        state.rewriteBusy = value === true;
        updateModeTabs();
        return state.rewriteBusy;
    }

    function finishFullDocumentConfirmation(confirmed) {
        var pending = pendingFullDocumentConfirmation;
        if (!pending) return false;
        pendingFullDocumentConfirmation = null;
        var panel = byId("full-document-confirmation");
        if (panel) panel.hidden = true;
        var cancelButton = byId("cancel-proofreading");
        if (cancelButton) cancelButton.hidden = !state.busy;
        pending.resolve(confirmed === true);
        // Restore focus after the run has had a chance to enable its controls.
        setTimeout(function () {
            if (!pendingFullDocumentConfirmation && pending.previousFocus &&
                pending.previousFocus.isConnected !== false &&
                typeof pending.previousFocus.focus === "function") {
                pending.previousFocus.focus();
            }
        }, 0);
        return true;
    }

    function dismissFullDocumentConfirmation() {
        return finishFullDocumentConfirmation(false);
    }

    function requestFullDocumentConfirmation(details) {
        var panel = byId("full-document-confirmation");
        var message = byId("full-document-confirmation-message");
        var confirmButton = byId("confirm-full-document");
        var declineButton = byId("decline-full-document");
        if (!panel || !message || !confirmButton || !declineButton) {
            return Promise.reject(new Error("全文确认控件没有加载，请完全退出 WPS 后重新打开插件。"));
        }
        dismissFullDocumentConfirmation();
        var value = details || {};
        var target = String(value.providerLabel || "所选模型服务");
        if (value.model) target += "（" + String(value.model) + "）";
        message.textContent = "当前未选择文字，将校对全文，共 " +
            (Number(value.characterCount) || 0) + " 个字符。\n" + (value.rulesOnly === true
                ? "仅在本机检查已启用的规则，不发送正文。"
                : "待校对文本将发送给 " + target + "。");
        return new Promise(function (resolve) {
            pendingFullDocumentConfirmation = {
                resolve: resolve,
                previousFocus: root.document.activeElement
            };
            panel.hidden = false;
            var cancelButton = byId("cancel-proofreading");
            if (cancelButton) cancelButton.hidden = true;
            if (typeof confirmButton.focus === "function") confirmButton.focus();
        });
    }

    function setProofreadingProgress(percent, label) {
        var bar = byId("proofreading-progress");
        var fill = byId("progress-fill");
        var labelEl = byId("progress-label");
        if (!bar) return;
        var value = Math.round(Number(percent) || 0);
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        if (!state.busy && value === 0) {
            bar.hidden = true;
            if (fill) fill.style.width = "0%";
            if (labelEl) labelEl.textContent = "";
            return;
        }
        bar.hidden = false;
        if (fill) fill.style.width = value + "%";
        if (labelEl) {
            var fullLabel = String(label || "");
            var batch = fullLabel.match(/第\s*\d+\/\d+\s*批/);
            var stage = fullLabel.match(/正文校对|全文一致性复核|一致性复核|深度增强|本地规则/);
            labelEl.title = fullLabel;
            labelEl.setAttribute("aria-label", fullLabel || value + "%");
            labelEl.textContent = batch
                ? (stage ? stage[0] + " · " : "") + batch[0] + " · " + value + "%"
                : (fullLabel ? fullLabel + (/\d+%/.test(fullLabel) || value === 0 ? "" : " · " + value + "%") : value + "%");
        }
    }

    function getProofreadingStatus() {
        return {
            text: state.status.text,
            tone: state.status.tone
        };
    }

    function readSelectedText() {
        if (!root.WpsNativeDocument || typeof root.WpsNativeDocument.readSelectionText !== "function") {
            return "";
        }
        try {
            return root.WpsNativeDocument.readSelectionText();
        } catch (error) {
            return "";
        }
    }

    function refreshProofreadingSelection() {
        return readSelectedText();
    }

    function settingsPopover() {
        return byId("settings-popover");
    }

    function setSettingsOpen(open) {
        var popover = settingsPopover();
        var toggle = byId("settings-toggle");
        var visible = open === true;
        if (popover) popover.hidden = !visible;
        var mainView = byId("main-view");
        if (mainView) mainView.hidden = visible;
        if (toggle) {
            toggle.setAttribute("aria-expanded", visible ? "true" : "false");
            toggle.classList.toggle("is-active", visible);
        }
        return visible;
    }

    function bindSettingsToggle() {
        var toggle = byId("settings-toggle");
        var popover = settingsPopover();
        if (!toggle || !popover) return;
        var back = byId("settings-back");

        toggle.addEventListener("click", function (event) {
            event.stopPropagation();
            setSettingsOpen(popover.hidden);
        });
        if (back) back.addEventListener("click", function () {
            setSettingsOpen(false);
            if (typeof toggle.focus === "function") toggle.focus();
        });
        root.document.addEventListener("keydown", function (event) {
            if ((event.key === "Escape" || event.key === "Esc") && !popover.hidden) {
                setSettingsOpen(false);
                if (typeof toggle.focus === "function") toggle.focus();
            }
        });
    }

    root.openProofreadingSettings = function () { return setSettingsOpen(true); };

    function normalizeIssue(issue, index) {
        var value = issue || {};
        return {
            id: String(value.id == null ? index + 1 : value.id),
            runId: value.runId == null ? null : value.runId,
            category: String(value.category || ""),
            categoryLabel: String(value.categoryLabel || value.title || value.category || "校对提示"),
            title: String(value.title || value.category || "校对提示"),
            original: String(value.original || value.excerpt || ""),
            hasOriginal: typeof value.original === "string" && value.original.length > 0,
            reason: String(value.reason || ""),
            stateLabel: String(value.stateLabel || ""),
            confidence: typeof value.confidence === "number" ? value.confidence : null,
            message: String(value.message || value.reason || ""),
            action: String(value.action || ""),
            suggestion: typeof value.suggestion === "string"
                ? value.suggestion
                : String(value.replacement || ""),
            hasSuggestion: typeof value.suggestion === "string" || typeof value.replacement === "string",
            status: String(value.status || "pending"),
            needsReview: value.needsReview === true,
            autoFixable: value.autoFixable === true,
            actionable: value.actionable !== false,
            ruleName: String(value.ruleName || ""),
            ruleSource: String(value.ruleSource || ""),
            ruleType: String(value.ruleType || ""),
            ruleSaved: value.ruleSaved === true,
            severity: String(value.severity || ""),
            origin: String(value.origin || "ai"),
            confirmedByAI: value.confirmedByAI === true,
            aiConflict: value.aiConflict === true,
            reviewRuleId: String(value.reviewRuleId || "")
        };
    }

    function pendingCount() {
        return state.issues.filter(function (issue) {
            return issue.status === "pending";
        }).length;
    }

    function reviewPendingCount() {
        return state.issues.filter(function (issue) {
            return issue.status === "pending" && issue.needsReview === true;
        }).length;
    }

    function processedCount() {
        return state.issues.filter(function (issue) {
            return issue.status === "accepted" || issue.status === "ignored";
        }).length;
    }

    function staleCount() {
        return state.issues.filter(function (issue) {
            return issue.status === "stale";
        }).length;
    }

    function isAutoFixable(issue) {
        return issue && issue.status === "pending" &&
            issue.autoFixable === true &&
            issue.actionable !== false &&
            issue.needsReview !== true &&
            typeof issue.confidence === "number" &&
            issue.confidence >= 0.9;
    }

    function autoFixableCount() {
        return state.issues.filter(isAutoFixable).length;
    }

    function updateCount() {
        var count = byId("result-count");
        var pending = pendingCount();
        var review = reviewPendingCount();
        var processed = processedCount();
        var stale = staleCount();
        var autoFixable = autoFixableCount();
        if (count) { count.textContent = String(pending); count.hidden = pending === 0; }
        updatePanelLayout();
        var summary = byId("result-summary");
        if (summary) {
            summary.textContent = "";
            function summaryPart(text, className) {
                var part = root.document.createElement("span");
                part.className = className;
                part.textContent = text;
                summary.appendChild(part);
            }
            var parts = [[pending, "待处理", "summary-pending"],
                [review, "需复核", "summary-review"], [processed, "已处理", "summary-processed"],
                [stale, "需重查", "summary-stale"]];
            var added = false;
            parts.forEach(function (part) {
                if (!part[0]) return;
                if (added) summaryPart(" · ", "summary-separator");
                summaryPart(part[1] + " " + part[0], part[2]);
                added = true;
            });
        }
        var staleSummary = byId("result-stale-summary");
        if (staleSummary) {
            staleSummary.textContent = "需重查 " + stale;
            staleSummary.hidden = true;
        }
        var applyAllButton = byId("apply-all");
        if (applyAllButton) {
            applyAllButton.textContent = "一键修正（" + autoFixable + "）";
            applyAllButton.disabled = issueWriteLocked() || state.actionBusy || autoFixable === 0;
            applyAllButton.title = issueWriteLocked() ? "校对完成后可修改正文" :
                pendingCount() > autoFixableCount()
                    ? "仅自动修正内置低风险标点格式规则" : "";
        }
    }

    function collectHistory() {
        state.issues.forEach(function (issue) {
            if (issue.status !== "accepted" && issue.status !== "ignored") return;
            var action = issue.status === "accepted" ? "applied" : "ignored";
            var key = (issue.runId == null ? "" : issue.runId) + "|" + issue.id + "|" + action;
            if (state.historyIds[key]) return;
            state.historyIds[key] = true;
            state.history.unshift({
                id: issue.id,
                runId: issue.runId,
                action: action,
                categoryLabel: issue.categoryLabel,
                original: issue.original,
                suggestion: issue.suggestion,
                reason: issue.reason,
                time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
            });
        });
    }

    function renderHistory() {
        var list = byId("proofreading-history");
        var empty = byId("history-empty");
        if (!list) return;
        list.textContent = "";
        if (!state.history.length) {
            list.hidden = true;
            if (empty) empty.hidden = false;
            return;
        }
        state.history.forEach(function (record) {
            var card = root.document.createElement("article");
            card.className = "history-card";

            var head = root.document.createElement("div");
            head.className = "history-head";
            var action = root.document.createElement("span");
            action.className = "history-action " + (record.action === "applied" ? "history-applied" : "history-ignored");
            action.textContent = record.action === "applied" ? "已修正" :
                record.action === "undone" ? "已撤销" : "已忽略";
            var meta = root.document.createElement("span");
            meta.className = "history-meta";
            meta.textContent = record.categoryLabel + " · " + record.time;
            head.appendChild(action);
            head.appendChild(meta);
            card.appendChild(head);

            var diff = root.document.createElement("p");
            diff.className = "history-diff";
            var old = root.document.createElement("span");
            old.className = "diff-old";
            old.textContent = record.action === "undone"
                ? (record.suggestion === "" ? "已删除" : record.suggestion)
                : record.original;
            diff.appendChild(old);
            if (record.action === "applied" || record.action === "undone") {
                var arrow = root.document.createElement("span");
                arrow.className = "diff-arrow";
                arrow.textContent = " → ";
                diff.appendChild(arrow);
                var fresh = root.document.createElement("span");
                fresh.className = "diff-new";
                fresh.textContent = record.action === "undone"
                    ? (record.original === "" ? "删除" : record.original)
                    : (record.suggestion === "" ? "删除" : record.suggestion);
                diff.appendChild(fresh);
            }
            card.appendChild(diff);
            list.appendChild(card);
        });
        list.hidden = false;
        if (empty) empty.hidden = true;
    }

    function switchTab(name) {
        state.tab = name === "history" ? "history" : "issues";
        var issuesTab = byId("tab-issues");
        var historyTab = byId("tab-history");
        var issuesPanel = byId("proofreading-issues");
        var historyPanel = byId("proofreading-history");
        var emptyState = byId("empty-state");
        var historyEmpty = byId("history-empty");
        var filter = byId("issue-filter");
        var showIssues = state.tab === "issues";

        if (issuesTab) {
            issuesTab.classList.toggle("is-active", showIssues);
            issuesTab.setAttribute("aria-selected", showIssues ? "true" : "false");
        }
        if (historyTab) {
            historyTab.classList.toggle("is-active", !showIssues);
            historyTab.setAttribute("aria-selected", showIssues ? "false" : "true");
        }
        if (issuesPanel) issuesPanel.hidden = !showIssues || !state.issues.length;
        if (emptyState) emptyState.hidden = !showIssues || state.issues.length > 0;
        if (historyPanel) historyPanel.hidden = showIssues || !state.history.length;
        if (historyEmpty) historyEmpty.hidden = showIssues || state.history.length > 0;
        if (filter) filter.disabled = !showIssues;
        if (showIssues) renderIssues();
        else renderHistory();
        updatePanelLayout();
    }

    function clearIssues() {
        state.issues = [];
        state.activeIssueId = "";
        issueCardCache = Object.create(null);
        processedIssuesDetails = null;
        processedIssuesSummary = null;
        processedIssuesList = null;
        renderedIssueActionButtons = [];
        updateCount();
        var list = byId("proofreading-issues");
        var emptyState = byId("empty-state");
        if (list) {
            list.textContent = "";
            list.hidden = true;
        }
        if (emptyState) {
            emptyState.textContent = "校对结果会显示在这里。";
            emptyState.hidden = false;
        }
    }

    function beginProofreadingRun() {
        state.runFinished = false;
        state.firstPassComplete = false;
        state.emptyMessage = "校对结果会显示在这里。";
        state.filter = "all";
        var filter = byId("issue-filter");
        if (filter) filter.value = "all";
        clearIssues();
        switchTab("issues");
        return true;
    }

    function captureProofreadingView() {
        var list = byId("proofreading-issues");
        var expanded = Object.create(null);
        Array.prototype.forEach.call(list && list.querySelectorAll
            ? list.querySelectorAll(".issue-card[data-issue-id]") : [], function (card) {
            var analysis = card.querySelector && card.querySelector(".issue-analysis");
            if (analysis && analysis.open) expanded[card.getAttribute("data-issue-id")] = true;
        });
        var processed = list && list.querySelector && list.querySelector(".processed-issues");
        return {
            issues: state.issues.slice(), history: state.history.slice(),
            historyIds: Object.assign({}, state.historyIds), filter: state.filter,
            activeIssueId: state.activeIssueId, runFinished: state.runFinished,
            tab: state.tab, emptyMessage: state.emptyMessage,
            scrollTop: list ? list.scrollTop : 0, expanded: expanded,
            processedOpen: !!(processed && processed.open)
        };
    }

    function restoreProofreadingView(view) {
        var saved = view || {};
        state.issues = saved.issues || [];
        state.activeIssueId = saved.activeIssueId || "";
        state.runFinished = saved.runFinished === true;
        issueCardCache = Object.create(null);
        processedIssuesDetails = null;
        processedIssuesSummary = null;
        processedIssuesList = null;
        state.history = saved.history || [];
        state.historyIds = saved.historyIds || {};
        state.filter = saved.filter || "all";
        state.emptyMessage = saved.emptyMessage || "当前文档尚未校对";
        var filter = byId("issue-filter");
        if (filter) filter.value = state.filter;
        var list = byId("proofreading-issues");
        if (list) list.textContent = "";
        if (locateToastTimer !== null && root.clearTimeout) root.clearTimeout(locateToastTimer);
        locateToastTimer = null;
        var toast = byId("proofreading-toast");
        if (toast) toast.hidden = true;
        activeIssueMenu = null;
        renderedIssueActionButtons = [];
        switchTab("issues");
        // Expanded cards and scroll belong to this document, not the previous DOM.
        Array.prototype.forEach.call(list && list.querySelectorAll
            ? list.querySelectorAll(".issue-card[data-issue-id]") : [], function (card) {
            var analysis = card.querySelector && card.querySelector(".issue-analysis");
            if (analysis) analysis.open = !!(saved.expanded && saved.expanded[card.getAttribute("data-issue-id")]);
        });
        var processed = list && list.querySelector && list.querySelector(".processed-issues");
        if (processed) processed.open = saved.processedOpen === true;
        if (list) list.scrollTop = saved.scrollTop || 0;
        renderHistory();
        switchTab(saved.tab || "issues");
    }

    function issueContextAvailable(issue) {
        return typeof root.canUseProofreadingIssue !== "function" ||
            root.canUseProofreadingIssue(issue.id, issue.runId);
    }

    function callAction(name, issueId, fallbackMessage) {
        var callback = root[name];
        if (typeof callback !== "function") {
            setProofreadingStatus(fallbackMessage, "warning");
            return false;
        }
        try {
            var result = callback(issueId);
            if (name === "ignoreProofreadingIssue") {
                if (result && typeof result.then === "function") {
                    result = result.then(function (value) { return advanceAfterIgnore(issueId, value); });
                } else { advanceAfterIgnore(issueId, result); }
            }
            if (result && typeof result.then === "function") {
                return result.catch(function () {
                    setProofreadingStatus(fallbackMessage, "error");
                    return false;
                });
            }
            return result;
        } catch (error) {
            setProofreadingStatus(fallbackMessage, "error");
            return false;
        }
    }

    function actionButton(label, className, issue, callbackName, disabled) {
        var button = root.document.createElement("button");
        button.type = "button";
        button.className = "issue-action " + className;
        button.textContent = label;
        button._proofreadingActionDisabled = disabled === true;
        button._proofreadingWriteAction = callbackName === "applyProofreadingIssue" ||
            callbackName === "undoProofreadingIssue";
        button.disabled = state.actionBusy || button._proofreadingActionDisabled ||
            (issueWriteLocked() && button._proofreadingWriteAction);
        if (button._proofreadingWriteAction && issueWriteLocked()) button.title = "校对完成后可修改正文";
        renderedIssueActionButtons.push(button);
        button.setAttribute("data-issue-id", issue.id);
        if (!button._proofreadingActionDisabled) {
            button.addEventListener("click", function (event) {
                if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                if (state.actionBusy || (button._proofreadingWriteAction && issueWriteLocked())) return;
                callAction(callbackName, issue.id, "当前操作未能完成。");
            });
        }
        return button;
    }

    function canSaveIssueAsRule(issue) {
        if (!issue || !issue.hasOriginal || !issue.hasSuggestion ||
            issue.original === issue.suggestion || issue.actionable === false ||
            (issue.status !== "pending" && issue.status !== "accepted") || issue.ruleSaved) return false;
        if (issue.origin === "rule") return false;
        if (issue.origin === "rule+ai" && issue.ruleType === "replace") return false;
        return true;
    }

    function saveRuleButton(issue, disabled) {
        var button = root.document.createElement("button");
        button.type = "button";
        button.className = "issue-action issue-action-secondary";
        button.textContent = issue.ruleSaved ? "已保存规则" : "保存为规则";
        button._proofreadingActionDisabled = disabled === true || issue.ruleSaved === true;
        button._proofreadingRuleAction = true;
        button.disabled = state.actionBusy || state.busy || button._proofreadingActionDisabled;
        button.setAttribute("data-issue-id", issue.id);
        renderedIssueActionButtons.push(button);
        if (!button._proofreadingActionDisabled) {
            button.addEventListener("click", function (event) {
                if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                if (state.actionBusy) return;
                if (!issueContextAvailable(issue)) {
                    setProofreadingStatus("请切回原文档或在当前文档重新校对。", "warning");
                    return;
                }
                if (state.busy) return;
                if (typeof root.openIssueRuleDraft !== "function") {
                    setProofreadingStatus("规则中心尚未就绪。", "warning");
                    return;
                }
                root.openIssueRuleDraft(issue);
            });
        }
        return button;
    }

    function invalidateModelConnection() {
        if (typeof root.invalidateModelConnection === "function") root.invalidateModelConnection();
        else setModelConnectionStatus("配置已更改，需重新检测", "idle");
    }

    function appendChangedText(parent, oldText, newText) {
        var oldChars = Array.from(oldText);
        var newChars = Array.from(newText);
        var prefix = 0;
        while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) prefix++;
        var suffix = 0;
        while (suffix < oldChars.length - prefix && suffix < newChars.length - prefix &&
            oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]) suffix++;
        function add(tag, className, text) {
            if (!text) return;
            var node = root.document.createElement(tag);
            node.className = className;
            node.textContent = text;
            parent.appendChild(node);
        }
        if (prefix === oldChars.length && prefix === newChars.length) {
            add("span", "issue-identical-text", oldText);
            add("span", "issue-identical-note", "建议文本与原文一致，请人工核对。");
            return;
        }
        add("span", "diff-common", oldChars.slice(0, prefix).join(""));
        add("del", "diff-old", oldChars.slice(prefix, oldChars.length - suffix).join(""));
        add("ins", "diff-new", newChars.slice(prefix, newChars.length - suffix).join(""));
        add("span", "diff-common", suffix ? oldChars.slice(oldChars.length - suffix).join("") : "");
    }

    function appendIssueMenu(actions, issue, disabled) {
        var more = root.document.createElement("div");
        more.className = "issue-more";
        var toggle = root.document.createElement("button");
        toggle.type = "button";
        toggle.className = "issue-more-toggle";
        toggle.textContent = "⋯";
        toggle._proofreadingActionDisabled = disabled === true;
        toggle.disabled = state.actionBusy || toggle._proofreadingActionDisabled;
        renderedIssueActionButtons.push(toggle);
        toggle.setAttribute("aria-label", "更多操作");
        toggle.setAttribute("aria-expanded", "false");
        toggle.addEventListener("click", function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            menu.hidden = !menu.hidden;
            toggle.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
        });
        var menu = root.document.createElement("div");
        menu.className = "issue-menu";
        menu.hidden = true;
        more.addEventListener("click", function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
        });
        var save = root.document.createElement("button");
        save.type = "button";
        save.textContent = issue.ruleSaved ? "已保存规则" : "保存为规则";
        save._proofreadingActionDisabled = disabled === true || !canSaveIssueAsRule(issue) || issue.ruleSaved === true;
        save._proofreadingRuleAction = true;
        save.disabled = state.actionBusy || state.busy || save._proofreadingActionDisabled;
        save.setAttribute("data-issue-id", issue.id);
        renderedIssueActionButtons.push(save);
        if (!save._proofreadingActionDisabled) save.addEventListener("click", function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            if (state.actionBusy) return;
            if (!issueContextAvailable(issue)) {
                setProofreadingStatus("请切回原文档或在当前文档重新校对。", "warning");
                return;
            }
            if (state.busy) return;
            if (typeof root.openIssueRuleDraft !== "function") {
                setProofreadingStatus("规则中心尚未就绪。", "warning");
                return;
            }
            root.openIssueRuleDraft(issue);
        });
        save.className = "issue-menu-item";
        menu.appendChild(save);
        more.appendChild(toggle);
        more.appendChild(menu);
        actions.appendChild(more);
        if (!issueMenuDismissBound && root.document && root.document.addEventListener) {
            issueMenuDismissBound = true;
            root.document.addEventListener("click", function () {
                if (!activeIssueMenu) return;
                activeIssueMenu.menu.hidden = true;
                activeIssueMenu.toggle.setAttribute("aria-expanded", "false");
                activeIssueMenu = null;
            });
            root.document.addEventListener("keydown", function (event) {
                if ((event.key === "Escape" || event.key === "Esc") && activeIssueMenu) {
                    activeIssueMenu.menu.hidden = true;
                    activeIssueMenu.toggle.setAttribute("aria-expanded", "false");
                    activeIssueMenu = null;
                }
            });
        }
        toggle.addEventListener("click", function () {
            if (activeIssueMenu && activeIssueMenu.toggle !== toggle) {
                activeIssueMenu.menu.hidden = true;
                activeIssueMenu.toggle.setAttribute("aria-expanded", "false");
            }
            activeIssueMenu = menu.hidden ? null : { menu: menu, toggle: toggle };
        });
    }

    function visibleIssues() {
        if (state.filter === "all") return state.issues.slice();
        return state.issues.filter(function (issue) {
            return issue.category === state.filter;
        });
    }

    function isProcessedIssue(issue) {
        return issue.status === "accepted" || issue.status === "ignored";
    }

    function isDeleteIssue(issue) {
        return issue.actionable !== false && issue.action !== "review" &&
            issue.suggestion === "" &&
            (issue.action === "delete" || (!issue.action && issue.hasSuggestion));
    }

    function isReviewOnlyIssue(issue) {
        return issue.action === "review" || issue.actionable === false ||
            (issue.suggestion === "" && !isDeleteIssue(issue));
    }

    function reconcileChildren(parent, desiredChildren) {
        if (!parent) return;
        var children = parent.children;
        var desiredLookup = new Set(desiredChildren);
        for (var staleIndex = children.length - 1; staleIndex >= 0; staleIndex--) {
            if (!desiredLookup.has(children[staleIndex]) && parent.removeChild) {
                parent.removeChild(children[staleIndex]);
            }
        }
        children = parent.children;
        for (var index = 0; index < desiredChildren.length; index++) {
            var desired = desiredChildren[index];
            var current = children[index] || null;
            if (current === desired) continue;
            if (parent.insertBefore) parent.insertBefore(desired, current);
            else parent.appendChild(desired);
            children = parent.children;
        }
        while (children.length > desiredChildren.length) {
            if (parent.removeChild) parent.removeChild(children[children.length - 1]);
            else parent.textContent = "";
            children = parent.children;
        }
    }

    function updatePanelLayout() {
        var hasResults = state.issues.length > 0;
        // A finished run with no issues shows its result instead of the first-run guidance.
        var finishedEmpty = !hasResults && !state.busy && state.runFinished;
        var view = byId("proofreading-view");
        if (view) {
            view.setAttribute("data-has-results", hasResults ? "true" : "false");
            view.setAttribute("data-busy", state.busy ? "true" : "false");
            view.setAttribute("data-finished-empty", finishedEmpty ? "true" : "false");
        }
        var start = byId("run-proofreading");
        if (start) {
            start.hidden = hasResults || state.busy || state.tab !== "issues";
            start.textContent = finishedEmpty ? "重新校对" : "开始校对";
        }
        var rerun = byId("rerun-proofreading");
        if (rerun) rerun.hidden = !hasResults || state.busy;
    }

    // Only expands the card; the document cursor is moved by the integration layer.
    function setActiveIssue(id) {
        state.activeIssueId = String(id || "");
        Object.keys(issueCardCache).forEach(function (key) {
            var card = issueCardCache[key].card;
            card.setAttribute("aria-expanded", key === state.activeIssueId ? "true" : "false");
            var analysis = card.querySelector && card.querySelector(".issue-analysis");
            if (analysis) analysis.open = key === state.activeIssueId;
        });
        return state.activeIssueId;
    }

    function selectIssue(issue) {
        if (state.actionBusy) return;
        setActiveIssue(issue.id);
        // Processed cards have no live range; locating them only produces a "stale" warning.
        if (issue.status === "pending") callAction("locateProofreadingIssue", issue.id, "当前操作未能完成。");
    }

    // Apply already auto-advances inside the integration; ignore does not, so follow up here.
    function advanceAfterIgnore(id, result) {
        if (result === false || (result && result.ok === false)) return result;
        var settings = loadStoredSettings();
        if (!settings || settings.autoAdvance === false) return result;
        var shown = visibleIssues();
        var index = -1;
        shown.forEach(function (issue, i) { if (issue.id === id) index = i; });
        var next = null;
        for (var step = 1; step <= shown.length; step += 1) {
            var candidate = shown[(index + step) % shown.length];
            if (candidate && candidate.id !== id && candidate.status === "pending") { next = candidate; break; }
        }
        if (next) selectIssue(next);
        else setActiveIssue("");
        return result;
    }

    function createIssueCard(issue, expanded) {
        var pending = issue.status === "pending";
        var reviewOnly = isReviewOnlyIssue(issue);
        var deleteIssue = isDeleteIssue(issue);
        var card = root.document.createElement("article");
        card.setAttribute("data-issue-id", issue.id);
        card.className = "issue-card" + ((issue.needsReview || reviewOnly) ? " is-review" : "") + (pending && !state.busy ? " is-locatable" : "");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-label", issue.ruleName || issue.categoryLabel);
        card.setAttribute("aria-expanded", state.activeIssueId === issue.id ? "true" : "false");
        card.addEventListener("keydown", function (event) {
            if (event.target && event.target !== card) return;
            if (event.key === "Enter" || event.key === " ") {
                if (event.preventDefault) event.preventDefault();
                selectIssue(issue);
            }
        });
        if (pending || isProcessedIssue(issue)) {
            card.addEventListener("click", function () {
                if (state.actionBusy) return;
                selectIssue(issue);
            });
        }


        var header = root.document.createElement("div");
        header.className = "issue-card-header";

        var title = root.document.createElement("strong");
        title.className = "issue-title";
        title.textContent = issue.ruleName || issue.categoryLabel || "校对建议";
        header.appendChild(title);

        var badges = root.document.createElement("div");
        badges.className = "issue-badges";
        if (issue.origin === "rule+ai") {
            var sourceBadge = root.document.createElement("span");
            sourceBadge.className = issue.aiConflict ? "badge-conflict" : "badge-source";
            sourceBadge.textContent = issue.aiConflict ? "规则与 AI 意见不同" : "规则 + AI";
            if (issue.ruleSource) sourceBadge.title = "来源：" + issue.ruleSource;
            badges.appendChild(sourceBadge);
        } else if (issue.origin === "ai-review") {
            var reviewBadge = root.document.createElement("span");
            reviewBadge.className = "badge-source";
            reviewBadge.textContent = "AI";
            if (issue.ruleSource) reviewBadge.title = "来源：" + issue.ruleSource;
            badges.appendChild(reviewBadge);
        } else if (issue.origin === "rule") {
            var ruleBadge = root.document.createElement("span");
            ruleBadge.className = "badge-source";
            ruleBadge.textContent = "本地规则";
            if (issue.ruleSource) ruleBadge.title = "来源：" + issue.ruleSource;
            badges.appendChild(ruleBadge);
        } else if (issue.origin === "ai") {
            var aiBadge = root.document.createElement("span");
            aiBadge.className = "badge-source";
            aiBadge.textContent = "AI";
            badges.appendChild(aiBadge);
        }
        if (issue.needsReview || reviewOnly) {
            var deepBadge = root.document.createElement("span");
            deepBadge.className = "badge-deep";
            deepBadge.textContent = "需复核";
            badges.appendChild(deepBadge);
        }
        if (badges.children.length) header.appendChild(badges);

        var actions = root.document.createElement("div");
        actions.className = "issue-actions";
        if (!pending || !reviewOnly) {
            actions.appendChild(actionButton(
                issue.status === "accepted" ? "撤销" :
                    issue.status === "ignored" ? "已忽略" :
                        issue.status === "stale" ? "需重查" : issue.needsReview ? "确认修正" : "修正",
                issue.needsReview ? "issue-action-review issue-action-secondary" : "issue-action-primary",
                issue,
                issue.status === "accepted" ? "undoProofreadingIssue" : "applyProofreadingIssue",
                (!pending && issue.status !== "accepted") ||
                    (pending && issue.actionable === false)
            ));
        }
        actions.appendChild(actionButton("忽略", "issue-action-secondary button-text", issue, "ignoreProofreadingIssue", !pending));
        if (canSaveIssueAsRule(issue) || issue.ruleSaved) {
            appendIssueMenu(actions, issue, (!pending && issue.status !== "accepted"));
        }
        card.appendChild(header);

        var mainRow = root.document.createElement("div");
        mainRow.className = "issue-main";

        if (issue.original || issue.suggestion) {
            var diff = root.document.createElement("p");
            diff.className = "issue-diff";
            if (issue.original === issue.suggestion) {
                appendChangedText(diff, issue.original, issue.suggestion);
            } else if (reviewOnly) {
                var reviewLabel = root.document.createElement("span");
                reviewLabel.className = "issue-review-label";
                reviewLabel.textContent = "需核对";
                diff.appendChild(reviewLabel);
                var reviewText = root.document.createElement("span");
                reviewText.className = "issue-review-text";
                reviewText.textContent = issue.original || issue.suggestion;
                diff.appendChild(reviewText);
            } else {
                appendChangedText(diff, issue.original, deleteIssue ? "" : issue.suggestion);
                if (deleteIssue) {
                    var deleteLabel = root.document.createElement("span");
                    deleteLabel.className = "diff-delete-note";
                    deleteLabel.textContent = "（建议删除）";
                    diff.appendChild(deleteLabel);
                }
            }
            if (!reviewOnly && issue.original !== issue.suggestion) {
                diff.hidden = !Array.prototype.some.call(diff.children, function (part) {
                    return part.className === "diff-common" && part.textContent.length > 0;
                });
            }
            mainRow.appendChild(diff);
        }
        var preview = root.document.createElement("p");
        preview.className = "issue-preview";
        if (reviewOnly || issue.original === issue.suggestion) {
            preview.textContent = issue.original || issue.suggestion;
        } else {
            var oldPreview = root.document.createElement("span");
            oldPreview.className = "preview-old";
            oldPreview.textContent = issue.original;
            var arrow = root.document.createElement("span");
            arrow.className = "preview-arrow";
            arrow.textContent = " → ";
            var newPreview = root.document.createElement("span");
            newPreview.className = "preview-new";
            newPreview.textContent = deleteIssue ? "（删除）" : issue.suggestion;
            preview.appendChild(oldPreview); preview.appendChild(arrow); preview.appendChild(newPreview);
        }
        if (/^[，。；：、！？,.!?:;]+$/.test(issue.original + issue.suggestion)) preview.className += " is-punctuation";
        mainRow.appendChild(preview);
        mainRow.appendChild(actions);
        card.appendChild(mainRow);

        if (issue.reason) {
            var analysis = root.document.createElement("details");
            analysis.className = "issue-analysis";
            analysis.open = expanded[issue.id] === true || state.activeIssueId === issue.id;
            analysis.addEventListener("click", function (event) {
                if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            });
            var summary = root.document.createElement("summary");
            summary.textContent = "错误分析";
            analysis.appendChild(summary);
            var quote = root.document.createElement("blockquote");
            quote.textContent = issue.reason;
            analysis.appendChild(quote);
            card.appendChild(analysis);
        }

        var stateText = issue.status === "pending"
                ? ""
            : issue.status === "stale" ? "需重查" : issue.status === "accepted" ? "已修正" :
                issue.status === "ignored" ? "已忽略" : issue.status;
        if (stateText) {
            var stateChip = root.document.createElement("span");
            stateChip.className = "issue-status" + ((issue.needsReview || reviewOnly) ? " is-review" : "");
            stateChip.textContent = stateText;
            header.appendChild(stateChip);
        }
        if (issue.ruleSaved) {
            var savedLine = root.document.createElement("p");
            savedLine.className = "issue-state rule-saved-feedback";
            savedLine.textContent = "已保存为固定替换规则，下次校对时生效。";
            card.appendChild(savedLine);
        }        card.appendChild(actions);
        return card;

    }

    function renderIssues(issues) {
        if (Array.isArray(issues)) {
            var previousById = Object.create(null);
            state.issues.forEach(function (candidate) { previousById[candidate.id] = candidate; });
            state.issues = issues.map(function (issue, index) {
                var normalized = normalizeIssue(issue, index);
                var prior = previousById[normalized.id];
                if (prior && prior.original === normalized.original &&
                    prior.suggestion === normalized.suggestion && prior.ruleSaved) normalized.ruleSaved = true;
                return normalized;
            });
        }
        collectHistory();
        updateCount();
        var list = byId("proofreading-issues");
        var emptyState = byId("empty-state");
        if (!list) return state.issues.slice();

        if (state.tab !== "issues") {
            renderHistory();
            return state.issues.slice();
        }

        var shown = visibleIssues();
        var visibleIds = Object.create(null);
        state.issues.forEach(function (issue) { visibleIds[issue.id] = true; });
        Object.keys(issueCardCache).forEach(function (id) {
            if (!visibleIds[id]) delete issueCardCache[id];
        });
        var previousScrollTop = list.scrollTop;
        var expanded = Object.create(null);
        var processedWasOpen = !!(list.querySelector &&
            list.querySelector(".processed-issues") && list.querySelector(".processed-issues").open);
        Array.prototype.forEach.call(list.querySelectorAll ? list.querySelectorAll(".issue-card[data-issue-id]") : [], function (card) {
            var analysis = card.querySelector && card.querySelector(".issue-analysis");
            if (analysis && analysis.open) expanded[card.getAttribute("data-issue-id")] = true;
        });
        renderedIssueActionButtons = [];
        if (!shown.length) {
            if (activeIssueMenu) {
                activeIssueMenu.menu.hidden = true;
                activeIssueMenu.toggle.setAttribute("aria-expanded", "false");
                activeIssueMenu = null;
            }
            reconcileChildren(list, []);
            if (processedIssuesList) reconcileChildren(processedIssuesList, []);
            list.hidden = true;
            if (emptyState) {
                emptyState.textContent = state.issues.length
                    ? "当前筛选类型没有问题。"
                    : state.runFinished ? state.status.text : state.emptyMessage;
                emptyState.hidden = false;
            }
            return state.issues.slice();
        }

        var processed = shown.filter(isProcessedIssue);
        if (processed.length && !processedIssuesDetails) {
            processedIssuesDetails = root.document.createElement("details");
            processedIssuesDetails.className = "processed-issues";
            processedIssuesDetails.open = processedWasOpen;
            processedIssuesSummary = root.document.createElement("summary");
            processedIssuesSummary.textContent = "已处理（" + processed.length + "）";
            processedIssuesDetails.appendChild(processedIssuesSummary);
            processedIssuesList = root.document.createElement("div");
            processedIssuesList.className = "processed-issues-list";
            processedIssuesDetails.appendChild(processedIssuesList);
        }
        if (processed.length && processedIssuesDetails) {
            processedIssuesDetails.open = processedWasOpen || processedIssuesDetails.open;
            processedIssuesSummary.textContent = "已处理（" + processed.length + "）";
        }

        var pendingCards = [];
        var processedCards = [];
        var nextActionButtons = [];
        shown.forEach(function (issue) {
            var signature = JSON.stringify(issue);
            var cached = issueCardCache[issue.id];
            var card;
            if (cached && cached.signature === signature) {
                card = cached.card;
                cached.buttons.forEach(function (button) { nextActionButtons.push(button); });
            } else {
                renderedIssueActionButtons = nextActionButtons;
                var buttonStart = renderedIssueActionButtons.length;
                card = createIssueCard(issue, expanded);
                issueCardCache[issue.id] = { signature: signature, card: card,
                    buttons: renderedIssueActionButtons.slice(buttonStart) };
                nextActionButtons = renderedIssueActionButtons;
            }
            var pendingCard = issue.status === "pending";
            var reviewCard = isReviewOnlyIssue(issue);
            card.className = "issue-card" + ((issue.needsReview || reviewCard) ? " is-review" : "") +
                (pendingCard ? " is-locatable" : "");
            card.setAttribute("aria-expanded", state.activeIssueId === issue.id ? "true" : "false");
            (isProcessedIssue(issue) ? processedCards : pendingCards).push(card);
        });

        renderedIssueActionButtons = nextActionButtons;
        if (activeIssueMenu && renderedIssueActionButtons.indexOf(activeIssueMenu.toggle) < 0) {
            activeIssueMenu.menu.hidden = true;
            activeIssueMenu.toggle.setAttribute("aria-expanded", "false");
            activeIssueMenu = null;
        }
        if (processed.length && processedIssuesList) reconcileChildren(processedIssuesList, processedCards);
        else if (processedIssuesList) reconcileChildren(processedIssuesList, []);
        var desiredListChildren = pendingCards.slice();
        if (processed.length && processedIssuesDetails) desiredListChildren.push(processedIssuesDetails);
        reconcileChildren(list, desiredListChildren);

        list.hidden = false;
        list.scrollTop = previousScrollTop;
        if (emptyState) emptyState.hidden = true;
        return state.issues.slice();
    }

    function defaultRunProofreading() {
        var selected = readSelectedText();
        setProofreadingStatus("校对接口尚未就绪。", "warning");
        return { accepted: false, reason: "integration-not-bound", text: selected };
    }

    function defaultIssueAction() {
        setProofreadingStatus("校对操作尚未就绪。", "warning");
        return { accepted: false, reason: "integration-not-bound" };
    }

    function callRunProofreading(restart) {
        var callback = typeof root.runProofreading === "function"
            ? root.runProofreading
            : defaultRunProofreading;
        try {
            var result = callback(restart === true);
            if (result && typeof result.then === "function") {
                result.catch(function (error) {
                    setProofreadingStatus(error && error.message ? error.message : "校对失败", "error");
                });
            }
            return result;
        } catch (error) {
            setProofreadingStatus(error && error.message ? error.message : "校对失败", "error");
            return { accepted: false, reason: "callback-error" };
        }
    }

    function callSimple(name, fallbackMessage) {
        var callback = root[name];
        if (typeof callback !== "function") {
            setProofreadingStatus(fallbackMessage, "warning");
            return false;
        }
        try {
            var result = callback();
            if (result && typeof result.then === "function") {
                result.catch(function (error) {
                    setProofreadingStatus(error && error.message ? error.message : fallbackMessage, "error");
                });
            }
            return result;
        } catch (error) {
            setProofreadingStatus(error && error.message ? error.message : fallbackMessage, "error");
            return false;
        }
    }

    function setAppMode(mode) {
        if ((state.busy || state.actionBusy || state.rewriteBusy) &&
            (mode === "rewrite" ? "rewrite" : "proofread") !== state.appMode) return state.appMode;
        var rewriteMode = mode === "rewrite";
        state.appMode = rewriteMode ? "rewrite" : "proofread";
        var proofreadingView = byId("proofreading-view");
        var rewriteView = byId("rewrite-view");
        var proofreadingTab = byId("mode-proofread");
        var rewriteTab = byId("mode-rewrite");
        var deepControl = byId("deep-enhance-control");
        if (proofreadingView) proofreadingView.hidden = rewriteMode;
        if (rewriteView) rewriteView.hidden = !rewriteMode;
        var settings = loadStoredSettings();
        if (deepControl) deepControl.hidden = rewriteMode || !!(settings && settings.rulesOnly === true);
        if (typeof root.getModelConnectionState === "function") {
            var connection = root.getModelConnectionState();
            setModelConnectionStatus(connection.text, connection.tone);
        }
        if (proofreadingTab) {
            proofreadingTab.classList.toggle("is-active", !rewriteMode);
            proofreadingTab.setAttribute("aria-selected", rewriteMode ? "false" : "true");
        }
        if (rewriteTab) {
            rewriteTab.classList.toggle("is-active", rewriteMode);
            rewriteTab.setAttribute("aria-selected", rewriteMode ? "true" : "false");
        }
        if (rewriteMode && typeof root.refreshRewriteSelection === "function") {
            root.refreshRewriteSelection();
        }
        return state.appMode;
    }

    function pushProofreadingRecord(record) {
        var value = record || {};
        var id = String(value.id == null ? "" : value.id);
        var action = value.action === "ignored" ? "ignored" :
            value.action === "undone" ? "undone" : "applied";
        var baseKey = (value.runId == null ? "" : value.runId) + "|" + id + "|" + action;
        var key = value.operationId == null ? baseKey : baseKey + "|" + value.operationId;
        if (!id || state.historyIds[key]) return false;
        state.historyIds[key] = true;
        state.historyIds[baseKey] = true;
        state.history.unshift({
            id: id,
            runId: value.runId == null ? null : value.runId,
            action: action,
            categoryLabel: String(value.categoryLabel || value.category || "校对提示"),
            original: String(value.original || ""),
            suggestion: String(value.suggestion || ""),
            reason: String(value.reason || ""),
            time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        });
        renderHistory();
        return true;
    }

    root.setProofreadingStatus = root.setProofreadingStatus || setProofreadingStatus;
    root.pushProofreadingRecord = root.pushProofreadingRecord || pushProofreadingRecord;
    root.setModelConnectionStatus = root.setModelConnectionStatus || setModelConnectionStatus;
    root.setProofreadingBusy = root.setProofreadingBusy || setProofreadingBusy;
    root.setProofreadingFirstPassComplete = setProofreadingFirstPassComplete;
    root.setProofreadingActionBusy = root.setProofreadingActionBusy || setProofreadingActionBusy;
    root.setRewriteBusy = setRewriteBusy;
    root.getTaskBusyState = taskBusyState;
    root.requestFullDocumentConfirmation = root.requestFullDocumentConfirmation || requestFullDocumentConfirmation;
    root.dismissFullDocumentConfirmation = root.dismissFullDocumentConfirmation || dismissFullDocumentConfirmation;
    root.setProofreadingProgress = root.setProofreadingProgress || setProofreadingProgress;
    root.syncSettingsForm = syncFormFromStore;
    root.setAppMode = setAppMode;
    root.getAppMode = function () { return state.appMode; };
    root.getProofreadingStatus = root.getProofreadingStatus || getProofreadingStatus;
    root.setProofreadingIssues = root.setProofreadingIssues || renderIssues;
    root.setActiveProofreadingIssue = setActiveIssue;
    root.markProofreadingIssueRuleSaved = function (issueId) {
        var issue = state.issues.find(function (candidate) { return candidate.id === String(issueId); });
        if (!issue) return false;
        issue.ruleSaved = true;
        renderIssues();
        return true;
    };
    root.clearProofreadingIssues = root.clearProofreadingIssues || clearIssues;
    root.beginProofreadingRun = root.beginProofreadingRun || beginProofreadingRun;
    root.captureProofreadingView = captureProofreadingView;
    root.restoreProofreadingView = restoreProofreadingView;
    root.refreshProofreadingSelection = root.refreshProofreadingSelection || refreshProofreadingSelection;
    root.readSelectedText = root.readSelectedText || readSelectedText;
    root.replaceSelectedText = root.replaceSelectedText || function (value) {
        return root.WpsNativeDocument && root.WpsNativeDocument.replaceSelectionText
            ? root.WpsNativeDocument.replaceSelectionText(value)
            : false;
    };
    root.runProofreading = root.runProofreading || defaultRunProofreading;
    root.applyProofreadingIssue = root.applyProofreadingIssue || defaultIssueAction;
    root.undoProofreadingIssue = root.undoProofreadingIssue || defaultIssueAction;
    root.locateProofreadingIssue = root.locateProofreadingIssue || defaultIssueAction;
    root.ignoreProofreadingIssue = root.ignoreProofreadingIssue || defaultIssueAction;

    function store() {
        return root.WpsSettingsStore || null;
    }

    function loadStoredSettings() {
        var api = store();
        if (!api || typeof api.loadSettings !== "function") return null;
        return api.loadSettings() || api.defaultSettings();
    }

    function currentProvider(settings) {
        return settings && settings.profiles && settings.profiles[settings.provider]
            ? settings.provider
            : "opencode";
    }

    function applyProviderUi(provider) {
        var keyRow = byId("model-api-key-row");
        var keyLabel = byId("model-api-key-label");
        var key = byId("model-api-key");
        var endpointLabel = byId("model-endpoint-label");
        var endpoint = byId("model-endpoint");
        var modelLabel = byId("model-name-label");
        var model = byId("model-name");
        var help = byId("provider-help");
        var opencodeGuide = byId("opencode-start-guide");
        var opencodeServiceState = byId("opencode-service-state");

        if (keyRow) keyRow.hidden = provider === "ollama";
        if (opencodeGuide) opencodeGuide.hidden = provider !== "opencode";
        if (opencodeServiceState) opencodeServiceState.hidden = provider !== "opencode";
        if (provider === "ollama") {
            if (endpointLabel) endpointLabel.textContent = "Ollama 服务地址";
            if (endpoint) endpoint.placeholder = "http://127.0.0.1:11434";
            if (modelLabel) modelLabel.textContent = "Ollama 模型";
            if (model) model.placeholder = "例如 qwen3:8b";
            if (help) help.textContent = "读取 Ollama 当前已经安装的模型。";
        } else if (provider === "opencode") {
            if (endpointLabel) endpointLabel.textContent = "OpenCode 服务地址";
            if (endpoint) endpoint.placeholder = "http://127.0.0.1:4096";
            if (modelLabel) modelLabel.textContent = "OpenCode 模型";
            if (model) model.placeholder = "检测服务后选择 provider/model";
            if (keyLabel) keyLabel.textContent = "OpenCode 服务密码（可选）";
            if (key) key.placeholder = "仅在服务启用密码时填写；不会保存";
            if (help) help.textContent = "选择 OpenCode 后会自动检测、启动服务并读取模型。";
        } else {
            if (endpointLabel) endpointLabel.textContent = "Chat Completions API 地址";
            if (endpoint) endpoint.placeholder = "https://example.com/v1/chat/completions";
            if (modelLabel) modelLabel.textContent = "模型名称";
            if (model) model.placeholder = "例如 gpt-4.1-mini";
            if (keyLabel) keyLabel.textContent = "API 密钥（可选）";
            if (key) key.placeholder = "仅在本次面板会话中使用";
            if (help) help.textContent = "兼容接口需要支持 /v1/models 和 Chat Completions。";
        }
    }

    function syncModelSuggestions(settings) {
        var select = byId("model-suggestions");
        var modelField = byId("model-name");
        if (!select) return;
        var api = store();
        var catalog = api && typeof api.loadCatalog === "function" ? api.loadCatalog() : null;
        var provider = currentProvider(settings);
        var models = catalog && catalog.provider === provider && Array.isArray(catalog.models)
            ? catalog.models
            : [];
        var current = settings && settings.profiles[settings.provider]
            ? settings.profiles[settings.provider].model
            : "";

        while (select.options.length > 1) select.remove(1);
        var found = models.indexOf(current) >= 0;
        models.forEach(function (name) {
            var option = root.document.createElement("option");
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        if (current && !found) {
            var savedOption = root.document.createElement("option");
            savedOption.value = current;
            savedOption.textContent = current + "（当前配置）";
            select.appendChild(savedOption);
        }
        select.value = current || "";
        var placeholder = select.options[0];
        if (placeholder) {
            placeholder.textContent = models.length
                ? "（从 " + models.length + " 个已检测模型中选择）"
                : "（先点“检测并读取模型”）";
        }
        var detection = byId("model-detection-result");
        if (detection) {
            var hasModels = catalog && catalog.provider === provider && Array.isArray(catalog.models) && catalog.models.length;
            var connection = typeof root.getModelConnectionState === "function" ? root.getModelConnectionState() : null;
            var detected = connection && connection.provider === provider && connection.detected;
            var tone = connection ? connection.tone : "idle";
            detection.textContent = detected ? "已读取 " + connection.modelCount + " 个模型"
                : tone === "working" ? "正在读取模型…"
                    : (hasModels ? "缓存 " + models.length + " 个模型；" : "") +
                        (tone === "error" ? "本次检测失败" : tone === "warning" ? "未读取到可用模型" : "需重新检测");
            detection.className = "model-detection-result is-" + tone;
        }
        var selectRow = byId("model-select-row");
        var manualRow = byId("model-manual-row");
        var manual = byId("model-input-toggle");
        var manualMode = manual && manual.getAttribute("aria-pressed") === "true";
        if (selectRow) selectRow.hidden = manualMode;
        if (manualRow) manualRow.hidden = !manualMode;
        if (modelField && !manualMode && current) modelField.value = current;
    }

    function syncFormFromStore() {
        var settings = loadStoredSettings();
        if (!settings) return;
        var provider = currentProvider(settings);
        var api = store();
        var runtime = api && typeof api.loadRuntimeEndpoint === "function" ? api.loadRuntimeEndpoint(provider) : null;
        var profile = settings.profiles[settings.provider] || { endpoint: "", model: "" };
        var providerField = byId("model-provider");
        var endpointField = byId("model-endpoint");
        var modelField = byId("model-name");
        var keyField = byId("model-api-key");
        var deepField = byId("deep-enhance");
        var autoAdvanceField = byId("auto-advance");
        var rulesOnlyField = byId("rules-only");
        var deepControl = byId("deep-enhance-control");
        var modeHint = byId("proofreading-mode-hint");

        if (providerField && providerField.value !== provider) providerField.value = provider;
        applyProviderUi(provider);
        if (endpointField) {
            endpointField.value = runtime && runtime.provider === provider
                ? runtime.endpoint
                : profile.endpoint;
        }
        if (modelField && modelField.value !== profile.model) modelField.value = profile.model;
        if (keyField) {
            keyField.value = provider === "ollama" || !api || typeof api.loadPassword !== "function"
                ? ""
                : api.loadPassword(provider);
        }
        if (deepField) deepField.checked = settings.deep === true;
        if (autoAdvanceField) autoAdvanceField.checked = settings.autoAdvance !== false;
        var concurrencyField = byId("proofreading-concurrency");
        var timingField = byId("proofreading-timing-enabled");
        if (concurrencyField) concurrencyField.value = String(settings.concurrency || 2);
        if (timingField) timingField.checked = settings.timingLogs === true;
        if (root.WpsProofreadingTiming) root.WpsProofreadingTiming.setEnabled(settings.timingLogs === true);
        if (rulesOnlyField) rulesOnlyField.checked = settings.rulesOnly === true;
        if (deepControl) deepControl.hidden = state.appMode === "rewrite" || settings.rulesOnly === true;
        if (modeHint) modeHint.textContent = settings.rulesOnly === true
            ? "仅规则校对 · 只检查已启用的本地规则"
            : "先跑本地规则，再由模型分批复核";
        syncModelSuggestions(settings);
    }

    function refreshProofreadingTiming() {
        var content = byId("proofreading-diagnostics-content");
        if (content && content.hidden) return;
        var field = byId("proofreading-timing-log");
        var timing = root.WpsProofreadingTiming;
        if (field) field.value = JSON.stringify(timing ? timing.entries() : [], null, 2);
    }
    root.refreshProofreadingTiming = refreshProofreadingTiming;

    function bindProofreadingTiming() {
        var api = store();
        var concurrency = byId("proofreading-concurrency");
        var enabled = byId("proofreading-timing-enabled");
        var toggle = byId("proofreading-diagnostics-toggle");
        var refresh = byId("refresh-proofreading-timing");
        var copy = byId("copy-proofreading-timing");
        var clear = byId("clear-proofreading-timing");
        function status(message) {
            var element = byId("proofreading-timing-status");
            if (element) element.textContent = message;
        }
        if (concurrency) concurrency.addEventListener("change", function () {
            if (api) api.updateSettings({ concurrency: Number(concurrency.value) });
            syncFormFromStore();
        });
        if (enabled) enabled.addEventListener("change", function () {
            if (api) api.updateSettings({ timingLogs: enabled.checked === true });
            syncFormFromStore();
            status(enabled.checked ? "已开启，开始校对后记录耗时。" : "已关闭记录。");
        });
        if (toggle) toggle.addEventListener("click", function () {
            var content = byId("proofreading-diagnostics-content");
            if (!content) return;
            content.hidden = !content.hidden;
            toggle.setAttribute("aria-expanded", content.hidden ? "false" : "true");
            refreshProofreadingTiming();
        });
        if (refresh) refresh.addEventListener("click", refreshProofreadingTiming);
        if (clear) clear.addEventListener("click", function () {
            if (root.WpsProofreadingTiming) root.WpsProofreadingTiming.clear();
            refreshProofreadingTiming(); status("记录已清空。");
        });
        if (copy) copy.addEventListener("click", async function () {
            refreshProofreadingTiming();
            var field = byId("proofreading-timing-log");
            if (!field) return;
            try {
                if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
                    await root.navigator.clipboard.writeText(field.value);
                } else {
                    field.focus(); field.select();
                    if (!root.document.execCommand || !root.document.execCommand("copy")) throw new Error("copy");
                }
                status("耗时记录已复制。");
            } catch (error) {
                field.focus();
                if (typeof field.select === "function") field.select();
                status("请选中记录并手动复制。");
            }
        });
        refreshProofreadingTiming();
    }

    function bindSettingsForm() {
        bindProofreadingTiming();
        var providerField = byId("model-provider");
        var endpointField = byId("model-endpoint");
        var modelField = byId("model-name");
        var suggestionField = byId("model-suggestions");
        var keyField = byId("model-api-key");
        var deepField = byId("deep-enhance");
        var autoAdvanceField = byId("auto-advance");
        var rulesOnlyField = byId("rules-only");
        var refreshButton = byId("refresh-models");
        var manualToggle = byId("model-input-toggle");
        var opencodeRetry = byId("opencode-retry");
        var opencodeDetails = byId("opencode-details");
        var opencodeGuideToggle = byId("opencode-guide-toggle");
        var api = store();

        if (providerField) {
            providerField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ provider: providerField.value });
                invalidateModelConnection();
                syncFormFromStore();
                if (providerField.value === "opencode" && loadStoredSettings().rulesOnly !== true &&
                    typeof root.refreshProviderModels === "function") {
                    root.refreshProviderModels();
                }
            });
        }
        if (endpointField) {
            endpointField.addEventListener("change", function () {
                if (!api) return;
                var settings = loadStoredSettings();
                var provider = currentProvider(settings);
                api.saveRuntimeEndpoint(provider, endpointField.value);
                api.updateSettings({ provider: provider, profile: { endpoint: endpointField.value } });
                invalidateModelConnection();
                syncFormFromStore();
            });
        }
        if (modelField) {
            modelField.addEventListener("change", function () {
                if (!api) return;
                var settings = loadStoredSettings();
                api.updateSettings({
                    provider: currentProvider(settings),
                    profile: { model: modelField.value }
                });
                syncFormFromStore();
            });
        }
        if (suggestionField) {
            suggestionField.addEventListener("change", function () {
                if (!api || !suggestionField.value) return;
                var settings = loadStoredSettings();
                api.updateSettings({
                    provider: currentProvider(settings),
                    profile: { model: suggestionField.value }
                });
                syncFormFromStore();
            });
        }
        if (keyField) {
            keyField.addEventListener("change", function () {
                if (!api || typeof api.savePassword !== "function") return;
                var settings = loadStoredSettings();
                api.savePassword(keyField.value, currentProvider(settings));
                invalidateModelConnection();
                syncFormFromStore();
            });
        }
        if (deepField) {
            deepField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ deep: deepField.checked === true });
            });
        }
        if (autoAdvanceField) {
            autoAdvanceField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ autoAdvance: autoAdvanceField.checked === true });
            });
        }
        if (rulesOnlyField) {
            rulesOnlyField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ rulesOnly: rulesOnlyField.checked === true });
                if (typeof root.syncProofreadingSettings === "function") root.syncProofreadingSettings();
                syncFormFromStore();
            });
        }
        if (refreshButton) {
            refreshButton.addEventListener("click", function () {
                var refresh = callSimple("refreshProviderModels", "模型服务检测尚未就绪。");
                if (refresh && typeof refresh.then === "function") refresh.then(function () {
                    syncFormFromStore();
                });
                syncFormFromStore();
            });
        }
        if (opencodeRetry) opencodeRetry.addEventListener("click", function () {
            if (typeof root.refreshProviderModels === "function") root.refreshProviderModels();
        });
        if (opencodeDetails) opencodeDetails.addEventListener("click", function () {
            var content = byId("opencode-guide-content");
            if (content) content.hidden = false;
            if (opencodeGuideToggle) opencodeGuideToggle.setAttribute("aria-expanded", "true");
        });
        if (opencodeGuideToggle) opencodeGuideToggle.addEventListener("click", function () {
            var content = byId("opencode-guide-content");
            if (!content) return;
            content.hidden = !content.hidden;
            opencodeGuideToggle.setAttribute("aria-expanded", content.hidden ? "false" : "true");
        });
        if (manualToggle) manualToggle.addEventListener("click", function (event) {
            if (event && event.preventDefault) event.preventDefault();
            var manualMode = manualToggle.getAttribute("aria-pressed") !== "true";
            manualToggle.setAttribute("aria-pressed", manualMode ? "true" : "false");
            syncFormFromStore();
        });
    }

    function loadAppVersion() {
        var element = byId("app-version");
        if (!element || typeof root.fetch !== "function") return Promise.resolve("");
        return root.fetch("../package.json", { cache: "no-store" })
            .then(function (response) {
                if (!response || !response.ok) throw new Error("version-unavailable");
                return response.json();
            })
            .then(function (packageInfo) {
                var version = packageInfo && packageInfo.version
                    ? String(packageInfo.version).trim() : "";
                element.textContent = version
                    ? "WPS 文本校改 · v" + version
                    : "WPS 文本校改 · 版本未知";
                return version;
            })
            .catch(function () {
                element.textContent = "WPS 文本校改 · 版本未知";
                return "";
            });
    }

    function bindUi() {
        var runButton = byId("run-proofreading");
        var cancelButton = byId("cancel-proofreading");
        var filter = byId("issue-filter");
        var confirmFullButton = byId("confirm-full-document");
        var declineFullButton = byId("decline-full-document");
        var proofreadingMode = byId("mode-proofread");
        var rewriteMode = byId("mode-rewrite");

        if (proofreadingMode) proofreadingMode.addEventListener("click", function () { setAppMode("proofread"); });
        if (rewriteMode) rewriteMode.addEventListener("click", function () { setAppMode("rewrite"); });

        if (confirmFullButton) {
            confirmFullButton.addEventListener("click", function () { finishFullDocumentConfirmation(true); });
        }
        if (declineFullButton) {
            declineFullButton.addEventListener("click", dismissFullDocumentConfirmation);
        }
        if (root.document && typeof root.document.addEventListener === "function") {
            root.document.addEventListener("keydown", function (event) {
                if (event.key === "Escape" && pendingFullDocumentConfirmation) {
                    if (typeof event.preventDefault === "function") event.preventDefault();
                    dismissFullDocumentConfirmation();
                }
            });
        }

        if (runButton) {
            runButton.addEventListener("click", callRunProofreading);
        }
        if (cancelButton) {
            cancelButton.addEventListener("click", function () {
                callSimple("cancelProofreading", "当前没有正在进行的校对。");
            });
        }
        if (filter) {
            filter.addEventListener("change", function () {
                state.filter = filter.value || "all";
                renderIssues();
            });
        }
        bindResultTabs();
        updateModeTabs();
        bindSettingsToggle();
        bindSettingsForm();
        syncFormFromStore();
        loadAppVersion();
    }

    function bindResultTabs() {
        var issuesTab = byId("tab-issues");
        var historyTab = byId("tab-history");
        var applyAllButton = byId("apply-all");
        var rerunButton = byId("rerun-proofreading");

        if (issuesTab) {
            issuesTab.addEventListener("click", function () { switchTab("issues"); });
        }
        if (historyTab) {
            historyTab.addEventListener("click", function () { switchTab("history"); });
        }
        if (applyAllButton) {
            applyAllButton.addEventListener("click", function () {
                callSimple("applyAllProofreadingIssues", "批量修正尚未就绪。");
            });
        }
        if (rerunButton) {
            rerunButton.addEventListener("click", function () { callRunProofreading(true); });
        }
        updateCount();
    }

    if (root.document && root.document.readyState === "loading") {
        root.document.addEventListener("DOMContentLoaded", bindUi);
    } else {
        bindUi();
    }
})(typeof window !== "undefined" ? window : globalThis);
