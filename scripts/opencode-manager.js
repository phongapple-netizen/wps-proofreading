"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function discoverExecutable(env = process.env, home = os.homedir()) {
    const directories = [...(env.PATH || "").split(path.delimiter),
        path.join(home, ".opencode", "bin"), path.join(home, ".local", "bin"),
        path.join(home, "bin"), path.join(home, ".npm-global", "bin"),
        "/opt/homebrew/bin", "/usr/local/bin", env.APPDATA && path.join(env.APPDATA, "npm")];
    const names = process.platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
    for (const directory of new Set(directories.filter(Boolean))) {
        for (const name of names) {
            const candidate = path.join(directory, name);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch (_) { /* Continue searching common installation locations. */ }
        }
    }
    return null;
}

function probeHealth() {
    return new Promise((resolve) => {
        let settled = false;
        function finish(result) { if (!settled) { settled = true; resolve(result); } }
        const request = http.get({ host: "127.0.0.1", port: 4096, path: "/global/health" }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
                if (body.length > 65536) request.destroy();
            });
            response.on("error", () => finish({ state: "port_conflict" }));
            response.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    if (response.statusCode === 200 && data.healthy === true && typeof data.version === "string" && data.version) {
                        finish({ state: "ready", version: data.version });
                        return;
                    }
                } catch (_) { /* A different service may own the port. */ }
                finish({ state: "port_conflict" });
            });
        });
        const deadline = setTimeout(() => request.destroy(), 1500);
        request.on("close", () => clearTimeout(deadline));
        request.on("error", (error) => finish({ state: error.code === "ECONNREFUSED" ? "absent" : "port_conflict" }));
    });
}

function createManager(options = {}) {
    const discover = options.discover || discoverExecutable;
    const probe = options.probe || probeHealth;
    const spawnProcess = options.spawn || spawn;
    const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const timeout = options.timeout || 20000;
    let child = null;
    let starting = null;

    async function status() {
        const health = await probe();
        if (health.state === "ready") return { ...health, found: true, managed: !!child };
        const executable = discover();
        return { state: health.state === "port_conflict" ? "port_conflict" : executable ? "stopped" : "missing",
            found: !!executable, managed: !!child };
    }

    async function startOnce() {
        const current = await status();
        if (current.state !== "stopped") return current;
        const executable = discover();
        if (!executable) return { state: "missing", found: false, managed: false };
        const args = ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--cors", "http://127.0.0.1:3891"];
        let command = executable;
        let commandArgs = args;
        if (process.platform === "win32" && /\.cmd$/i.test(executable)) {
            if (/["%&|<>^!\r\n]/.test(executable)) return { state: "error", detail: "OpenCode 安装路径包含不支持的字符。" };
            command = process.env.ComSpec || "cmd.exe";
            commandArgs = ["/d", "/s", "/c", '""' + executable + '" ' + args.join(" ") + '"'];
        }
        let run;
        let exited = false;
        try {
            run = spawnProcess(command, commandArgs, {
                cwd: path.resolve(__dirname, ".."),
                env: { ...process.env, PATH: path.dirname(executable) + path.delimiter + (process.env.PATH || "") },
                stdio: "ignore", windowsHide: true
            });
            child = run;
            const onExit = () => { exited = true; if (child === run) child = null; };
            run.once("error", onExit);
            run.once("exit", onExit);
            run.unref();
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const health = await probe();
                if (health.state === "ready") return { ...health, found: true, managed: child === run };
                if (exited) return { state: "error", found: true, managed: false,
                    detail: "OpenCode 启动进程已提前退出。请检查 OpenCode 安装和配置。" };
                await pause(250);
            }
        } catch (_) { /* Return a bounded startup failure below. */ }
        if (run && child === run) { run.kill(); child = null; }
        return { state: "error", found: true, managed: false, detail: "OpenCode 启动超时，请重试。" };
    }

    function start() {
        if (!starting) starting = startOnce().finally(() => { starting = null; });
        return starting;
    }
    return { status, start };
}

module.exports = { discoverExecutable, probeHealth, createManager };
