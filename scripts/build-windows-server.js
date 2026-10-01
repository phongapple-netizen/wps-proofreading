"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist", "windows");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wps-windows-build-"));

try {
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.join(staging, "assets"));
    for (const name of ["go.mod", "main.go"]) {
        fs.copyFileSync(path.join(root, "windows", name), path.join(staging, name));
    }
    for (const name of ["index.html", "main.js", "ribbon.xml", "package.json"]) {
        fs.copyFileSync(path.join(root, name), path.join(staging, "assets", name));
    }
    for (const name of ["js", "ui", "rules"]) {
        fs.cpSync(path.join(root, name), path.join(staging, "assets", name), { recursive: true });
    }
    const binary = path.join(output, "WPSProofreadingServer.exe");
    const result = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w -H=windowsgui", "-o", binary, "."], {
        cwd: staging,
        env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
        stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
    else console.log(binary);
} finally {
    fs.rmSync(staging, { recursive: true, force: true });
}
