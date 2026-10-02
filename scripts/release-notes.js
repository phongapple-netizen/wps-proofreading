// Shared release notes generator for the Windows and macOS installer workflows.
const fs = require('node:fs');
const version = require('../package.json').version;
const notes = `Windows 10/11 x64 与 macOS 11 及以上版本的测试安装包。macOS 安装包支持 Intel 和 Apple 芯片。

Windows：运行 Windows-x64-Setup.exe，为当前用户安装，随后重启 WPS。
macOS：打开 macOS.dmg，将应用拖入“应用程序”，打开应用并点击“安装并启动”，随后重启 WPS。

安装包包含 WPS 加载项与本机网页服务，无需 Node.js 或管理员权限。使用 OpenCode 时，请先单独安装 OpenCode；在 WPS 中选择 OpenCode 后，插件会尝试自动发现并启动本机服务。本包不含 OpenCode、其他模型服务或 AI 模型。

当前为未签名测试版。Windows SmartScreen 或 macOS“隐私与安全性”可能提示未知开发者。正式分发前仍需签名及目标电脑上的 WPS 交互验证。

版本：v${version}。Windows 与 macOS 安装包会在版本校验和双平台构建全部通过后，一次性上传到同一个测试版 Release。
`;
fs.writeFileSync('release-notes.md', notes, 'utf8');
