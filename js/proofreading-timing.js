(function (root) {
    "use strict";
    var enabled = false, generation = 0, records = [];
    var MAX_RECORDS = 500;
    // Numeric whitelist only: never retain options, prompts, responses or errors.
    var FIELDS = ["kind", "run", "stage", "batch", "attempt", "characters", "concurrency",
        "outcome", "connectionMs", "createSessionMs", "messageMs", "cleanupMs",
        "requestMs", "batchMs", "totalMs", "pollCount", "pollMs"];
    function clock() {
        return root.performance && typeof root.performance.now === "function"
            ? root.performance.now() : Date.now();
    }
    function numericFields(value) {
        var result = {};
        FIELDS.forEach(function (key) {
            if (value && typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) {
                result[key] = Math.round(value[key] * 100) / 100;
            }
        });
        return result;
    }
    function setEnabled(value) {
        if (enabled !== (value === true)) generation++;
        enabled = value === true;
    }
    function start(fields) {
        if (!enabled) return null;
        return { fields: numericFields(fields), started: clock(), generation: generation, finished: false };
    }
    function finish(token, metrics) {
        if (!token || token.finished) return;
        token.finished = true;
        if (!enabled || token.generation !== generation) return;
        var record = Object.assign({}, token.fields, numericFields(metrics));
        var key = record.kind === 1 ? "requestMs" : record.kind === 2 ? "batchMs" : "totalMs";
        record[key] = Math.round(Math.max(0, clock() - token.started) * 100) / 100;
        records.push(record);
        if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
        try {
            if (typeof root.refreshProofreadingTiming === "function") root.refreshProofreadingTiming();
        } catch (error) { /* Diagnostics must not affect proofreading. */ }
    }
    var api = {
        clock: clock, setEnabled: setEnabled, start: start, finish: finish,
        entries: function () { return records.map(function (record) { return Object.assign({}, record); }); },
        clear: function () { generation++; records = []; }, maxRecords: MAX_RECORDS
    };
    root.WpsProofreadingTiming = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
