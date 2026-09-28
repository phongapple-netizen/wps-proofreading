(function (root) {
    "use strict";

    var state = {
        status: { text: "等待开始", tone: "idle" },
        issues: [],
        filter: "all",
        busy: false,
        actionBusy: false,
        tab: "issues",
        history: [],
        historyIds: {}
    };
    var pendingFullDocumentConfirmation = null;
    var renderedIssueActionButtons = [];

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
        state.status = normalizeStatus(status, tone);
        var element = byId("proofreading-status");
        if (element) {
            element.textContent = state.status.text;
            element.className = "status status-" + state.status.tone;
        }
        return state.status;
    }

    function setModelConnectionStatus(message, tone) {
        var element = byId("connection-status");
        if (!element) return;
        element.textContent = String(message || "");
        element.className = "connection-status connection-status-" + String(tone || "idle");
    }

    function setProofreadingBusy(value) {
        state.busy = value === true;
        var cancelButton = byId("cancel-proofreading");
        if (cancelButton) {
            cancelButton.hidden = !state.busy || !!pendingFullDocumentConfirmation;
            cancelButton.disabled = !state.busy;
        }
        if (!state.busy) setProofreadingProgress(0, "");
        renderIssues();
        updateActionControls();
        return state.busy;
    }

    function updateActionControls() {
        var runButton = byId("run-proofreading");
        var applyAllButton = byId("apply-all");
        var rerunButton = byId("rerun-proofreading");

        if (runButton) runButton.disabled = state.busy || state.actionBusy;
        if (applyAllButton) {
            applyAllButton.disabled = state.busy || state.actionBusy || !autoFixableCount();
        }
        if (rerunButton) rerunButton.disabled = state.busy || state.actionBusy;
        renderedIssueActionButtons.forEach(function (button) {
            button.disabled = state.actionBusy || button._proofreadingActionDisabled === true;
        });
    }

    function setProofreadingActionBusy(value) {
        state.actionBusy = value === true;
        updateActionControls();
        return state.actionBusy;
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
            (Number(value.characterCount) || 0) + " 个字符。\n待校对文本将发送给 " + target + "。";
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
        if (labelEl) labelEl.textContent = label
            ? label + " · " + value + "%"
            : value + "%";
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

        toggle.addEventListener("click", function (event) {
            event.stopPropagation();
            setSettingsOpen(popover.hidden);
        });
        popover.addEventListener("click", function (event) {
            event.stopPropagation();
        });
        root.document.addEventListener("click", function () {
            if (!popover.hidden) setSettingsOpen(false);
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
            reason: String(value.reason || ""),
            stateLabel: String(value.stateLabel || ""),
            confidence: typeof value.confidence === "number" ? value.confidence : null,
            message: String(value.message || value.reason || ""),
            suggestion: typeof value.suggestion === "string"
                ? value.suggestion
                : String(value.replacement || ""),
            status: String(value.status || "pending"),
            needsReview: value.needsReview === true,
            autoFixable: value.autoFixable === true,
            actionable: value.actionable !== false,
            ruleName: String(value.ruleName || ""),
            ruleSource: String(value.ruleSource || ""),
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
        if (count) count.textContent = String(state.issues.length);
        var applyAllButton = byId("apply-all");
        if (applyAllButton) {
            applyAllButton.disabled = state.busy || state.actionBusy || autoFixableCount() === 0;
            applyAllButton.title = pendingCount() > autoFixableCount()
                ? "仅自动修正内置低风险标点格式规则"
                : "";
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
    }

    function clearIssues() {
        state.issues = [];
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

    function callAction(name, issueId, fallbackMessage) {
        var callback = root[name];
        if (typeof callback !== "function") {
            setProofreadingStatus(fallbackMessage, "warning");
            return false;
        }
        try {
            var result = callback(issueId);
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
        button.disabled = state.actionBusy || button._proofreadingActionDisabled;
        renderedIssueActionButtons.push(button);
        button.setAttribute("data-issue-id", issue.id);
        if (!button._proofreadingActionDisabled) {
            button.addEventListener("click", function (event) {
                if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                if (state.actionBusy) return;
                callAction(callbackName, issue.id, "当前操作未能完成。");
            });
        }
        return button;
    }

    function visibleIssues() {
        if (state.filter === "all") return state.issues.slice();
        return state.issues.filter(function (issue) {
            return issue.category === state.filter;
        });
    }

    function renderIssues(issues) {
        if (Array.isArray(issues)) {
            state.issues = issues.map(normalizeIssue);
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
        renderedIssueActionButtons = [];
        list.textContent = "";
        if (!shown.length) {
            list.hidden = true;
            if (emptyState) {
                emptyState.textContent = state.issues.length
                    ? "当前筛选类型没有问题。"
                    : "校对结果会显示在这里。";
                emptyState.hidden = false;
            }
            return state.issues.slice();
        }

        shown.forEach(function (issue) {
            var pending = issue.status === "pending";
            var card = root.document.createElement("article");
            card.className = "issue-card" + (pending && !state.busy ? " is-locatable" : "");
            if (pending && !state.busy) {
                card.addEventListener("click", function () {
                    if (state.actionBusy) return;
                    callAction("locateProofreadingIssue", issue.id, "当前操作未能完成。");
                });
            }

            var header = root.document.createElement("div");
            header.className = "issue-card-header";

            var badges = root.document.createElement("div");
            badges.className = "issue-badges";
            var chip = root.document.createElement("span");
            chip.className = "chip chip-" + (issue.category || "general");
            chip.textContent = issue.categoryLabel;
            badges.appendChild(chip);
            if (issue.origin === "rule+ai") {
                var sourceBadge = root.document.createElement("span");
                sourceBadge.className = issue.aiConflict ? "badge-conflict" : "badge-source";
                sourceBadge.textContent = issue.aiConflict ? "规则与 AI 意见不同" : "规则 + AI";
                badges.appendChild(sourceBadge);
            } else if (issue.origin === "ai-review") {
                var reviewBadge = root.document.createElement("span");
                reviewBadge.className = "badge-source";
                reviewBadge.textContent = "AI核查规则";
                badges.appendChild(reviewBadge);
            } else if (issue.origin === "rule") {
                var ruleBadge = root.document.createElement("span");
                ruleBadge.className = "badge-source";
                ruleBadge.textContent = "本地规则";
                badges.appendChild(ruleBadge);
            }
            if (issue.needsReview) {
                var deepBadge = root.document.createElement("span");
                deepBadge.className = "badge-deep";
                deepBadge.textContent = "需人工复核";
                badges.appendChild(deepBadge);
            }
            header.appendChild(badges);

            var actions = root.document.createElement("div");
            actions.className = "issue-actions";
            actions.appendChild(actionButton("定位", "issue-action-secondary", issue, "locateProofreadingIssue", !pending));
            actions.appendChild(actionButton(
                issue.status === "accepted" ? "撤销" :
                    issue.status === "ignored" ? "已忽略" :
                        issue.status === "stale" ? "需重查" : "修正",
                "",
                issue,
                issue.status === "accepted" ? "undoProofreadingIssue" : "applyProofreadingIssue",
                state.busy || (!pending && issue.status !== "accepted") ||
                    (pending && issue.actionable === false)
            ));
            actions.appendChild(actionButton("忽略", "issue-action-secondary", issue, "ignoreProofreadingIssue", state.busy || !pending));
            header.appendChild(actions);
            card.appendChild(header);

            if (issue.original || issue.suggestion) {
                var diff = root.document.createElement("p");
                diff.className = "issue-diff";
                var old = root.document.createElement("span");
                old.className = "diff-old";
                old.textContent = issue.original;
                diff.appendChild(old);
                if (issue.actionable !== false) {
                    var arrow = root.document.createElement("span");
                    arrow.className = "diff-arrow";
                    arrow.textContent = " → ";
                    diff.appendChild(arrow);
                    var fresh = root.document.createElement("span");
                    fresh.className = "diff-new";
                    fresh.textContent = issue.suggestion === "" ? "建议删除" : issue.suggestion;
                    diff.appendChild(fresh);
                }
                card.appendChild(diff);
            }

            if ((issue.origin === "rule" || issue.origin === "rule+ai" ||
                issue.origin === "ai-review") && (issue.ruleName || issue.ruleSource)) {
                var ruleMeta = root.document.createElement("p");
                ruleMeta.className = "issue-state";
                ruleMeta.textContent = (issue.ruleName ? "规则：" + issue.ruleName : "自定义规则") +
                    (issue.ruleSource ? " · 来源：" + issue.ruleSource : "");
                card.appendChild(ruleMeta);
            }

            if (issue.reason) {
                var analysis = root.document.createElement("details");
                analysis.className = "issue-analysis";
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

            if (issue.stateLabel || !pending) {
                var stateLine = root.document.createElement("p");
                stateLine.className = "issue-state";
                stateLine.textContent = issue.stateLabel || "状态：" + issue.status;
                card.appendChild(stateLine);
            }

            list.appendChild(card);
        });

        list.hidden = false;
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

    function callRunProofreading() {
        var callback = typeof root.runProofreading === "function"
            ? root.runProofreading
            : defaultRunProofreading;
        try {
            var result = callback();
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
    root.setProofreadingActionBusy = root.setProofreadingActionBusy || setProofreadingActionBusy;
    root.requestFullDocumentConfirmation = root.requestFullDocumentConfirmation || requestFullDocumentConfirmation;
    root.dismissFullDocumentConfirmation = root.dismissFullDocumentConfirmation || dismissFullDocumentConfirmation;
    root.setProofreadingProgress = root.setProofreadingProgress || setProofreadingProgress;
    root.syncSettingsForm = syncFormFromStore;
    root.getProofreadingStatus = root.getProofreadingStatus || getProofreadingStatus;
    root.setProofreadingIssues = root.setProofreadingIssues || renderIssues;
    root.clearProofreadingIssues = root.clearProofreadingIssues || clearIssues;
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

        if (keyRow) keyRow.hidden = provider === "ollama";
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
            if (help) help.textContent = "先启动 OpenCode 服务，再读取当前项目可用的模型。";
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
        models.forEach(function (name) {
            var option = root.document.createElement("option");
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        select.value = models.indexOf(current) >= 0 ? current : "";
        var placeholder = select.options[0];
        if (placeholder) {
            placeholder.textContent = models.length
                ? "（从 " + models.length + " 个已检测模型中选择）"
                : "（先点“检测并读取模型”）";
        }
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
        syncModelSuggestions(settings);
    }

    function bindSettingsForm() {
        var providerField = byId("model-provider");
        var endpointField = byId("model-endpoint");
        var modelField = byId("model-name");
        var suggestionField = byId("model-suggestions");
        var keyField = byId("model-api-key");
        var deepField = byId("deep-enhance");
        var refreshButton = byId("refresh-models");
        var api = store();

        if (providerField) {
            providerField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ provider: providerField.value });
                syncFormFromStore();
            });
        }
        if (endpointField) {
            endpointField.addEventListener("change", function () {
                if (!api) return;
                var settings = loadStoredSettings();
                var provider = currentProvider(settings);
                api.saveRuntimeEndpoint(provider, endpointField.value);
                api.updateSettings({ provider: provider, profile: { endpoint: endpointField.value } });
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
            });
        }
        if (deepField) {
            deepField.addEventListener("change", function () {
                if (!api) return;
                api.updateSettings({ deep: deepField.checked === true });
            });
        }
        if (refreshButton) {
            refreshButton.addEventListener("click", function () {
                callSimple("refreshProviderModels", "模型服务检测尚未就绪。");
                syncFormFromStore();
            });
        }
    }

    function bindUi() {
        var runButton = byId("run-proofreading");
        var cancelButton = byId("cancel-proofreading");
        var filter = byId("issue-filter");
        var confirmFullButton = byId("confirm-full-document");
        var declineFullButton = byId("decline-full-document");

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
        bindSettingsToggle();
        bindSettingsForm();
        syncFormFromStore();
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
            rerunButton.addEventListener("click", callRunProofreading);
        }
        updateCount();
    }

    if (root.document && root.document.readyState === "loading") {
        root.document.addEventListener("DOMContentLoaded", bindUi);
    } else {
        bindUi();
    }
})(typeof window !== "undefined" ? window : globalThis);
