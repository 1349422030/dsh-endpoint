# dsh-endpoint

Serve the models **this DeepSeek Harness profile is already configured for** as an
OpenAI-compatible HTTP endpoint.

It is not another provider bridge. There is no second API key store, no second
base URL, and no second compat layer: every request is answered through
`ctx.llm.stream()`, the same provider- and model-neutral entry point the agent
loop uses. Whatever your profile can talk to — providers that need a custom
`thinkingFormat`, developer-role quirks, per-model reasoning efforts — this
endpoint can serve, with the profile's retries and image budget already applied.

The point is the metadata. Chat clients cannot guess a model's context window,
its output ceiling, whether it accepts images, or which reasoning levels it
declares. This endpoint reads all of that from the profile and publishes it, so a
client discovers the truth instead of hard-coding assumptions.

## What it serves

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | One completion, streaming or not |
| `GET /v1/models` | Every model the profile can route |
| `GET /v1/models/{id}` | One model, with its capability details |
| `GET /health` | Whether the listener is up, and who can reach it |

Base URL: `http://127.0.0.1:8788/v1`.

## What a client gets that plain OpenAI does not have

`/v1/models` and `/v1/models/{id}` carry a non-standard `capabilities` object
alongside the usual fields:

```json
{
  "id": "deepseek/deepseek-v4.1-flash",
  "object": "model",
  "owned_by": "commandcode",
  "name": "DeepSeek V4.1 Flash",
  "capabilities": {
    "context_length": 1000000,
    "max_output_tokens": 328000,
    "input_modalities": ["text", "image"],
    "output_modalities": ["text"],
    "reasoning": {
      "supported": true,
      "efforts": [{ "id": "low", "name": "low" }, { "id": "high", "name": "high" }, { "id": "max", "name": "max" }],
      "default_effort": "high"
    },
    "tool_calls": false,
    "streaming": true
  }
}
```

A field the profile does not declare is `null` (or `null` for
`input_modalities`), never a made-up number: `null` means "ask your own
default", not "zero".

Every completion also echoes what really happened, so a client never has to
assume it got what it asked for:

```json
{
  "dsh": {
    "provider": "commandcode",
    "model": "deepseek/deepseek-v4.1-flash",
    "reasoning_effort": "high",
    "thinking": true,
    "capabilities": { "...": "same object as above" }
  }
}
```

## Behaviour worth knowing before you wire it up

- **Images.** Only `data:` base64 parts are accepted, as `image_url` or
  `input_image` parts. They are admitted through the Harness attachment store,
  so the profile's own limits (`maxImageBytes`, `maxImagesPerMessage`,
  `maxMessageImageBytes`, `maxImagePixels`, `maxImageDimension`, allowed media
  types) apply — this endpoint invents no numbers of its own. A model whose
  metadata does not list `image` is refused with `400 images_unsupported`
  *before* anything is written to disk. Remote URLs are refused with
  `400 image_url_unsupported`, because fetching them would turn the endpoint into
  an SSRF vector.
- **Reasoning.** `reasoning_effort`, `enable_thinking`, and
  `{"reasoning": {"enabled": ...}}` are all understood. Only efforts the model
  actually declares are ever sent; unknown names are mapped to the nearest
  declared level, "off" falls back to the lowest level a model without an off
  switch declares, and every substitution is reported in `warnings`. Think output
  is returned as `reasoning_content`, both streaming and not.
- **Length.** `max_tokens` may only be lowered. Anything above the model's
  declared ceiling is clamped to it and reported in `warnings`. A prompt that
  plainly exceeds the context window is rejected with
  `400 context_length_exceeded` before it is sent upstream. The estimate is
  characters/4 — this endpoint has no tokenizer, so the number is a guard, not an
  accounting of the exact prompt.
- **Tools.** Not served. A request carrying `tools` is rejected with
  `400 tools_unsupported`. Assistant `tool_calls` and `role: "tool"` entries in
  `messages` are folded into readable text (`[tool call …]`, `[tool result …]`)
  instead of being dropped, so a conversation that used tools stays coherent.
- **Usage.** Passed through when the provider reports it; estimated and marked
  `"estimated": true` when it does not. In a stream the usage rides on the final
  chunk as a sibling of `choices`, as the OpenAI schema has it.
- **Failures mid-stream.** Headers are already out, so the error arrives as
  `data: {"error": {...}}` followed by `data: [DONE]` — the stream is always
  terminated cleanly.
- **Not carried through.** `top_p`, `response_format`, `logprobs`, `seed`,
  `presence_penalty`, and `frequency_penalty` have no equivalent in the Harness
  request shape. They are accepted and ignored rather than silently pretended;
  `temperature` is dropped whenever reasoning is active, and the response says so
  in `warnings`.
- **Attachments are not collected.** Images admitted for a request stay in the
  Harness attachment store; the store has no retention policy yet, so a
  long-running endpoint accumulates them. Nothing here deletes them.

## Network posture

No TLS is served here. The default bind is `127.0.0.1`; to reach it from another
machine, bind a wider address **and** set an API key, then put a reverse proxy in
front for TLS.

`/health` states the posture instead of leaving it to be guessed:

```json
{
  "status": "ok",
  "listening": true,
  "bind": { "host": "127.0.0.1", "port": 8788 },
  "reachability": { "loopback": true, "lan": false, "public": false },
  "auth": "none",
  "tls": false,
  "warnings": []
}
```

A non-loopback bind with no API key produces a warning in both `/health` and the
plugin log. CORS is answered for browser clients: `OPTIONS` is handled before the
key check, and `access-control-allow-origin` follows the `corsOrigin` setting
(`*` by default).

## Settings

The settings page has the four fields worth changing while debugging — enable,
bind address, port, API key — and it updates them live: the listener rebinds
without a reload. Everything else (`requestTimeoutMs`, fallback `provider` /
`model`, `corsOrigin`) lives in the profile's `cordis.patch.yml`.

```yaml
- id: dsh-endpoint
  name: dsh-endpoint
  config:
    enabled: true
    host: 127.0.0.1
    port: 8788
    apiKey: ''
```

## Install

```sh
dsh plugin --profile web add "I:/Document/DeepSeek Harness/WorkSpace/dsh-endpoint"
```

Then check it:

```sh
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

## Tests

```sh
npm test
```

The suite links the host's own `@deepseek-ai/dsh-llm` and `dsh-attachment` into
`node_modules` (they are supplied by the Harness at runtime, not installed here),
then runs `node --test`. It covers message conversion and tool-history folding,
capability projection, effort translation, and the HTTP surface end to end over a
real socket — JSON, SSE, the tools refusal, the image modality gate, the output
clamp, and unknown-model reporting.

## Status

Version 0.1.0, feature-complete for the scope above. Known limitations, all
stated rather than hidden: no tokenizer for exact prompt accounting, no
attachment retention policy, and no passthrough of sampling parameters the
Harness request shape does not carry.
