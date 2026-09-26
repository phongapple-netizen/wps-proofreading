"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const host = "127.0.0.1";
const portArgument = process.argv.indexOf("--port");
const parsedPort = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 3891;
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3891;
const projectRoot = path.resolve(__dirname, "..");
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

function registerPlugin() {
    const appData = process.env.APPDATA;
    if (!appData) {
        throw new Error("找不到 Windows APPDATA，无法注册 WPS 调试加载项。");
    }

    const publishPath = path.join(appData, "kingsoft", "wps", "jsaddons", "publish.xml");
    fs.mkdirSync(path.dirname(publishPath), { recursive: true });
    let xml = fs.existsSync(publishPath)
        ? fs.readFileSync(publishPath, "utf8")
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<jsplugins>\r\n</jsplugins>\r\n';
    const original = xml;
    xml = xml.replace(
        /\s*<jspluginonline\b[^>]*\bname=["'](?:wps-text-proofreading|wordollama-wps-native)["'][^>]*\/>/gi,
        ""
    );

    const entry = [
        "  <jspluginonline",
        ' name="' + packageInfo.name + '"',
        ' type="' + (packageInfo.addonType || "wps") + '"',
        ' url="http://' + host + ":" + port + '/"',
        ' debug="" enable="enable_dev" install="null"/>'
    ].join("");
    if (/<\/jsplugins>\s*$/i.test(xml)) {
        xml = xml.replace(/\s*<\/jsplugins>\s*$/i, "\r\n" + entry + "\r\n</jsplugins>\r\n");
    } else {
        xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<jsplugins>\r\n' +
            entry + "\r\n</jsplugins>\r\n";
    }

    if (xml !== original) {
        if (fs.existsSync(publishPath)) {
            fs.copyFileSync(publishPath, publishPath + ".wps-text-proofreading.bak");
        }
        fs.writeFileSync(publishPath, xml, "utf8");
    }
    return publishPath;
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
    const target = path.resolve(projectRoot, "." + pathname.replace(/\//g, path.sep));
    if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) return null;
    return target;
}

function createServer() {
    return http.createServer((request, response) => {
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

try {
    const publishPath = registerPlugin();
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
        console.log("WPS 文本校对已注册：" + publishPath);
        console.log("本机调试服务：http://" + host + ":" + port);
        console.log("若 WPS 已打开，请关闭旧任务窗格后重新打开；首次注册需重启 WPS。");
    });
} catch (error) {
    console.error(error && error.message ? error.message : "WPS 调试加载项注册失败。");
    process.exit(1);
}
