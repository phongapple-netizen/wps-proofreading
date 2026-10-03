# 性能优化 V1

基于 `main` 的 `e3c7640`，分支 `codex/performance-v1`。规则语义、校对标准、Prompt、映射原则、文档隔离与发布流程保持原有设计；未加入缓存或流式协议。

## 诊断与实验入口

开发主机 localhost / 127.0.0.1 / [::1] 默认输出每次运行的一份 `proofreading perf:` 报告；正式主机默认关闭。可用 `window.WpsProofreadingPerf = true/false` 开启或关闭。报告只包含固定字段和数值，不包含文档身份、正文、建议、Prompt、模型回复或凭据。`firstResultMs` 是首次发布本地发现或首个完整 AI 批次结果的时间（空结果也计入）。`firstPassMs` 从运行开始至正文第一遍完成，`consistencyMs` 为一致性阶段时间，`totalMs` 包含读取和确认等待。取消或失败的未完成阶段可为 0；每批 requestMs 包含传输和读取回复，不是模型纯推理时间。publishRenderMs 为同步 merge / 发布 / DOM 更新，不包含浏览器下一帧绘制。

`window.WpsProofreadingConcurrency = 2` 是本轮开发实验入口。仅数值 2 启用双路；未设置、1、4 或字符串均回退到 1。调度器不超过两个在途正文请求，一致性仍串行。OpenCode 每个请求使用独立临时 session，共享运行取消信号。任一失败停止发起新批次并取消兄弟请求；已发布成功结果保留。

快速首批常量集中在 proofreading-core.js：1000 字首批装箱目标，后续 2500 字。安全 segmentation 始终使用原 2500 字规则，因此较长首段可能超过 1000 字。正文所有非空段落的字符与位置完整覆盖；原本排除的空白段落、换行不额外发送。

## 串行 baseline 与模拟比较

所有下表数据都是 Node VM 中模拟 WPS 接口 + 人为延迟模型的自动化测量。**本轮没有真实 WPS + OpenCode + 模型耗时实测，不能将这些数字作为实际提速承诺。** 原串行埋点提交生成的 baseline 已保留在 [performance-v1-baseline.json](performance-v1-baseline.json)，V1 比较在 [performance-v1-comparison.json](performance-v1-comparison.json)。夹具为约 9600 字、24 个正常段落，无本地规则或一致性候选；两个 mock 分别允许独立响应与串行排队。单批延迟为 15ms + Prompt 字符数 / 100。

|实现 / 模拟后端|并发|总耗时 ms|首结果 ms|平均 requestMs|正文批次|
|---|---:|---:|---:|---:|---:|
|原串行 / 独立响应|1|255.66|67.30|62.71|4|
|V1 / 独立响应|1|276.47|41.99|54.24|5|
|V1 / 独立响应|2|156.15|44.87|50.71|5|
|V1 / 排队|1|274.64|41.82|54.03|5|
|V1 / 排队|2|281.25|46.64|101.56|5|

基线 JSON 另含 snapshotCaptureMs、localRulesMs、各批解析映射、完整 snapshot 校验、发布耗时，以及 firstPassMs / consistencyMs。VM 的文档读取与 DOM 并不代表 COM 桥接或真实浏览器渲染成本；本例 consistencyMs=0，因为未生成复核候选。单次计时有调度噪声，不具有统计显著性。

不建议默认启用并发 2：模拟独立响应可缩短总耗时，但首结果未优于 V1 串行，排队后端还增加总耗时及请求等待。需要在同一真实 WPS 文档、provider/model/规则、网络环境下重复测量并发 1/2，确认准确性与后端收益，再另行决定。更小首批增加了请求数，可能增加总耗时。

可重复实验（PowerShell，在仓库根目录）：

```powershell
$env:WPS_PERF_REPORT = 'docs/performance-v1-comparison.json'
node --experimental-test-isolation=none --test test/proofreading-integration.test.js
Remove-Item Env:WPS_PERF_REPORT
```

原 baseline 必须在埋点提交 `4bbd6b0` 上测量（该提交未改批次或调度），设置 WPS_PERF_BASELINE=1；在 V1 提交上设置此变量只能测 V1 串行，不能重建旧算法 baseline。避免覆盖保存的原 baseline。

## 正文安全与剩余瓶颈

运行中可忽略完整结果，并以 run 内 ID 状态覆盖保留 ignored，后续 merge 不恢复 pending。正文第一遍未完成时写入仍锁定。正文第一遍全部完成后，修正 / 撤销 / 安全格式批量修正可用；保存规则和改写继续按原 busy 锁定。第一次写入前额外完整验证运行 snapshot，立即取消一致性请求、移除发布所有权；忽略 abort 的旧响应不能更新新的 snapshot 或状态。状态提示明确说明复核停止。普通已结束运行仍保留现有逐条锚点与延迟写后校验，批量保留原完整验证。

本轮保留逐批全文 snapshot 检查。文档长度和选区边界不能检测等长编辑；用当前全文重新 fingerprint 仍需全文读取；现有 WPS 适配层没有已验证的可靠内容版本号或覆盖全部编辑路径的事件。不能用抽样、局部校验或时间节流代替全文检查。主要瓶颈仍可能是模型响应/后端排队、逐批 COM 全文读取，以及一致性候选生成和模型复核。真实成本由新增埋点观察后再决定。

问题卡以稳定 ID 复用；未变化卡片保持 DOM、事件与展开状态，状态变化局部更新，正文顺序由 integration 排序。性能回归测试覆盖 120 卡片的复用、追加、状态变化和事件；这证明操作数量与状态行为，未测真实 WPS 渲染帧率。

## 验证结果

原 main 全套 322 项通过。V1 全套 `node --experimental-test-isolation=none --test`：338 项，337 通过、0 失败、1 个性能实验默认跳过。启用 WPS_PERF_REPORT 的正文/core/OpenCode 定向运行：197 项全部通过（该次运行在后续补充跨文档/等长修改/UI测试之前）。最终 UI 定向 39 项全部通过。`git diff --check` 无空白错误。隔离模式关闭是本机测试进程创建限制的运行方式，并未改变业务代码。

新增覆盖诊断隐私/默认关闭、busy 忽略/写入锁、快速首批与精确覆盖、并发 1/2 上限和乱序 ID/排序/字数进度、取消所有在途请求、重启丢弃旧结果、失败保留成功结果、OpenCode 双独立 session 清理、第一遍完成解锁、一致性修改取消及等长远处编辑拒绝、跨文档结果隔离，以及 120 卡片局部 DOM 与菜单 Escape 行为。真实 WPS 与真实模型性能、真实浏览器帧率仍未验证。

## 后续缓存设计备忘（未实现）

缓存键至少包括段落 fingerprint、model/provider、Prompt/schema version、rules version、deep mode、本批 AI review context 相关规则内容；若判断依赖邻段，还需相邻上下文 fingerprint。不得只按 paragraphText fingerprint 缓存。本轮没有持久化模型结果或增加缓存逻辑。
