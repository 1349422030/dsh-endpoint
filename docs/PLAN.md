# dsh-endpoint — 实施计划

> OpenAI 兼容端点插件（fork 自 `dsh-model-endpoint`），把 DSH 已配置的模型能力原样开放给外部客户端：
> 文本 + 图像、思考开关/等级、上下文长度、输出上限。
> 仓库身份：`fish <l1349422030@outlook.com>`

## 0. 已定决策（grilling 两轮结论）

| # | 决策 | 值 |
|---|---|---|
| D1 | 协议范围 | 只做 `/v1/chat/completions` + `/v1/models` + `/health`，不做 embeddings/images/responses |
| D2 | 基线 | fork `dsh-model-endpoint`，改名为 `dsh-endpoint` |
| D3 | 状态 | 无状态，每请求全量 messages |
| D4 | 工具 | 不暴露。`tools` 传入 → 400 `tools_unsupported`；历史 `tool_calls`/`tool` → 文本化折叠 |
| D5 | 图像 | 只收 `data:` base64；经 `ctx.attachments.admitPromptContent()` 落盘；大小/格式/张数继承 `ctx.attachments.imageLimits` |
| D6 | 思考 | 收 `reasoning_effort` / `enable_thinking` / `reasoning.enabled` 三种；只发模型声明的 effort；未知值就近映射并回显生效值 |
| D7 | 长度 | `/v1/models` 暴露 `context_length`/`max_output_tokens`；`max_tokens` 只可下调；超限 400 `context_length_exceeded` |
| D8 | 思考内容 | 流式与非流式都发 `reasoning_content` |
| D9 | 网络 | 可绑 127.0.0.1 / 局域网 IP / 0.0.0.0；无 TLS（外部反代）；Bearer secret；默认 127.0.0.1；端口 8788 |
| D10 | usage | 上游有则透传，缺失则估算并标 `estimated: true` |
| D11 | 附件清理 | 不做（DSH 本身无 GC） |
| D12 | temperature | 思考生效时丢弃，响应带 `warnings` |
| D13 | 流式错误 | `data: {"error":...}` 后 `[DONE]`，不断流 |
| D14 | 设置面 | UI 只留 4 项：启用/绑定/端口/key；其余进 cordis config |
| D15 | 语言 | 纯 JS + JSDoc，零构建 |
| D16 | 安装 | 先本地路径装入 web profile |
| D17 | 日志 | 只记元数据，不落正文 |

## 1. 阶段与工作量

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **P0 骨架** | fork、改名、端口 8788、本地安装进 web profile、`/health` 通 | 0.5–1h | `curl /health` 返回 bind 状态 |
| **P1 文本主路** | 无状态 chat.completions、SSE、effort 映射、`reasoning_content` 双向、usage | 2–3h | 纯文本 + 流式 curl 通过 |
| **P2 能力继承** | `/v1/models` capabilities（context/max_output/modalities/efforts）、`auto` 语义、响应 `model` 回显实际路由 | 1–2h | 客户端能读到四类能力 |
| **P3 图像** | base64 → admitPromptContent → image block、错误码翻译、imageLimits 暴露 | 1.5–2.5h | base64 图 curl 通过且模型真收到图 |
| **P4 边界** | tools 400、历史折叠、temperature 冲突、SSE 错误事件、上下文/输出上限夹取 | 1.5–2h | 六条负向用例全绿 |
| **P5 测试** | `node:test` 单测 + `scripts/acceptance.ps1` 六条验收 | 1.5–2h | 全绿并贴输出 |
| **P6 文档与仓库** | README、LICENSE、git init（本地身份）、可选推 GitHub | 0.5–1h | 仓库可 `git log` |

**合计约 9–13 小时有效工作**，折算 4–6 轮会话。

## 2. 文件清单

```
dsh-endpoint/
├── package.json          # name: dsh-endpoint, private:true, type:module
├── cordis.patch.yml      # 插件挂载 + 默认配置
├── lib/
│   ├── index.js          # 生命周期、http listener、路由、SSE
│   ├── convert.js        # OpenAI messages ⇄ harness blocks（含图片、历史折叠）
│   ├── capabilities.js   # resolveModelInfo → capabilities；effort 解析/映射
│   ├── errors.js         # ApiFailure → OpenAI error envelope
│   └── client.js         # 设置页（4 项）
├── locale/{en,zh}.json
├── icon.svg
├── test/*.test.js
├── scripts/acceptance.ps1
├── docs/PLAN.md
├── README.md
└── LICENSE
```

## 3. 项目管理

- **工作目录**：`I:\Document\DeepSeek Harness\WorkSpace\dsh-endpoint`（单任务单文件夹）
- **git**：先本地 `git init`，仓库级身份 `fish / l1349422030@outlook.com`（全局身份为空，不动全局）
- **提交粒度**：一个阶段一到两个 commit，commit message 用 `P1: 文本主路` 形式，方便回滚
- **跟踪**：`todo_write` 逐阶段推进；每个阶段结束由你验收再进下一阶段
- **回滚点**：P0/P1/P3 各打一个 tag

## 4. 风险

| 风险 | 等级 | 应对 |
|---|---|---|
| R1 图片块与 provider adapter 不兼容（唯一真不确定点） | 中 | P3 开工第一件事就跑 curl，撞了立刻反馈，不往下堆功能 |
| R2 本地无 tokenizer，无法精确预估上下文占用 | 中 | 不做本地精算：上限用 `contextWindow` 声明的值做粗估预警，真实超限靠上游错误码映射成 400 |
| R3 listener 生命周期跟随插件 fiber | 低 | 复用参考插件的 dispose 逻辑 |
| R4 保留设置页 = 引入 react client bundle | 低 | 只做 4 个字段的表单，不新增依赖 |
| R5 多实例端口冲突（8787 已被参考插件占用） | 低 | 默认 8788，启动时端口占用则报明确错误 |

## 5. 待你确认

1. 阶段划分与工作量是否接受（尤其"每阶段验收后再进下一步"这个节奏）
2. P0 完成后先推 GitHub 还是全程只在本地，最后一次性推
