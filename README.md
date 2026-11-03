# dsh-endpoint

把这个 DeepSeek Harness profile **已经配置好的模型**，以 OpenAI 兼容的 HTTP 接口对外提供。

它不是又一个 provider 桥接层。这里没有第二份 API key、第二个 base URL、第二套兼容层：每个请求都通过 `ctx.llm.stream()` 完成，也就是 agent loop 自己在用的那个与 provider、模型无关的入口。你的 profile 能跟谁对话——需要自定义 `thinkingFormat` 的 provider、挑剔 developer 角色的上游、每个模型不同的思考档位——这个端点就能服务谁，profile 里的重试策略和图像预算也已经替你生效。

在"转发"之外，它多做三件事。其一，把模型的事实广播出去：聊天客户端没法凭空猜到某个模型的上下文窗口多大、输出上限多少、收不收图像、声明了哪些思考档位，`/v1/models` 就把这些从 profile 里读出来一并给出。其二，接受图像输入，并按模型声明的模态在图片落盘之前拦截。其三，把"要多少思考"翻译成模型真正声明过的档位，每一次替换都写进 `x-dsh-warning` 响应头。至于可选的模型、`reasoning_effort`、`max_tokens` 这些常规参数，它和一般 OpenAI 兼容端点一样处理。

## 提供哪些路由

| 路由 | 作用 |
| --- | --- |
| `POST /v1/chat/completions` | 单轮补全，可流式 |
| `GET /v1/models` | profile 能路由的全部模型 |
| `GET /v1/models/{id}` | 单个模型，含能力明细 |
| `GET /health` | 监听是否在跑，以及谁能连上 |

Base URL：`http://127.0.0.1:8788/v1`。

## 模型卡：OpenAI 之外的那部分元数据

OpenAI 的 `model` 对象只有 `id`、`object`、`created`、`owned_by`。它不说上下文窗口多大、输出上限多少、收不收图像、声明了哪些思考档位——于是客户端只能硬编码猜测。

这块空白已经有事实标准：[OpenRouter 的模型 schema](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)。这里就按它输出，用这套 schema 的客户端不需要任何适配：

```json
{
  "id": "deepseek/deepseek-v4.1-flash",
  "object": "model",
  "created": 1704067200,
  "owned_by": "commandcode",
  "name": "DeepSeek V4.1 Flash",
  "context_length": 1000000,
  "architecture": {
    "modality": "text+image->text",
    "input_modalities": ["text", "image"],
    "output_modalities": ["text"]
  },
  "top_provider": { "context_length": 1000000, "max_completion_tokens": 328000 },
  "supported_parameters": ["max_tokens", "stop", "temperature", "tools", "reasoning", "reasoning_effort"],
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["low", "high", "max"],
    "default_effort": "high"
  }
}
```

profile 没有声明的字段一律是 `null`（`architecture` 也是），不会编一个数字出来。`null` 的含义是"用你自己的默认值"，不是"零"。

`supported_parameters` 只列这个端点真的会执行的参数。`tools` 也在其中：工具声明会被转发给模型，模型想发起的调用会原样回传给调用方——执行永远不会发生在这个端点里。

### 实际生效的值在响应头里

补全的正文保持纯 OpenAI schema，不塞任何私有字段（否则按 schema 校验的客户端会直接拒收）。这次请求实际落到了哪个 provider 和模型、思考开没开、最终用的哪个档位、有哪些参数被改写，都放在 `x-dsh-*` 响应头里：

```
x-dsh-provider: commandcode
x-dsh-model: deepseek/deepseek-v4.1-flash
x-dsh-thinking: on
x-dsh-reasoning-effort: high
x-dsh-warning: max_tokens 999999 exceeds this model's declared output limit of 328000 tokens; 328000 was used instead.
```

忽略响应头的客户端拿到的就是一个普通的 OpenAI 响应；需要真相的客户端读头即可。流式请求同理，头在第一个字节之前就已经发出。

## 工具调用：声明上行，调用下行

工具属于调用方。一个 agent 客户端每轮都会带上它自己的工具集，这个端点只做两件事：把声明转成 Harness 的 `ToolSchema` 交给模型，把模型发起的 `tool_calls` 原样交回调用方。**它不执行任何工具**，也不会把本 profile 里 agent 自己的工具借出去——那些工具、它们的审批策略和执行权始终留在这个 DSH 进程里。

所以一个完整的工具调用是两轮、跨两个系统：

1. 客户端发 `tools` + 对话历史 → 模型回 `tool_calls`（`finish_reason: "tool_calls"`）；
2. 客户端**自己**执行工具，把结果作为 `role: "tool"` 连同历史再发一轮 → 模型给出最终答复。

协议细节都按 OpenAI 的形状走：`assistant.tool_calls` 会映射成真正的 tool-call 块（不再是折成文本），`role: "tool"` 映射成工具结果消息，`arguments` 原样透传不重新序列化（空串按 `{}` 处理，因为无参数调用就是这么发的）。`tool_choice` 和 `parallel_tool_calls` 在 Harness 的请求结构里没有对应位置，接受但忽略，并写进 `x-dsh-warning`。

## 接客户端之前值得知道的行为

- **图像。** 只接受 `data:` base64 部件，形式为 `image_url` 或 `input_image`。它们经由 Harness 的附件库落盘，因此 profile 自己的限额（`maxImageBytes`、`maxImagesPerMessage`、`maxMessageImageBytes`、`maxImagePixels`、`maxImageDimension`、允许的媒体类型）全部生效——这个端点不自造任何数字。元数据里没有列出 `image` 的模型会在**写入磁盘之前**被拒：`400 images_unsupported`。远程 URL 一律拒绝，返回 `400 image_url_unsupported`，因为代抓远程图会把端点变成 SSRF 通道。
- **思考。** `reasoning_effort`、`enable_thinking`、`{"reasoning": {"enabled": ...}}` 三种写法都认。发出去的档位一定是模型真正声明过的；未知档位名会就近映射到最近的声明档位，"关闭"在没有关闭档的模型上退化为它声明的最低档，每一次替换都写进 `x-dsh-warning` 响应头。思考内容以 `reasoning_content` 返回，流式和非流式都有。
- **长度。** `max_tokens` 只允许往下调。超过模型声明上限的值会被夹到上限并写进 `x-dsh-warning` 响应头。明显超出上下文窗口的 prompt 在发给上游之前就被拒：`400 context_length_exceeded`。估算方式是字符数/4——这个端点没有 tokenizer，所以那个数字是一道保险，不是对 prompt 的精确计费。
- **工具。** 见下一节：声明上行、调用下行，端点自己从不执行。
- **用量。** 上游报了就直接透传；没报就估算并标 `"estimated": true`。流式里 usage 挂在最后一个 chunk 上、与 `choices` 平级，这是 OpenAI schema 的规定位置。
- **流式中途出错。** 此时响应头早已发出，错误以 `data: {"error": {...}}` 送达，之后仍然有 `data: [DONE]`——流总是干净收尾。
- **透传不了的参数。** `top_p`、`response_format`、`logprobs`、`seed`、`presence_penalty`、`frequency_penalty` 在 Harness 的请求结构里没有对应位置。它们会被接受但忽略，而不是假装生效；思考开启时 `temperature` 会被丢弃，并在 `x-dsh-warning` 里说明。
- **附件不会回收。** 为请求落入附件库的图片会一直留在那里；附件库目前还没有保留策略，所以长期运行的端点会持续累积。这里不负责删除。

## 网络姿态

这里不提供 TLS。默认只绑 `127.0.0.1`；要让别的机器连上，就绑更宽的地址**并且**设置 API key，再在前面放一层反代来终止 TLS。

`/health` 会把姿态讲明白，而不是让人猜：

```json
{
  "status": "ok",
  "listening": true,
  "bind": { "host": "127.0.0.1", "port": 8788 },
  "auth": "none",
  "tls": false,
  "warnings": []
}
```

绑非回环地址却不设 API key，会在 `/health` 和插件日志里各留一条警告。浏览器客户端的 CORS 也照顾了：`OPTIONS` 在鉴权之前处理，`access-control-allow-origin` 跟随 `corsOrigin` 设置（默认 `*`），`access-control-expose-headers` 显式列出所有 `x-dsh-*` 事实头——否则浏览器里的客户端读得到正文、读不到「实际是哪个模型答的、有没有警告」。

## 设置页

设置页只放调试时值得改的四个字段——启用、绑定地址、端口、API key——并且即时生效：监听会重新绑定，不需要重启。其余配置（`requestTimeoutMs`、兜底的 `provider`/`model`、`corsOrigin`）写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-endpoint
  name: dsh-endpoint
  config:
    enabled: true
    host: 127.0.0.1
    port: 8788
    apiKey: ''
```

## 安装

本插件不构建、不打包，直接用源码；需要先在 DSH 里装好（`dsh` 命令可用）。

```sh
dsh plugin --profile <profile 名> add github:1349422030/dsh-endpoint
```

## 测试

```sh
npm test
```

覆盖消息转换与工具映射（声明转 schema、`tool_calls` 与 `role: "tool"` 的历史映射）、模型卡投影、思考档位翻译，以及跑在真实 socket 上的 HTTP 端到端：JSON、SSE、工具的流式增量与并行调用、图像模态门、输出上限夹取、未知模型上报。

## 状态

版本 0.1.0，上述范围内的功能已完成。已知限制全部如实写出，不做隐藏：没有 tokenizer 来精确计算 prompt（上下文守卫也不会把 `tools` 声明的 token 成本算进去，大工具表可能低估）、没有附件保留策略、Harness 请求结构不携带的采样参数无法透传、`arguments` 原样透传意味着上游截断时调用方可能收到不完整的 JSON（这个端点不改写模型输出）。

## 致谢

本插件的起点是 [dsh-model-endpoint](https://github.com/Xxsttb/dsh-model-endpoint)（MIT）：插件骨架、Bearer 优先 / `x-api-key` 兜底的鉴权顺序、`/health` 描述自身网络姿态的写法，以及"把 profile 里配好的模型当作 OpenAI 接口对外提供"这个想法，都来自它。实现是为上面那些差异重写的，没有沿用它的代码。