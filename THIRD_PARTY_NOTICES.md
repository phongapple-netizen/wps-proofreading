# 上游项目与第三方致谢

本项目是面向 WPS 文字的智能文稿校对加载项。早期研发过程中参考了多个开源项目和公开平台能力。

## WordOllama Community Edition

项目地址：https://github.com/ByronLeeeee/wordollama-community

WordOllama Community Edition 使用 GNU GPL v3。

本项目的历史开发仓库曾继承 WordOllama Community Edition 的 Git 历史，但当前独立仓库只迁移原
`WpsNative/` 的 WPS JavaScript 加载项代码，不包含 `WordOllama/` 的 C# / VSTO 源码。

工程来源审计未发现当前核心 JavaScript 文件直接复制 WordOllama C# 校对实现的明显证据。

## WPS-AI / 灵犀AI

项目地址：https://github.com/lewis-hui1202/WPS-AI

WPS-AI 使用 MIT License。

原版权声明：

Copyright (c) 2026 灵犀AI (WPS-AI · llteac.cn)

本项目研发过程中参考过其 WPS JavaScript 加载项、跨平台集成和 AI 办公助手的产品思路。
当前工程审计未发现本项目核心文件与 WPS-AI 代表性核心文件之间存在明显的非通用逐行源码复制。

若未来直接引入或改写 WPS-AI 的 MIT 源码，将在对应文件或发行包中保留适用的 MIT 版权和许可声明。

## WPS Office / 金山办公

WPS Office、WPS 开放平台、`wpsjs`、`wps-jsapi` 及相关名称、商标和平台能力归相应权利人所有。

本项目为第三方开源加载项，不代表金山办公官方产品，也不表示获得金山办公官方背书或合作授权。

## 模型与外部服务

OpenCode、Ollama、OpenAI-compatible API 以及用户自行配置的其他模型服务均属于外部软件或服务。
用户应分别遵守其许可证、服务条款、隐私政策和数据处理要求。

## 许可证

当前独立仓库采用 GNU GPL v3。详见根目录 `LICENSE`。
