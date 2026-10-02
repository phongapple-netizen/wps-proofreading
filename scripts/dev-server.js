"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createManager } = require("./opencode-manager");

const host = "127.0.0.1";
const portArgument = process.argv.indexOf("--port");
const parsedPort = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 3891;
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3891;
const projectRoot = path.resolve(__dirname, "..");
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

function windowsPublishPath(env) {
    const appData = env && env.APPDATA;
    if (!appData) {
        throw new Error("找不到 Windows APPDATA，无法注册 WPS 调试加载项。");
    }
    return path.join(appData, "kingsoft", "wps", "jsaddons", "publish.xml");
}

function macPublishCandidates(homeDir) {
    return [
        path.join(
            homeDir,
            "Library", "Containers", "com.kingsoft.wpsoffice.mac",
            "Data", ".kingsoft", "wps", "jsaddons", "publish.xml"
        ),
        path.join(
            homeDir,
            "Library", "Containers", "com.kingsoft.wpsoffice.mac.global",
            "Data", ".kingsoft", "wps", "jsaddons", "publish.xml"
        ),
        path.join(
            homeDir,
            "Library", "Application Support", "Kingsoft", "WPS",
            "jsaddons", "publish.xml"
        )
    ];
}

function linuxPublishPath(homeDir) {
    return path.join(homeDir, ".local", "share", "Kingsoft", "wps", "jsaddons", "publish.xml");
}

function candidateLooksInstalled(candidate, fsImpl) {
    const jsaddonsDir = path.dirname(candidate);
    const containerOrSupportRoot = candidate.includes(path.join("Library", "Containers"))
        ? candidate.slice(0, candidate.indexOf(path.join("Data", ".kingsoft")))
        : path.dirname(path.dirname(jsaddonsDir));
    return fsImpl.existsSync(candidate) ||
        fsImpl.existsSync(jsaddonsDir) ||
        fsImpl.existsSync(containerOrSupportRoot);
}

function resolvePublishPaths(options) {
    const settings = options || {};
    const platform = settings.platform || process.platform;
    const env = settings.env || process.env;
    const homeDir = settings.homeDir || os.homedir();
    const fsImpl = settings.fsImpl || fs;

    if (platform === "win32") {
        return [windowsPublishPath(env)];
    }

    if (platform === "darwin") {
        const candidates = macPublishCandidates(homeDir);
        const existing = candidates.filter((candidate) => candidateLooksInstalled(candidate, fsImpl));
        // WPS 尚未启动过时沙盒目录可能不存在；默认创建普通 mac 沙盒路径。
        return existing.length ? existing : [candidates[0]];
    }

    if (platform === "linux") {
        return [linuxPublishPath(homeDir)];
    }

    throw new Error("当前系统暂不支持自动注册 WPS 调试加载项：" + platform);
}

function pluginEntry() {
    return [
        "  <jspluginonline",
        ' name="' + packageInfo.name + '"',
        ' type="' + (packageInfo.addonType || "wps") + '"',
        ' url="http://' + host + ":" + port + '/"',
        ' debug="" enable="enable_dev" install="null"/>'
    ].join("");
}

function updatePublishXml(currentXml) {
    let xml = currentXml ||
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<jsplugins>\n</jsplugins>\n';
    xml = xml.replace(
        /\s*<jspluginonline\b[^>]*\bname=["'](?:wps-text-proofreading|wordollama-wps-native)["'][^>]*\/>/gi,
        ""
    );
    const entry = pluginEntry();

    if (/<\/jsplugins>\s*$/i.test(xml)) {
        return xml.replace(/\s*<\/jsplugins>\s*$/i, "\n" + entry + "\n</jsplugins>\n");
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<jsplugins>\n' +
        entry + "\n</jsplugins>\n";
}

function registerPlugin(options) {
    const settings = options || {};
    const fsImpl = settings.fsImpl || fs;
    const publishPaths = resolvePublishPaths(settings);
    const written = [];

    publishPaths.forEach((publishPath) => {
        fsImpl.mkdirSync(path.dirname(publishPath), { recursive: true });
        const original = fsImpl.existsSync(publishPath)
            ? fsImpl.readFileSync(publishPath, "utf8")
            : "";
        const xml = updatePublishXml(original);

        if (xml !== original) {
            if (original) {
                fsImpl.copyFileSync(publishPath, publishPath + ".wps-text-proofreading.bak");
            }
            fsImpl.writeFileSync(publishPath, xml, "utf8");
        }
        written.push(publishPath);
    });

    return written;
}

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8"
};

function resolveRequestPath(requestUrl) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(requestUrl, "http://" + host).pathname);
    } catch (error) {
        return null;
    }
    if (pathname === "/") pathname = "/index.html";
    const publicRoot = pathname.split("/")[1];
    const publicFiles = new Set(["index.html", "main.js", "ribbon.xml", "package.json"]);
    const publicDirectories = new Set(["ui", "js", "rules"]);
    if (!publicFiles.has(publicRoot) && !publicDirectories.has(publicRoot)) return null;
    if (pathname.split("/").some((part) => part.startsWith("."))) return null;
    if (!/\.(?:html|css|js|json|xml)$/i.test(pathname)) return null;
    const target = path.resolve(projectRoot, "." + pathname.replace(/\//g, path.sep));
    if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) return null;
    return target;
}

function createServer(options = {}) {
    const serverPort = options.port || port;
    const manager = options.manager || createManager();
    return http.createServer(async (request, response) => {
        if (request.headers.host !== host + ":" + serverPort) {
            response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Forbidden");
            return;
        }
        let pathname;
        try { pathname = new URL(request.url || "/", "http://" + host).pathname; }
        catch (_) { response.writeHead(400); response.end(); return; }
        if (pathname === "/api/opencode/status" || pathname === "/api/opencode/start") {
            const startRequest = pathname.endsWith("/start");
            if (request.method !== (startRequest ? "POST" : "GET")) {
                response.writeHead(405); response.end(); return;
            }
            if (startRequest && (request.headers.origin !== "http://" + host + ":" + serverPort ||
                request.headers["sec-fetch-site"] === "cross-site" || request.headers["transfer-encoding"] ||
                Number(request.headers["content-length"] || 0) !== 0)) {
                response.writeHead(403); response.end(); return;
            }
            try {
                const result = await (startRequest ? manager.start() : manager.status());
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                response.end(JSON.stringify(result));
            } catch (_) {
                response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ state: "error", detail: "本机服务检测失败，请重试。" }));
            }
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Method Not Allowed");
            return;
        }

        const target = resolveRequestPath(request.url || "/");
        if (!target) {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Bad Request");
            return;
        }

        fs.stat(target, (statError, stat) => {
            if (statError || !stat.isFile()) {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Not Found");
                return;
            }
            response.writeHead(200, {
                "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
                "Cache-Control": "no-store"
            });
            if (request.method === "HEAD") {
                response.end();
                return;
            }
            fs.createReadStream(target).pipe(response);
        });
    });
}

function verifyExistingServer() {
    http.get({ host, port, path: "/package.json", timeout: 1500 }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
            try {
                const runningPackage = JSON.parse(body);
                if (runningPackage.name === packageInfo.name) {
                    console.log("WPS 文本校对调试服务已在 http://" + host + ":" + port + " 运行。");
                    process.exit(0);
                }
            } catch (error) {
                // 下面给出明确的端口占用提示。
            }
            console.error("端口 " + port + " 已被其他程序占用。");
            process.exit(1);
        });
    }).on("error", () => {
        console.error("端口 " + port + " 已被占用，但无法确认现有服务。");
        process.exit(1);
    });
}

function platformLabel() {
    if (process.platform === "darwin") {
        return "macOS " + process.arch;
    }
    if (process.platform === "win32") return "Windows";
    if (process.platform === "linux") return "Linux";
    return process.platform;
}

function start() {
    try {
        const publishPaths = process.argv.includes("--no-register") ? [] : registerPlugin();
        const server = createServer();
        server.on("error", (error) => {
            if (error && error.code === "EADDRINUSE") {
                verifyExistingServer();
                return;
            }
            console.error("调试服务启动失败。");
            process.exit(1);
        });
        server.listen(port, host, () => {
            console.log("运行平台：" + platformLabel());
            publishPaths.forEach((publishPath) => {
                console.log("WPS 文本校对已注册：" + publishPath);
            });
            console.log("本机调试服务：http://" + host + ":" + port);
            if (process.platform === "darwin") {
                console.log("Mac 首次写入 WPS 沙盒目录时，系统可能要求终端获得文件访问权限，请选择允许。");
                console.log("注册后请完全退出并重新打开 WPS；若功能区仍未出现，请先启动一次 WPS 再重新运行 npm run debug。");
            } else {
                console.log("若 WPS 已打开，请关闭旧任务窗格后重新打开；首次注册需重启 WPS。");
            }
        });
    } catch (error) {
        console.error(error && error.message ? error.message : "WPS 调试加载项注册失败。");
        process.exit(1);
    }
}

module.exports = {
    windowsPublishPath,
    macPublishCandidates,
    linuxPublishPath,
    resolvePublishPaths,
    updatePublishXml,
    registerPlugin,
    createServer,
    resolveRequestPath
};

if (require.main === module) {
    start();
}
