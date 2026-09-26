(function (root) {
    "use strict";

    var DEFAULT_ENDPOINT = "http://127.0.0.1:4096";
    var BASIC_USERNAME = "opencode";
    var REQUEST_TIMEOUT_MS = 180000;
    var HEALTH_TIMEOUT_MS = 10000;
    var CLEANUP_TIMEOUT_MS = 2000;
    var PERMISSION_POLL_MS = 1000;
    var PROOFREADING_SYSTEM_PROMPT = "你是中文文本校对助手。仅根据用户提供的文本返回请求的校对结果。" +
        "不要调用工具，不要读取本机文件，不要执行命令或访问网络。";

    function text(value) {
        return String(value == null ? "" : value);
    }

    function createError(message, code) {
        var error = new Error(message);
        if (code) error.code = code;
        return error;
    }

    function createCancelledError() {
        return createError("请求已取消。", "ABORTED");
    }

    function isAbortError(error, signal) {
        return Boolean(
            (error && error.name === "AbortError") ||
            (signal && signal.aborted)
        );
    }

    function normalizeEndpoint(endpoint) {
        var value = text(endpoint || DEFAULT_ENDPOINT).trim();
        var parsed;
        try {
            parsed = new URL(value);
        } catch (error) {
            throw createError("OpenCode 服务地址无效，请填写 http://127.0.0.1:4096 这类地址。", "INVALID_ENDPOINT");
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw createError("OpenCode 服务地址只支持 http:// 或 https://。", "INVALID_ENDPOINT");
        }
        if (parsed.username || parsed.password) {
            throw createError("OpenCode 服务地址不能包含账号或密码，请在密码框中填写。", "INVALID_ENDPOINT");
        }
        return value.replace(/\/+$/, "");
    }

    function readPassword(options) {
        var value = options && options.serverPassword;
        if (value == null) value = options && options.password;
        return text(value).trim();
    }

    function utf8Bytes(value) {
        if (typeof TextEncoder !== "undefined") {
            return new TextEncoder().encode(value);
        }
        var encoded = unescape(encodeURIComponent(value));
        var bytes = new Uint8Array(encoded.length);
        for (var i = 0; i < encoded.length; i += 1) bytes[i] = encoded.charCodeAt(i);
        return bytes;
    }

    function encodeBase64(value) {
        var bytes = utf8Bytes(value);
        var binary = "";
        for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        if (typeof root.btoa === "function") return root.btoa(binary);
        if (typeof btoa === "function") return btoa(binary);
        if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
        throw createError("当前 WPS 内核不支持 Basic 认证。", "AUTH_UNSUPPORTED");
    }

    function createHeaders(options) {
        var headers = { "Content-Type": "application/json" };
        var password = readPassword(options);
        if (password) {
            headers.Authorization = "Basic " + encodeBase64(BASIC_USERNAME + ":" + password);
        }
        return headers;
    }

    function urlFor(endpoint, path) {
        return endpoint + "/" + path.replace(/^\/+/, "");
    }

    function fetcherFor(fetchImpl) {
        var fetcher = fetchImpl || root.fetch;
        if (typeof fetcher !== "function") {
            throw createError("当前 WPS 内核不支持网络请求。", "FETCH_UNSUPPORTED");
        }
        return fetcher;
    }

    function responseIsOk(response) {
        if (!response) return false;
        if (typeof response.ok === "boolean") return response.ok;
        return Number(response.status) >= 200 && Number(response.status) < 300;
    }

    function statusText(response) {
        var status = response && Number(response.status);
        return Number.isFinite(status) && status > 0 ? "（HTTP " + status + "）" : "";
    }

    function withDeadline(task, signal, timeoutMs, operation) {
        return new Promise(function (resolve, reject) {
            if (signal && signal.aborted) return reject(createCancelledError());
            var settled = false;
            var controller = typeof AbortController === "function" ? new AbortController() : null;
            var timer;
            function finish(error, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (signal && typeof signal.removeEventListener === "function") {
                    signal.removeEventListener("abort", cancel);
                }
                if (error) reject(error);
                else resolve(value);
            }
            function cancel() {
                if (controller) controller.abort();
                finish(createCancelledError());
            }
            if (signal && typeof signal.addEventListener === "function") {
                signal.addEventListener("abort", cancel, { once: true });
            }
            timer = setTimeout(function () {
                if (controller) controller.abort();
                finish(createError(operation + "超时，请重试。", "TIMEOUT"));
            }, timeoutMs);
            Promise.resolve().then(function () {
                if (settled) return;
                return task(controller ? controller.signal : signal);
            }).then(function (value) { finish(null, value); }, function (error) { finish(error); });
        });
    }

    async function safeFetch(fetcher, url, init, signal, operation, timeoutMs) {
        if (signal && signal.aborted) throw createCancelledError();
        try {
            var response = await withDeadline(function (deadlineSignal) {
                return fetcher(url, Object.assign({}, init, { signal: deadlineSignal }));
            }, signal, timeoutMs || REQUEST_TIMEOUT_MS, operation);
            if (signal && signal.aborted) throw createCancelledError();
            return response;
        } catch (error) {
            if (isAbortError(error, signal)) throw createCancelledError();
            if (error && error.code === "TIMEOUT") throw error;
            throw createError(operation + "失败，请检查 OpenCode 服务是否已启动及跨域设置。", "NETWORK_ERROR");
        }
    }

    async function responseJson(response, operation, signal, timeoutMs) {
        if (!responseIsOk(response)) {
            throw createError(operation + "失败" + statusText(response) + "。", "HTTP_ERROR");
        }
        if (!response || typeof response.json !== "function") {
            throw createError(operation + "返回格式无效。", "INVALID_RESPONSE");
        }
        try {
            return await withDeadline(function () { return response.json(); }, signal,
                timeoutMs || REQUEST_TIMEOUT_MS, operation);
        } catch (error) {
            if (error && (error.code === "TIMEOUT" || error.code === "ABORTED")) throw error;
            throw createError(operation + "返回格式无效。", "INVALID_RESPONSE");
        }
    }

    function signalOf(options) {
        return options && options.signal ? options.signal : undefined;
    }

    function requestInit(options, method, body, includeSignal) {
        var init = {
            method: method,
            headers: createHeaders(options)
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        if (includeSignal && signalOf(options)) init.signal = signalOf(options);
        return init;
    }

    async function checkHealth(options, fetchImpl) {
        options = options || {};
        var endpoint = normalizeEndpoint(options.endpoint);
        var signal = signalOf(options);
        var fetcher = fetcherFor(fetchImpl);
        var response = await safeFetch(
            fetcher,
            urlFor(endpoint, "/global/health"),
            requestInit(options, "GET", undefined, true),
            signal,
            "连接 OpenCode 服务", HEALTH_TIMEOUT_MS
        );
        var payload = await responseJson(response, "OpenCode 健康检查", signal, HEALTH_TIMEOUT_MS);
        return {
            ok: true,
            healthy: payload && payload.healthy === false ? false : true,
            status: Number(response.status) || 200,
            version: payload && typeof payload.version === "string" ? payload.version : ""
        };
    }

    function modelIdFromValue(value, fallback) {
        if (typeof value === "string" && value.trim()) return value.trim();
        if (value && typeof value === "object") {
            var id = value.id || value.modelID || value.modelId || value.name;
            if (typeof id === "string" && id.trim()) return id.trim();
        }
        return text(fallback).trim();
    }

    function providerIdFromValue(value, fallback) {
        if (value && typeof value === "object") {
            var id = value.id || value.providerID || value.providerId;
            if (typeof id === "string" && id.trim()) return id.trim();
        }
        return text(fallback).trim();
    }

    function addCandidate(list, seen, providerId, modelId, markDefault) {
        providerId = text(providerId).trim();
        modelId = text(modelId).trim();
        if (!providerId || !modelId) return;
        var candidate = providerId + "/" + modelId;
        if (!seen[candidate]) {
            seen[candidate] = true;
            list.push(candidate);
        }
        if (markDefault) list._defaults.push(candidate);
    }

    function addModelsForProvider(list, seen, providerId, provider) {
        if (!providerId || !provider || typeof provider !== "object") return;
        var models = provider.models;
        if (Array.isArray(models)) {
            models.forEach(function (model) {
                var modelId = modelIdFromValue(model);
                addCandidate(list, seen, providerId, modelId, model && typeof model === "object" && model.default === true);
            });
        } else if (models && typeof models === "object") {
            Object.keys(models).forEach(function (key) {
                var model = models[key];
                var modelId = modelIdFromValue(model, key);
                addCandidate(list, seen, providerId, modelId, model && typeof model === "object" && model.default === true);
            });
        }

        var providerDefault = provider.default || provider.defaultModel || provider.defaultModelID;
        if (typeof providerDefault === "string") {
            addCandidate(list, seen, providerId, providerDefault, true);
        }
    }

    function collectDefaultCandidates(value, providerHint, output) {
        if (value == null) return;
        if (typeof value === "string") {
            var stringValue = value.trim();
            if (!stringValue) return;
            output.push(providerHint && stringValue.indexOf("/") < 0
                ? providerHint + "/" + stringValue
                : stringValue);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(function (item) {
                collectDefaultCandidates(item, providerHint, output);
            });
            return;
        }
        if (typeof value !== "object") return;

        var explicitProvider = value.providerID || value.providerId || value.provider;
        var explicitModel = value.modelID || value.modelId || value.model;
        if (typeof explicitProvider === "string" && typeof explicitModel === "string") {
            output.push(explicitProvider.trim() + "/" + explicitModel.trim());
            return;
        }

        Object.keys(value).forEach(function (key) {
            var item = value[key];
            if (typeof item === "string") {
                collectDefaultCandidates(item, key, output);
            } else {
                collectDefaultCandidates(item, providerHint || key, output);
            }
        });
    }

    function chooseDefault(models, candidates) {
        var byLower = Object.create(null);
        models.forEach(function (model) {
            byLower[model.toLowerCase()] = model;
        });
        for (var i = 0; i < candidates.length; i += 1) {
            var candidate = text(candidates[i]).trim();
            if (byLower[candidate.toLowerCase()]) return byLower[candidate.toLowerCase()];
        }
        return models.length ? models[0] : "";
    }

    function parseModels(payload) {
        if (!payload || !Object.prototype.hasOwnProperty.call(payload, "providers")) {
            throw createError("OpenCode 返回的模型列表格式无效。", "INVALID_MODELS");
        }

        var list = [];
        list._defaults = [];
        var seen = Object.create(null);
        var providers = payload.providers;
        if (Array.isArray(providers)) {
            providers.forEach(function (provider) {
                var providerId = providerIdFromValue(provider);
                addModelsForProvider(list, seen, providerId, provider);
            });
        } else if (providers && typeof providers === "object") {
            Object.keys(providers).forEach(function (key) {
                var provider = providers[key];
                var providerId = providerIdFromValue(provider, key);
                addModelsForProvider(list, seen, providerId, provider);
            });
        } else {
            throw createError("OpenCode 返回的模型列表格式无效。", "INVALID_MODELS");
        }

        var defaults = list._defaults.slice();
        collectDefaultCandidates(payload.default, "", defaults);
        collectDefaultCandidates(payload.defaults, "", defaults);
        var models = list.slice().sort(function (left, right) {
            return left.localeCompare(right, undefined, { sensitivity: "base" });
        });
        return {
            models: models,
            defaultModel: chooseDefault(models, defaults),
            // `default` is kept as a small compatibility alias for callers that
            // mirror OpenCode's response property name.
            "default": chooseDefault(models, defaults)
        };
    }

    async function fetchModels(options, fetchImpl) {
        options = options || {};
        var endpoint = normalizeEndpoint(options.endpoint);
        var signal = signalOf(options);
        var fetcher = fetcherFor(fetchImpl);
        var response = await safeFetch(
            fetcher,
            urlFor(endpoint, "/config/providers"),
            requestInit(options, "GET", undefined, true),
            signal,
            "获取 OpenCode 模型", HEALTH_TIMEOUT_MS
        );
        return parseModels(await responseJson(response, "OpenCode 模型列表", signal, HEALTH_TIMEOUT_MS));
    }

    function parseModelName(modelName) {
        var value = text(modelName).trim();
        var separator = value.indexOf("/");
        if (separator <= 0 || separator === value.length - 1) {
            throw createError("模型格式无效，应为 provider/model。请从 OpenCode 模型列表中重新选择。", "INVALID_MODEL");
        }
        var providerID = value.slice(0, separator).trim();
        var modelID = value.slice(separator + 1).trim();
        if (!providerID || !modelID) {
            throw createError("模型格式无效，应为 provider/model。请从 OpenCode 模型列表中重新选择。", "INVALID_MODEL");
        }
        return {
            providerID: providerID,
            modelID: modelID
        };
    }

    function sessionPath(sessionId, suffix) {
        return "/session/" + encodeURIComponent(sessionId) + suffix;
    }

    async function cleanupSession(fetcher, options, endpoint, sessionId, shouldAbort) {
        if (!sessionId) return;
        // Cleanup deliberately does not reuse the caller's AbortSignal. Once a
        // request is cancelled, abort/delete still need a chance to reach the
        // local server, and both operations are best effort.
        if (shouldAbort) {
            try {
                await safeFetch(fetcher, urlFor(endpoint, sessionPath(sessionId, "/abort")),
                    requestInit(options, "POST", {}, false), null, "终止 OpenCode 会话", CLEANUP_TIMEOUT_MS);
            } catch (error) {
                // The original request error is more useful than cleanup errors.
            }
        }
        try {
            await safeFetch(fetcher, urlFor(endpoint, sessionPath(sessionId, "")),
                requestInit(options, "DELETE", undefined, false), null, "清理 OpenCode 会话", CLEANUP_TIMEOUT_MS);
        } catch (error) {
            // Session cleanup must not hide the model response or cancellation.
        }
    }

    function extractTextParts(payload) {
        var parts = payload && Array.isArray(payload.parts) ? payload.parts : [];
        return parts.filter(function (part) {
            return part && String(part.type || "").toLowerCase() === "text" && typeof part.text === "string";
        }).map(function (part) {
            return part.text;
        }).join("");
    }

    function watchPermissions(fetcher, options, endpoint, sessionId, signal) {
        var stopped = false;
        var timer;
        var promise = new Promise(function (resolve, reject) {
            async function poll() {
                if (stopped) return;
                try {
                    var response = await safeFetch(fetcher, urlFor(endpoint, "/permission"),
                        requestInit(options, "GET", undefined, false), signal,
                        "检查 OpenCode 工具审批", HEALTH_TIMEOUT_MS);
                    var pending = await responseJson(response, "检查 OpenCode 工具审批", signal, HEALTH_TIMEOUT_MS);
                    if (stopped) return;
                    if (!Array.isArray(pending)) {
                        throw createError("OpenCode 工具审批检查返回格式无效，已中止校对。", "INVALID_PERMISSIONS");
                    }
                    if (pending.some(function (item) { return item && item.sessionID === sessionId; })) {
                        throw createError("OpenCode 尝试调用工具，已中止本次校对。请重试。", "MODEL_TOOL_BLOCKED");
                    }
                    timer = setTimeout(poll, PERMISSION_POLL_MS);
                } catch (error) {
                    if (!stopped) reject(error);
                }
            }
            timer = setTimeout(poll, PERMISSION_POLL_MS);
        });
        return {
            promise: promise,
            stop: function () { stopped = true; clearTimeout(timer); }
        };
    }

    async function requestMessage(fetcher, options, endpoint, sessionId, body, signal) {
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var requestSignal = controller ? controller.signal : signal;
        function cancel() { if (controller) controller.abort(); }
        if (signal && signal.aborted) cancel();
        if (signal && typeof signal.addEventListener === "function") {
            signal.addEventListener("abort", cancel, { once: true });
        }
        var watcher = watchPermissions(fetcher, options, endpoint, sessionId, requestSignal);
        try {
            var message = (async function () {
                var response = await safeFetch(fetcher, urlFor(endpoint, sessionPath(sessionId, "/message")),
                    requestInit(options, "POST", body, false), requestSignal, "发送 OpenCode 校对请求");
                return responseJson(response, "OpenCode 校对请求", requestSignal);
            })();
            return await Promise.race([message, watcher.promise]);
        } finally {
            watcher.stop();
            cancel();
            if (signal && typeof signal.removeEventListener === "function") {
                signal.removeEventListener("abort", cancel);
            }
        }
    }

    function messageError(payload) {
        // Model failures are returned in info.error even when HTTP is 200.
        // Map known errors without exposing provider bodies, headers or secrets.
        var error = payload && payload.info && payload.info.error;
        if (!error) return null;
        var data = error.data || {};
        var status = Number(data.statusCode);
        var statusLabel = Number.isInteger(status) && status >= 100 && status <= 599
            ? "（HTTP " + status + "）" : "";

        if (error.name === "APIError" && status === 403 &&
            /opencode['’]s free tier can only be used from within opencode/i.test(text(data.message))) {
            return createError("OpenCode 免费模型拒绝当前请求（HTTP 403），服务端提示免费额度仅限 OpenCode 内使用。" +
                "代理或权限配置不兼容也可能触发此提示，请检查 OpenCode 配置或切换模型后重试。", "MODEL_RESTRICTED");
        }
        if (error.name === "ProviderAuthError" || status === 401 || status === 403) {
            return createError("OpenCode 模型认证失败或没有调用权限" + statusLabel +
                "。请在 OpenCode 服务端检查模型提供商的密钥和权限；插件中的服务密码仅用于连接 OpenCode。", "MODEL_AUTH_ERROR");
        }
        if (status === 402) {
            return createError("OpenCode 模型额度不足" + statusLabel +
                "。请检查模型提供商的余额或切换模型。", "MODEL_QUOTA_ERROR");
        }
        if (status === 429) {
            return createError("OpenCode 模型请求受限" + statusLabel +
                "。请检查模型额度，稍后重试或切换模型。", "MODEL_RATE_LIMITED");
        }
        if (error.name === "MessageAbortedError") {
            return createError("OpenCode 模型请求已中止，请重试。", "MODEL_ABORTED");
        }
        if (error.name === "ContextOverflowError") {
            return createError("校对内容超过 OpenCode 模型的上下文容量，请缩短选区或切换模型。", "MODEL_CONTEXT_OVERFLOW");
        }
        if (error.name === "MessageOutputLengthError") {
            return createError("OpenCode 模型输出达到长度上限，请缩短选区或切换模型后重试。", "MODEL_OUTPUT_LIMIT");
        }
        if (error.name === "ContentFilterError") {
            return createError("OpenCode 模型提供商拦截了本次响应，请检查校对内容或切换模型。", "MODEL_CONTENT_FILTERED");
        }
        return createError("OpenCode 模型调用失败" + statusLabel +
            "。请检查 OpenCode 服务端日志和模型设置，或切换模型后重试。", "MODEL_ERROR");
    }

    async function request(options, prompt, fetchImpl) {
        options = options || {};
        var endpoint = normalizeEndpoint(options.endpoint);
        var signal = signalOf(options);
        var fetcher = fetcherFor(fetchImpl);
        var model = parseModelName(options.model);
        var promptText = text(prompt);
        if (!promptText.trim()) throw createError("校对内容不能为空。", "EMPTY_PROMPT");

        var sessionId = "";
        var completed = false;
        try {
            // Keep OpenCode's standard tool definitions for model compatibility.
            // Every action requires approval; this client never grants approval.
            var sessionResponse = await safeFetch(
                fetcher,
                urlFor(endpoint, "/session"),
                requestInit(options, "POST", {
                    title: "WPS 文本校对",
                    permission: [{ permission: "*", pattern: "*", action: "ask" }]
                }, true),
                signal,
                "创建 OpenCode 会话"
            );
            var sessionPayload = await responseJson(sessionResponse, "创建 OpenCode 会话", signal);
            sessionId = sessionPayload && typeof sessionPayload.id === "string" ? sessionPayload.id : "";
            if (!sessionId) throw createError("OpenCode 没有返回有效的会话编号。", "INVALID_SESSION");
            var permissions = sessionPayload.permission;
            if (!Array.isArray(permissions) || permissions.length !== 1 ||
                !permissions[0] || permissions[0].permission !== "*" ||
                permissions[0].pattern !== "*" || permissions[0].action !== "ask") {
                throw createError("OpenCode 没有启用校对会话的工具审批限制，请更新 OpenCode 后重试。", "UNSAFE_SESSION");
            }

            // The built-in agent preserves OpenCode's provider system prompt.
            var body = {
                model: model,
                agent: "build",
                system: PROOFREADING_SYSTEM_PROMPT,
                parts: [{ type: "text", text: promptText }]
            };
            if (typeof options.systemPrompt === "string" && options.systemPrompt.trim()) {
                body.system += "\n" + options.systemPrompt;
            }
            var messagePayload = await requestMessage(fetcher, options, endpoint, sessionId, body, signal);
            var modelError = messageError(messagePayload);
            if (modelError) throw modelError;
            var result = extractTextParts(messagePayload);
            if (!result.trim()) throw createError("OpenCode 模型返回了空文本，请重试或切换模型。", "EMPTY_RESPONSE");
            completed = true;
            return result;
        } catch (error) {
            if (isAbortError(error, signal) || (error && error.code === "ABORTED")) {
                throw createCancelledError();
            }
            if (error && error.code) throw error;
            throw createError("OpenCode 校对请求失败，请检查服务状态和模型设置。", "REQUEST_ERROR");
        } finally {
            await cleanupSession(fetcher, options, endpoint, sessionId, !completed);
        }
    }

    var api = {
        defaultEndpoint: DEFAULT_ENDPOINT,
        normalizeEndpoint: normalizeEndpoint,
        parseModelName: parseModelName,
        checkHealth: checkHealth,
        fetchModels: fetchModels,
        request: request
    };

    root.WpsOpenCodeClient = api;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
