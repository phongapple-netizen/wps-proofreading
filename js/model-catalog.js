(function (root) {
    "use strict";

    function text(value) {
        return String(value == null ? "" : value);
    }

    function safeEndpoint(value) {
        var endpoint = text(value).trim().replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(endpoint)) {
            throw new Error("请填写以 http:// 或 https:// 开头的模型服务地址。");
        }
        return endpoint;
    }

    function authHeaders(apiKey, scheme) {
        var headers = { "Content-Type": "application/json" };
        if (apiKey) headers.Authorization = scheme + " " + apiKey;
        return headers;
    }

    function withTimeout(promise, message, onTimeout) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                if (onTimeout) onTimeout();
                reject(new Error(message));
            }, 10000);
            Promise.resolve(promise).then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    async function fetchJson(url, options, failureMessage, fetchImpl) {
        var fetcher = fetchImpl || root.fetch;
        if (typeof fetcher !== "function") throw new Error("当前 WPS 内核不支持网络请求。");
        var response;
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        try {
            response = await withTimeout(fetcher(url, Object.assign({}, options || {}, {
                signal: controller ? controller.signal : options && options.signal
            })), "模型列表请求超时。", function () { if (controller) controller.abort(); });
        } catch (error) {
            if (error && /超时/.test(error.message)) throw error;
            throw new Error(failureMessage);
        }
        if (!response || !response.ok) {
            var status = response && response.status ? "（HTTP " + response.status + "）" : "";
            throw new Error(failureMessage + status);
        }
        try {
            return await withTimeout(response.json(), "模型列表响应超时。", function () {
                if (controller) controller.abort();
            });
        } catch (error) {
            if (error && /超时/.test(error.message)) throw error;
            throw new Error("模型服务返回了无法识别的响应。");
        }
    }

    async function fetchOllamaModels(options, fetchImpl) {
        var endpoint = safeEndpoint(options.endpoint).replace(/\/api\/chat$/i, "");
        var payload = await fetchJson(endpoint + "/api/tags", { method: "GET" },
            "无法连接 Ollama，请确认服务已经启动。", fetchImpl);
        var models = Array.isArray(payload && payload.models)
            ? payload.models.map(function (item) {
                return text(item && (item.name || item.model)).trim();
            }).filter(Boolean)
            : [];
        return { models: models, defaultModel: models[0] || "", detail: "Ollama 已连接" };
    }

    async function fetchOpenAiModels(options, fetchImpl) {
        var endpoint = safeEndpoint(options.endpoint);
        if (!/\/chat\/completions$/i.test(endpoint)) {
            throw new Error("请填写完整的 Chat Completions API 地址。");
        }
        var url = endpoint.replace(/\/chat\/completions$/i, "/models");
        var payload = await fetchJson(url, {
            method: "GET",
            headers: authHeaders(options.apiKey, "Bearer")
        }, "无法读取兼容接口的模型列表，请检查地址、密钥和跨域设置。", fetchImpl);
        var models = Array.isArray(payload && payload.data)
            ? payload.data.map(function (item) { return text(item && item.id).trim(); }).filter(Boolean)
            : [];
        return { models: models, defaultModel: models[0] || "", detail: "兼容接口已连接" };
    }

    async function fetchOpenCodeModels(options, fetchImpl) {
        if (!root.WpsOpenCodeClient) throw new Error("OpenCode 客户端模块没有加载。");
        var clientOptions = {
            endpoint: options.endpoint,
            password: options.apiKey
        };
        var health = await root.WpsOpenCodeClient.checkHealth(clientOptions, fetchImpl || root.fetch);
        var result = await root.WpsOpenCodeClient.fetchModels(clientOptions, fetchImpl || root.fetch);
        var preferred = (result.models || []).indexOf("opencode/mimo-v2.6-flash-free") >= 0
            ? "opencode/mimo-v2.6-flash-free"
            : (result.models || []).find(function (name) {
                return /^opencode\/.+-free$/i.test(name);
            });
        return {
            models: result.models || [],
            defaultModel: preferred || result.defaultModel || "",
            detail: "OpenCode 已连接" + (health && health.version ? " · " + health.version : "")
        };
    }

    async function detect(options, fetchImpl) {
        var provider = options && options.provider === "ollama" ? "ollama"
            : options && options.provider === "openai" ? "openai"
                : "opencode";
        var result = provider === "ollama"
            ? await fetchOllamaModels(options, fetchImpl)
            : provider === "openai"
                ? await fetchOpenAiModels(options, fetchImpl)
                : await fetchOpenCodeModels(options, fetchImpl);
        var unique = Array.from(new Set((result.models || []).filter(Boolean))).sort();
        return {
            provider: provider,
            models: unique,
            defaultModel: result.defaultModel || unique[0] || "",
            detail: result.detail || ""
        };
    }

    var api = {
        safeEndpoint: safeEndpoint,
        authHeaders: authHeaders,
        fetchJson: fetchJson,
        fetchOllamaModels: fetchOllamaModels,
        fetchOpenAiModels: fetchOpenAiModels,
        fetchOpenCodeModels: fetchOpenCodeModels,
        detect: detect
    };

    root.WpsModelCatalog = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
