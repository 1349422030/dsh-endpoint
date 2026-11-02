# dsh-endpoint

Serve the models **this DeepSeek Harness profile is already configured for** as an
OpenAI-compatible HTTP endpoint.

It is not another provider bridge. There is no second API key store, no second
base URL, and no second compat layer: every request is answered through
`ctx.llm.stream()`, the same provider- and model-neutral entry point the agent
loop uses. Whatever your profile can talk to — including providers that need a
custom `thinkingFormat`, developer-role quirks, or per-model reasoning effort —
this endpoint can serve, with the profile's retries and image budget already
applied.

The point is the metadata. Chat clients cannot guess a model's context window,
its output ceiling, whether it accepts images, or which reasoning levels it
declares. This endpoint reads all of that from the profile and publishes it, so
a client discovers the truth instead of hard-coding assumptions.

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
  "input_modalities": ["text", "image"],
  "capabilities": {
    "context_length": 1000000,
    "max_output_tokens": 328000,
    "reasoning_efforts": ["low", "high", "max"],
    "default_reasoning_effort": "high",
    "reasoning_controllable": true
  }
}
```

Clients that ignore unknown fields are unaffected; clients that care can size
their context, cap their output, enable thinking, or decide whether to attach an
image, without guessing.

## Behaviour worth knowing before you wire it up

- **Images.** Only `data:` base64 parts are accepted. They are admitted through
  the Harness attachment store, so the profile's own limits
  (`maxImageBytes`, `maxImagesPerMessage`, `maxImagePixels`,
  `maxImageDimension`, allowed media types) apply — this endpoint invents no
  numbers of its own. Remote URLs are rejected, because fetching them would turn
  the endpoint into an SSRF vector.
- **Reasoning.** `reasoning_effort`, `enable_thinking`, and
  `{"reasoning": {"enabled": ...}}` are all understood. Only efforts the model
  actually declares are ever sent; unknown names are mapped to the nearest
  declared level and the response echoes what really took effect. Think output
  is returned as `reasoning_content`, streaming and non-streaming, and a reply
  falls back to empty rather than failing when a model emits none.
- **Length.** `max_tokens` may only be lowered. Anything above the model's
  declared ceiling is clamped to it, and the response echoes the value used. A
  request whose prompt exceeds the model's context window is rejected with
  `400 context_length_exceeded` rather than sent upstream to fail there.
- **Tools.** Not served. A request carrying `tools` is rejected with
  `400 tools_unsupported`; assistant `tool_calls` and `role: "tool"` entries in
  `history` are folded into readable text instead of being dropped, so prior
  conversations remain coherent.
- **Usage.** Passed through when the provider reports it; estimated and marked
  `"estimated": true` when it does not.
- **Not carried through.** `top_p`, `response_format`, `logprobs`, `seed`,
  `presence_penalty`, and `frequency_penalty` have no equivalent in the Harness
  request shape. They are accepted and ignored rather than silently pretendable;
  `temperature` is dropped whenever reasoning is active, and the response says
  so in `warnings`.

## Network posture

No TLS and no CORS layer are served here. The default bind is `127.0.0.1`; if
the endpoint must leave the machine, bind a wider address **and** set an API key,
then put a reverse proxy in front for TLS. `/health` reports `reachability` for
loopback, LAN, and public access so the current posture is never a guess, and it
warns when a non-loopback bind has no key set.

## Settings

Four fields live in the settings page — enable, bind address, port, API key —
because those are the ones you change while debugging. Everything else lives in
the profile's `cordis.patch.yml`.

## Install

```sh
dsh plugin --profile web add "I:/Document/DeepSeek Harness/WorkSpace/dsh-endpoint"
```

Then check it:

```sh
curl http://127.0.0.1:8788/health
```

## Status

Version 0.1.0. The HTTP layer, routing, `/health`, and settings are complete; the
protocol conversion, capability projection, and completion path are being built
in stages, and unimplemented routes answer `501 not_implemented` rather than
pretending to work.
