# WPS 智能文稿校对

一个面向 **WPS 文字** 的开源智能校对加载项，重点解决中文长文校对、全文一致性、专业规则检查和安全写回问题。

当前项目支持：

- AI 校对：OpenCode、Ollama、OpenAI 兼容接口；
- 长文自动分批和超长段落安全切分；
- 全文一致性信号索引，按疑似冲突候选组复核跨段落差异；
- 原文精确定位和安全写回；
- 仅限内置低风险标点格式规则的一键修正；
- 自定义规则中心；
- JSON 规则包导入导出；
- 中文基础、公文、安全生产等内置规则包。

## 项目结构

```text
.
├─ index.html
├─ main.js
├─ ribbon.xml
├─ js/
│  ├─ proofreading-core.js
│  ├─ proofreading-integration.js
│  ├─ opencode-client.js
│  ├─ rules-center.js
│  ├─ rules-ui.js
│  ├─ settings-store.js
│  ├─ taskpane.js
│  └─ wps-api.js
├─ ui/
├─ rules/
├─ test/
├─ scripts/
├─ SOURCE_PROVENANCE.md
└─ THIRD_PARTY_NOTICES.md
```

## 本机开发

```bash
npm ci
npm test
npm run debug
```

项目使用 WPS 官方 `wpsjs` / `wps-jsapi` 开发方式。

调试服务默认地址：

```text
http://127.0.0.1:3891
```

### macOS / Mac mini 兼容

面向其他 Mac 的安装包可在 macOS 上构建：

```bash
npm run build:mac:installer
```

安装包生成在 `dist/mac/`，包含 Intel 与 Apple 芯片通用的应用。打开 DMG，按其中的《安装说明》操作。应用会注册 WPS 并启动当前用户的登录服务；目标电脑无需 Node.js 或 npm。OpenCode、Ollama 和兼容模型接口仍由使用者单独配置。当前安装包采用临时签名，正式对外分发需要 Apple 开发者签名和公证。

以下是从项目源码运行的开发流程。

本项目的调试注册脚本支持 macOS，包括 Intel Mac（例如 Mac mini 2014）和 Apple 芯片 Mac。

首次在 Mac 上运行：

```bash
npm ci
npm test
npm run debug:mac
```

脚本会自动识别 WPS Mac 常见加载项目录，包括：

```text
~/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/
~/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/
```

对于较老的非沙盒安装，也会检测：

```text
~/Library/Application Support/Kingsoft/WPS/jsaddons/
```

脚本会更新对应目录中的 `publish.xml`，把当前项目注册为
`http://127.0.0.1:3891/` 的 WPS 文字加载项，同时保留其他已有加载项。

Mac 上注册后需要**完全退出并重新打开 WPS**。首次访问 WPS 沙盒目录时，macOS 可能要求终端获得文件访问权限，请选择允许。

确认手动运行正常后，可安装当前用户的登录自启服务：

```bash
npm run service:mac:install
npm run service:mac:status
```

安装会注册 WPS 加载项，并让插件网页服务和 OpenCode 在登录后自动启动。两个服务只监听本机 `127.0.0.1`；OpenCode 从项目目录启动。无需 `sudo`。运行日志位于 `~/Library/Logs/wps-proofreading/`。如果已经手动运行两个服务，先在对应终端按 `Control+C` 再安装，以免占用端口。移除登录自启：`npm run service:mac:remove`。

如果 WPS 功能区仍未出现“WPS 文本校对”，先启动一次 WPS，让系统创建沙盒目录，然后退出 WPS，再重新执行：

```bash
npm run debug:mac
```

`js/wps-api.js` 本身不依赖 Windows 专用接口，会依次兼容 `window.Application`、`wps.WpsApplication()` 和旧版 `wps` 对象。

## OpenCode

可在本机启动 OpenCode：

```bash
cd ~/wps-proofreading
opencode serve --hostname 127.0.0.1 --port 4096 --cors http://127.0.0.1:3891
```

在任务窗格中选择 OpenCode 并读取可用模型。插件使用内置 `build` 代理，在每个临时校对会话中将全部工具设为必须审批，并核对服务端已启用该限制。插件不会批准工具请求；如果模型请求工具，插件会中止并清理会话。

模型列表读取成功只表示服务已连接，不代表模型允许校对调用。“免费额度仅限 OpenCode 内使用”（HTTP 403）也可能由自定义代理或完全禁用工具引发的兼容性问题导致，不能据此认定免费模型无法用于插件。当前调用方式已在 OpenCode 1.18.32 和 `opencode/mimo-v2.6-flash-free` 上验证。插件中的“OpenCode 服务密码”只用于连接本机服务，不是模型提供商的 API 密钥。

## 校对流程

```text
文档
  ↓
本地确定性规则预检
  ↓
AI核查规则生成候选点
  ↓
AI 分批校对 + 上下文核查
  ↓
本地全文一致性索引 → AI 按候选组分批复核
  ↓
结果合并与去重
  ↓
WPS 精确定位
  ↓
人工确认 / 安全写回
```

全文和长选区按段落分批处理；单个超长段落也会继续按安全边界切分。第二遍先在本地扫描全文，归组机构、政策文件、日期、数字和单位、百分比、标题及事项名称的疑似冲突。没有候选组时跳过第二遍；候选多时按组分批，只发送代表性段落编号和短上下文。数值等价会先归一化；简称与全称等写法仅作为线索，由 AI 结合上下文判断。所有一致性建议都需人工复核，应用前仍会检查文档是否变化。

数值类信号先按去掉数值的上下文归并，再按事项片段分桶；小桶内比较，大桶只比较排序相邻的少量上下文，避免统计密集文稿中对同一单位的所有数值两两计算。机构名称按地域、机构类别和核心字分桶，以通用后缀关系与简称核心字的顺序匹配产生候选。名称类大桶也采用相邻比较降级；极端情况下，排序距离较远但实际相关的写法可能漏掉候选。此过程只筛选核查线索，不直接认定错误。

单批候选数据的序列化 JSON（包含 `candidates` 字段）最多 12,000 字符、16 个候选组；固定的安全提示词另计。过大的候选组会拆为共享基准变体的子组，所有变体仍会送审。如果设置的字符上限连两个变体都容不下，会明确报错，不会超限发送或静默丢弃。

## 安全策略

- 全文校对在第一次模型请求前要求用户明确确认；
- API Key 和服务密码只保留在当前任务窗格会话内存中；
- 应用建议前重新核对原文位置和文档状态；
- 文档内容变化后，旧建议拒绝写入；
- “一键修正”仅处理六条固定的内置标点格式规则；AI 建议、日期、术语、公文和安全生产规则均需逐条确认；
- 规则提醒类结果默认不能直接写入正文；
- AI核查规则只生成候选点，只有模型结合上下文确认后才显示，并始终要求人工复核。
- 模型请求、模型列表读取和 OpenCode 会话清理均设置超时；校对期间不能应用或忽略建议。

## 规则中心

点击任务窗格右上角的齿轮打开设置，再展开“校对规则”。

规则中心支持：

- 新建、编辑、删除、启用和停用规则；
- 固定替换、正则表达式、仅提醒和 AI核查规则；
- 分组、优先级、风险级别；
- 规则来源和说明；
- 低风险内置标点规则是否参与一键修正；
- 当前文档命中测试；
- JSON 规则包导入和导出。

当前提供三个内置规则包：

- 中文及公文基础规范；
- 党政机关公文规则；
- 安全生产专业规则。

首次打开任务窗格会自动安装基础规范规则包。手动清空规则后不会再次自动安装；可在规则中心重新导入。

其中“AI核查规则”用于处理不能靠关键词直接判错的场景。规则只负责触发核查，AI 必须结合当前段落上下文独立判断；触发本身不会生成错误，也不会进入一键修正。

## 代码来源

本项目的早期代码最初位于旧仓库：

https://github.com/phongapple-netizen/wps

其中本项目最初以 `WpsNative/` 子目录形式开发。该目录是在旧仓库继承的 WordOllama 历史之后独立新增的 WPS JavaScript 加载项。

已完成一轮工程来源审计，目前没有发现本项目核心 JavaScript 文件与 WordOllama 或 WPS-AI / 灵犀AI 存在明显的非通用逐行源码复制。

详细记录：

- [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## 上游致谢

感谢以下项目和平台在早期研发过程中提供的公开代码、产品思路或平台能力：

- WordOllama Community Edition
- WPS-AI / 灵犀AI
- WPS 开放平台

本项目为第三方开源加载项，不代表金山办公官方产品，也不表示获得其官方背书。

## 许可证

当前独立仓库采用 **GNU GPL v3**。

详见 [LICENSE](LICENSE)。

后续如果需要调整许可证，会先重新核对代码来源、第三方依赖和外部贡献记录。

## 项目状态

当前仍属于持续开发阶段。已提供 macOS 测试安装包；尚未发布经过 Apple 公证、面向普通用户的正式版本。Windows 安装包尚未制作。
