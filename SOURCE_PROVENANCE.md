# 代码来源审计记录

> 审计日期：2026-09-26  
> 当前仓库：https://github.com/phongapple-netizen/wps-proofreading  
> 历史仓库：https://github.com/phongapple-netizen/wps

## 结论摘要

本项目最初在旧仓库 `phongapple-netizen/wps` 的 `WpsNative/` 子目录中开发。

旧仓库本身明确继承自 WordOllama Community Edition 的 Git 历史，但 `WpsNative/` 并不存在于 WordOllama 的上游历史中。
`WpsNative/` 的第一批文件由提交
`228ceeb7cef20935757de05637c7c0d16ba6011d`
于 2026-09-25 整体新增，随后设置存储、规则中心、规则包等继续独立演进。

本次工程审计未发现本项目核心 JavaScript 文件与以下项目存在明显的、非通用模板性质的逐行源码复制：

- WordOllama Community Edition（GPL-3.0）
- WPS-AI / 灵犀AI（MIT）

发现的相同内容主要是 WPS/Office CustomUI 标准 XML 声明和平台接口通用写法。

这是一份工程来源审计，不是法律意见，也不构成最终著作权鉴定。

## 历史关系

旧仓库 `phongapple-netizen/wps` 的 Git 历史中包含 WordOllama Community Edition 的提交
`6780afe059d134e1f65e2b256fde41223bdf2e9f`。

因此：

- 旧仓库中的 `WordOllama/`、`WordOllama.sln` 属于明确的上游历史链路；
- 本仓库只迁移原 `WpsNative/` 的独立 WPS JavaScript 加载项代码；
- 本仓库不包含旧仓库 `WordOllama/` 中的 C# / VSTO 源码和资源。

## 主要来源节点

### 2026-09-25：原生加载项初始版本

首次提交：`228ceeb7cef20935757de05637c7c0d16ba6011d`

首次新增的主要文件包括：

- `index.html`
- `main.js`
- `ribbon.xml`
- `js/opencode-client.js`
- `js/proofreading-core.js`
- `js/proofreading-integration.js`
- `js/ribbon.js`
- `js/taskpane.js`
- `js/util.js`
- `js/wps-api.js`
- `scripts/dev-server.js`
- `ui/taskpane.html`
- `ui/taskpane.css`
- 对应测试文件

### 2026-09-26：设置与模型目录

提交：`1a3b2eecaf00b2cbaa63ab985f71838ce5b899fd`

新增：

- `js/model-catalog.js`
- `js/settings-store.js`

### 2026-09-26：规则中心

提交：`b0d6dd9d4c39fad902af6f9b9975db3e5af66b93`

新增：

- `js/rules-center.js`
- `js/rules-ui.js`
- `test/rules-center.test.js`

### 2026-09-26：内置规则包

提交：`ee434b95086bcd9df4babbef4f448c86a6141b11`

新增：

- `rules/catalog.json`
- `rules/chinese-writing-basic.json`
- `rules/party-government-document.json`
- `rules/work-safety.json`
- `test/rule-packs.test.js`

## 与 WPS-AI / 灵犀AI 的检查

检查过的代表文件包括：

- `plugin/main.js`
- `plugin/js/wps.js`
- `plugin/js/wps-addon-adapter.js`
- `plugin/js/proofread.js`
- `plugin/js/store.js`
- `plugin/js/ribbon-callbacks.generated.js`
- `plugin/ribbon.xml`

对初始 WPS JavaScript 核心文件做规范化逐行比较时，没有发现非通用模板性质的明显复制。

以下本项目特征标识在 WPS-AI 代码搜索中未命中：

- `WpsNativeDocument`
- `requestProofreadingModel`
- `captureSnapshot`
- `defaultBatchCharacters`
- `buildConsistencyPrompt`

当前证据更支持“架构或产品思路参考”，而不是“直接复制核心源码”。

## 与 WordOllama 校对实现的检查

对本项目：

- `js/opencode-client.js`
- `js/proofreading-core.js`
- `js/proofreading-integration.js`
- `js/taskpane.js`

与旧仓库同期 WordOllama 的：

- `WordOllama/lib/Providers/OpenCodeProvider.cs`
- `WordOllama/NewUI/ProofreadingService.cs`
- `WordOllama/NewUI/AgentTaskPaneUI.xaml.cs`

做规范化逐行比较，没有发现非平凡完全相同行。

## 外部依赖

项目使用 WPS 官方开发依赖：

- `wpsjs`
- `wps-jsapi`

同时通过公开 HTTP 接口兼容 OpenCode、Ollama 和 OpenAI-compatible 服务。

## 后续贡献要求

未来引入第三方代码时，应记录来源、许可证和修改情况。不要把来源不清楚的代码直接复制进本仓库。
