"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { registerPlugin } = require("./dev-server");

const projectRoot = path.resolve(__dirname, "..");
const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
const logs = path.join(os.homedir(), "Library", "Logs", "wps-proofreading");
const services = [
    { label: "net.wps-proofreading.web", name: "web" },
    { label: "net.wps-proofreading.opencode", name: "opencode" }
];

function xml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function array(values) {
    return "<array>" + values.map((value) => "<string>" + xml(value) + "</string>").join("") + "</array>";
}

function plist(service, command, environment) {
    const env = Object.entries(environment).map(([name, value]) =>
        "<key>" + xml(name) + "</key><string>" + xml(value) + "</string>").join("");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        '<key>Label</key><string>' + xml(service.label) + '</string>' +
        '<key>ProgramArguments</key>' + array(command) +
        '<key>WorkingDirectory</key><string>' + xml(projectRoot) + '</string>' +
        '<key>EnvironmentVariables</key><dict>' + env + '</dict>' +
        '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' +
        '<key>StandardOutPath</key><string>' + xml(path.join(logs, service.name + ".log")) + '</string>' +
        '<key>StandardErrorPath</key><string>' + xml(path.join(logs, service.name + ".error.log")) + '</string>' +
        '</dict></plist>\n';
}

function launchctl(args, quiet) {
    try {
        return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: quiet ? "ignore" : "pipe" });
    } catch (error) {
        if (quiet) return "";
        throw new Error("launchctl " + args[0] + " 失败：" + String(error.stderr || error.message).trim());
    }
}

function plistPath(service) {
    return path.join(launchAgents, service.label + ".plist");
}

function install() {
    const opencode = execFileSync("/usr/bin/which", ["opencode"], { encoding: "utf8" }).trim();
    if (!opencode || !fs.existsSync(opencode)) throw new Error("请先安装 OpenCode 并确认 opencode 在 PATH 中。");
    const registered = registerPlugin();
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    const env = {
        PATH: [path.dirname(process.execPath), path.dirname(opencode), "/usr/local/bin", "/usr/bin", "/bin"]
            .filter((item, index, items) => items.indexOf(item) === index).join(":"),
        OPENCODE_CONFIG: path.join(projectRoot, "opencode.json")
    };
    const commands = [
        [process.execPath, path.join(projectRoot, "scripts", "dev-server.js"), "--port", "3891", "--no-register"],
        [opencode, "serve", "--hostname", "127.0.0.1", "--port", "4096", "--cors", "http://127.0.0.1:3891"]
    ];
    services.forEach((service, index) => {
        const target = plistPath(service);
        fs.writeFileSync(target, plist(service, commands[index], env), { mode: 0o600 });
        fs.chmodSync(target, 0o600);
        launchctl(["bootout", "gui/" + process.getuid(), target], true);
        launchctl(["bootstrap", "gui/" + process.getuid(), target]);
    });
    console.log("已注册 WPS：" + registered.join("、"));
    console.log("已安装登录自启服务：" + services.map((service) => service.label).join("、"));
    console.log("日志：" + logs);
}

function remove() {
    services.forEach((service) => {
        const target = plistPath(service);
        if (!fs.existsSync(target)) return;
        launchctl(["bootout", "gui/" + process.getuid(), target], true);
        fs.unlinkSync(target);
    });
    console.log("已移除登录自启服务。WPS 注册项仍保留，可用 npm run debug:mac 手动启动。");
}

function status() {
    const result = launchctl(["list"]);
    services.forEach((service) => {
        const installed = fs.existsSync(plistPath(service));
        const running = result.split("\n").some((line) => line.endsWith("\t" + service.label));
        console.log(service.label + "：" + (running ? "已加载" : installed ? "已安装但未加载" : "未安装"));
    });
}

if (require.main === module) {
    try {
        if (process.platform !== "darwin") throw new Error("此命令仅支持 macOS。");
        const action = process.argv[2] || "status";
        if (action === "install") install();
        else if (action === "remove") remove();
        else if (action === "status") status();
        else throw new Error("用法：node scripts/mac-service.js install|status|remove");
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { plist, services, plistPath };
