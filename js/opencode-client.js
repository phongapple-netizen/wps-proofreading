(function (root) {
    "use strict";

    var DEFAULT_ENDPOINT = "http://127.0.0.1:4096";
    var BASIC_USERNAME = "opencode";

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

    async function safeFetch(fetcher, url, init, signal, operation) {
        if (signal && signal.aborted) throw createCancelledError();
        try {
            var response = await fetcher(url, init);
            if (signal && signal.aborted) throw createCancelledError();
            return response;
        } catch (error) {
            if (isAbortError(error, signal)) throw createCancelledError();
            throw createError(operation + "失败，请检查 OpenCode 服务是否已启动及跨域设置。", "NETWORK_ERROR");
        }
    }

    async function responseJson(response, operation) {
        if (!responseIsOk(response)) {
            throw createError(operation + "失败" + statusText(response) + "。", "HTTP_ERROR");
        }
        if (!response || typeof response.json !== "function") {
            throw createError(operation + "返回格式无效。", "INVALID_RESPONSE");
        }
        try {
            return await response.json();
        } catch (error) {
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
            "连接 OpenCode 服务"
        );
        var payload = await responseJson(response, "OpenCode 健康检查");
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
            "获取 OpenCode 模型"
        );
        return parseModels(await responseJson(response, "OpenCode 模型列表"));
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
                await fetcher(urlFor(endpoint, sessionPath(sessionId, "/abort")), requestInit(options, "POST", {}, false));
            } catch (error) {
                // The original request error is more useful than cleanup errors.
            }
        }
        try {
            await fetcher(urlFor(endpoint, sessionPath(sessionId, "")), requestInit(options, "DELETE", undefined, false));
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
            var sessionResponse = await safeFetch(
                fetcher,
                urlFor(endpoint, "/session"),
                requestInit(options, "POST", { title: "WPS 文本校对" }, true),
                signal,
                "创建 OpenCode 会话"
            );
            var sessionPayload = await responseJson(sessionResponse, "创建 OpenCode 会话");
            sessionId = sessionPayload && typeof sessionPayload.id === "string" ? sessionPayload.id : "";
            if (!sessionId) throw createError("OpenCode 没有返回有效的会话编号。", "INVALID_SESSION");

            var body = {
                model: model,
                tools: {},
                parts: [{ type: "text", text: promptText }]
            };
            if (typeof options.systemPrompt === "string" && options.systemPrompt.trim()) {
                body.system = options.systemPrompt;
            }
            var messageResponse = await safeFetch(
                fetcher,
                urlFor(endpoint, sessionPath(sessionId, "/message")),
                requestInit(options, "POST", body, true),
                signal,
                "发送 OpenCode 校对请求"
            );
            var messagePayload = await responseJson(messageResponse, "OpenCode 校对请求");
            var result = extractTextParts(messagePayload);
            if (!result.trim()) throw createError("OpenCode 没有返回文本内容。", "EMPTY_RESPONSE");
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
