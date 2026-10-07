(function (root) {
    "use strict";

    var SETTINGS_KEY = "wps_text_proofreading_model_settings_v1";
    var RUNTIME_ENDPOINT_KEY = "wps_text_proofreading_runtime_endpoint_v1";
    var CATALOG_KEY = "wps_text_proofreading_model_catalog_v1";
    var PASSWORD_KEY = "wps_text_proofreading_runtime_password_v1";

    var PROVIDER_IDS = ["ollama", "opencode", "openai"];
    var PROVIDER_DEFAULTS = {
        ollama: { endpoint: "http://127.0.0.1:11434", model: "" },
        opencode: { endpoint: "http://127.0.0.1:4096", model: "opencode/mimo-v2.6-flash-free" },
        openai: { endpoint: "", model: "" }
    };
    // Runtime maps keep the current pane responsive, while durable settings are
    // mirrored to localStorage so provider/model/endpoint/credentials survive WPS restarts.
    var sessionRuntimeEndpoints = Object.create(null);
    var sessionPasswords = Object.create(null);

    function text(value) {
        return String(value == null ? "" : value);
    }

    function storages() {
        var result = [];
        try {
            if (root.localStorage && typeof root.localStorage.getItem === "function" &&
                typeof root.localStorage.setItem === "function") {
                result.push(root.localStorage);
            }
        } catch (error) {
            // 部分 WPS WebView 会禁用页面本地存储。
        }
        try {
            var api = root.WpsNativeDocument;
            var pluginStorage = api && api.getPluginStorage ? api.getPluginStorage() : null;
            if (pluginStorage && typeof pluginStorage.getItem === "function" &&
                typeof pluginStorage.setItem === "function" &&
                result.indexOf(pluginStorage) < 0) {
                result.push(pluginStorage);
            }
        } catch (error) {
            // PluginStorage 仅作为会话同步/旧数据迁移的后备。
        }
        return result;
    }

    function readJson(key) {
        var targets = storages();
        for (var i = 0; i < targets.length; i++) {
            try {
                var parsed = JSON.parse(targets[i].getItem(key) || "null");
                if (!parsed || typeof parsed !== "object") continue;
                // 如果只在旧的 PluginStorage 找到值，立即迁移到持久化 localStorage。
                if (i > 0 && targets[0]) {
                    try { targets[0].setItem(key, JSON.stringify(parsed)); } catch (error) { /* best effort */ }
                }
                return parsed;
            } catch (error) {
                // 继续尝试下一个存储后端。
            }
        }
        return null;
    }

    function writeJson(key, value) {
        var targets = storages();
        var payload = JSON.stringify(value);
        var wrote = false;
        targets.forEach(function (storage) {
            try {
                storage.setItem(key, payload);
                wrote = true;
            } catch (error) {
                // 只要至少一个持久化后端写入成功即可。
            }
        });
        return wrote;
    }

    function hasCredential(url) {
        try {
            var parsed = new URL(url);
            if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
                parsed.username || parsed.password) {
                return true;
            }
            var secret = false;
            parsed.searchParams.forEach(function (unused, key) {
                if (/key|token|secret|password|signature|\bsig\b/i.test(key)) {
                    secret = true;
                }
            });
            if (secret) return true;
            parsed.hash = "";
            return false;
        } catch (error) {
            return true;
        }
    }

    function isLoopback(url) {
        try {
            var hostname = new URL(url).hostname;
            return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
        } catch (error) {
            return false;
        }
    }

    function endpointForStorage(value) {
        var raw = text(value).trim();
        if (!raw || hasCredential(raw)) return "";
        try {
            return new URL(raw).toString().replace(/\/$/, "");
        } catch (error) {
            return "";
        }
    }

    function endpointForRuntime(value) {
        var raw = text(value).trim();
        if (!raw || hasCredential(raw)) return "";
        try {
            return new URL(raw).toString().replace(/\/$/, "");
        } catch (error) {
            return "";
        }
    }

    function safeProfile(candidate, fallback) {
        var value = candidate && typeof candidate === "object" ? candidate : {};
        return {
            endpoint: typeof value.endpoint === "string" && value.endpoint.length < 2048
                ? (endpointForStorage(value.endpoint) || fallback.endpoint)
                : fallback.endpoint,
            model: typeof value.model === "string" && value.model.length < 512
                ? value.model
                : fallback.model
        };
    }

    function normalizeProvider(provider) {
        return PROVIDER_IDS.indexOf(provider) >= 0 ? provider : "";
    }

    function normalizeConcurrency(value) {
        return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 2;
    }

    function loadSettings() {
        var parsed = readJson(SETTINGS_KEY);
        if (!parsed) return null;
        return {
            provider: normalizeProvider(parsed.provider) || "opencode",
            deep: parsed.deep === true,
            concurrency: normalizeConcurrency(parsed.concurrency),
            timingLogs: parsed.timingLogs === true,
            rulesOnly: parsed.rulesOnly === true,
            autoAdvance: parsed.autoAdvance !== false,
            profiles: {
                ollama: safeProfile(parsed.profiles && parsed.profiles.ollama, PROVIDER_DEFAULTS.ollama),
                opencode: safeProfile(parsed.profiles && parsed.profiles.opencode, PROVIDER_DEFAULTS.opencode),
                openai: safeProfile(parsed.profiles && parsed.profiles.openai, PROVIDER_DEFAULTS.openai)
            }
        };
    }

    function defaultSettings() {
        return {
            provider: "opencode",
            deep: false,
            concurrency: 2,
            timingLogs: false,
            rulesOnly: false,
            autoAdvance: true,
            profiles: {
                ollama: Object.assign({}, PROVIDER_DEFAULTS.ollama),
                opencode: Object.assign({}, PROVIDER_DEFAULTS.opencode),
                openai: Object.assign({}, PROVIDER_DEFAULTS.openai)
            }
        };
    }

    function saveSettings(settings) {
        var value = settings && typeof settings === "object" ? settings : defaultSettings();
        var provider = normalizeProvider(value.provider) || "opencode";
        return writeJson(SETTINGS_KEY, {
            provider: provider,
            deep: value.deep === true,
            concurrency: normalizeConcurrency(value.concurrency),
            timingLogs: value.timingLogs === true,
            rulesOnly: value.rulesOnly === true,
            autoAdvance: value.autoAdvance !== false,
            profiles: {
                ollama: safeProfile(value.profiles && value.profiles.ollama, PROVIDER_DEFAULTS.ollama),
                opencode: safeProfile(value.profiles && value.profiles.opencode, PROVIDER_DEFAULTS.opencode),
                openai: safeProfile(value.profiles && value.profiles.openai, PROVIDER_DEFAULTS.openai)
            }
        });
    }

    function updateSettings(patch) {
        var current = loadSettings() || defaultSettings();
        var next = {
            provider: patch && patch.provider != null ? patch.provider : current.provider,
            deep: patch && patch.deep != null ? patch.deep === true : current.deep,
            concurrency: patch && patch.concurrency != null
                ? normalizeConcurrency(patch.concurrency) : current.concurrency,
            timingLogs: patch && patch.timingLogs != null ? patch.timingLogs === true : current.timingLogs,
            rulesOnly: patch && patch.rulesOnly != null ? patch.rulesOnly === true : current.rulesOnly,
            autoAdvance: patch && patch.autoAdvance != null
                ? patch.autoAdvance !== false : current.autoAdvance,
            profiles: Object.assign({}, current.profiles)
        };
        if (patch && patch.profile && normalizeProvider(patch.provider || next.provider)) {
            var target = normalizeProvider(patch.provider || next.provider);
            var profile = patch.profile;
            var sanitizedEndpoint = endpointForStorage(profile.endpoint);
            next.profiles[target] = {
                endpoint: sanitizedEndpoint || (current.profiles[target] || PROVIDER_DEFAULTS[target]).endpoint,
                model: typeof profile.model === "string" && profile.model.length < 512
                    ? profile.model
                    : (current.profiles[target] || PROVIDER_DEFAULTS[target]).model
            };
        }
        next.provider = normalizeProvider(next.provider) || "opencode";
        saveSettings(next);
        return next;
    }

    function loadRuntimeEndpoint(provider) {
        var id = normalizeProvider(provider);
        if (!id) return null;
        var endpoint = endpointForRuntime(sessionRuntimeEndpoints[id]);
        if (!endpoint) return null;
        return { provider: id, endpoint: endpoint };
    }

    function saveRuntimeEndpoint(provider, endpoint) {
        var id = normalizeProvider(provider);
        var value = endpointForRuntime(endpoint);
        if (!id || !value) return false;
        sessionRuntimeEndpoints[id] = value;
        return true;
    }

    function clearRuntimeEndpoint(provider) {
        var id = normalizeProvider(provider);
        if (id) {
            delete sessionRuntimeEndpoints[id];
            return true;
        }
        sessionRuntimeEndpoints = Object.create(null);
        return true;
    }

    function loadCatalog() {
        var parsed = readJson(CATALOG_KEY);
        if (!parsed || !Array.isArray(parsed.models)) return null;
        return {
            provider: normalizeProvider(parsed.provider) || "opencode",
            models: parsed.models.filter(function (name) { return typeof name === "string" && name; }),
            defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : "",
            detail: typeof parsed.detail === "string" ? parsed.detail : "",
            tone: typeof parsed.tone === "string" ? parsed.tone : "idle"
        };
    }

    function saveCatalog(catalog) {
        var value = catalog && typeof catalog === "object" ? catalog : {};
        return writeJson(CATALOG_KEY, {
            provider: normalizeProvider(value.provider) || "opencode",
            models: Array.isArray(value.models) ? value.models.filter(function (name) {
                return typeof name === "string" && name;
            }) : [],
            defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : "",
            detail: typeof value.detail === "string" ? value.detail : "",
            tone: typeof value.tone === "string" ? value.tone : "idle",
            at: Date.now()
        });
    }

    function storedPasswords() {
        var parsed = readJson(PASSWORD_KEY);
        return parsed && typeof parsed === "object" ? parsed : {};
    }

    function loadPassword(provider) {
        var id = normalizeProvider(provider);
        if (id !== "opencode" && id !== "openai") return "";
        if (typeof sessionPasswords[id] === "string") return sessionPasswords[id];
        var saved = storedPasswords();
        return typeof saved[id] === "string" ? saved[id] : "";
    }

    function savePassword(value, provider) {
        var id = normalizeProvider(provider);
        if (id !== "opencode" && id !== "openai") return false;
        var raw = text(value);
        if (raw.length > 2048) return false;
        var saved = storedPasswords();
        if (!raw) {
            delete sessionPasswords[id];
            delete saved[id];
        } else {
            sessionPasswords[id] = raw;
            saved[id] = raw;
        }
        return writeJson(PASSWORD_KEY, saved);
    }

    function clearPassword(provider) {
        var id = normalizeProvider(provider);
        var saved = storedPasswords();
        if (id === "opencode" || id === "openai") {
            delete sessionPasswords[id];
            delete saved[id];
        } else {
            sessionPasswords = Object.create(null);
            saved = {};
        }
        return writeJson(PASSWORD_KEY, saved);
    }

    function clearLegacyStoredValue(key) {
        var targets = storages();
        targets.forEach(function (storage) {
            try {
                if (typeof storage.removeItem === "function") storage.removeItem(key);
                else storage.setItem(key, "null");
            } catch (error) {
                // Best-effort migration cleanup only.
            }
        });
    }

    // Runtime endpoint key is obsolete. Passwords now intentionally persist.
    clearLegacyStoredValue(RUNTIME_ENDPOINT_KEY);

    var api = {
        SETTINGS_KEY: SETTINGS_KEY,
        RUNTIME_ENDPOINT_KEY: RUNTIME_ENDPOINT_KEY,
        CATALOG_KEY: CATALOG_KEY,
        PASSWORD_KEY: PASSWORD_KEY,
        PROVIDER_IDS: PROVIDER_IDS,
        PROVIDER_DEFAULTS: PROVIDER_DEFAULTS,
        endpointForStorage: endpointForStorage,
        endpointForRuntime: endpointForRuntime,
        loadSettings: loadSettings,
        defaultSettings: defaultSettings,
        saveSettings: saveSettings,
        updateSettings: updateSettings,
        loadRuntimeEndpoint: loadRuntimeEndpoint,
        saveRuntimeEndpoint: saveRuntimeEndpoint,
        clearRuntimeEndpoint: clearRuntimeEndpoint,
        loadCatalog: loadCatalog,
        saveCatalog: saveCatalog,
        loadPassword: loadPassword,
        savePassword: savePassword,
        clearPassword: clearPassword
    };

    root.WpsSettingsStore = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
