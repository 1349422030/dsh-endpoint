/**
 * dsh-endpoint — one completion, start to finish.
 *
 * Assembles the `ctx.llm.stream` options for one request, consumes the chunk
 * stream, and writes either one JSON body or one SSE body. Also owns usage
 * normalisation. Owns no request parsing and no route selection.
 */
import { randomUUID } from 'node:crypto';
import {
    CONTEXT_WINDOW_EXCEEDED_CODE,
    EMPTY_RESPONSE_CODE,
    INVALID_CREDENTIAL_CODE,
    ReasoningEffortId,
    isContextWindowExceededError,
    isQuotaExceededError,
} from '@deepseek-ai/dsh-llm';
import { ApiFailure, readJsonBody, sendJson, service } from './http.js';
import { assertNoTools, toRequestMessages } from './protocol.js';
import { modelInfo, resolveEffort, resolveRoute, routeLabel } from './capabilities.js';

/**
 * Characters per token used only for the advisory context pre-check and for
 * marking a usage estimate. The harness has no tokenizer of its own, so any
 * number here is a rough proxy; the provider's own count always wins.
 */
const CHARS_PER_TOKEN = 4;

/** OpenAI accepts at most four stop sequences. */
const MAX_STOP_SEQUENCES = 4;

/** OpenAI's stable error code for a response the model refused to produce. */
const EMPTY_RESPONSE = typeof EMPTY_RESPONSE_CODE === 'string' ? EMPTY_RESPONSE_CODE : 'empty_response';

/**
 * Read the model the profile is currently using, from the service the chat
 * picker and the Models settings page both write to.
 * @param {object} ctx - the plugin context.
 * @returns {{provider: string, model: string}|undefined} the selection, when readable.
 */
function currentSelection(ctx) {
    const selectionService = service(ctx, 'agentDefaultModel');
    if (selectionService === undefined || typeof selectionService.currentSelection !== 'function') return undefined;
    try {
        const selection = selectionService.currentSelection();
        if (typeof selection?.provider === 'string' && typeof selection?.model === 'string' && selection.model !== '') {
            return { provider: selection.provider, model: selection.model };
        }
    } catch {
        // A missing or misbehaving service must never break the endpoint.
    }
    return undefined;
}

/**
 * Estimate the token count of one string, for estimates only.
 * @param {string} text - the text to measure.
 * @returns {number} an approximate token count.
 */
function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/**
 * Resolve the output cap for one request.
 *
 * A request may only lower the ceiling the profile declares: a bigger number
 * would promise output the model cannot produce, so it is clamped and the
 * response says so.
 * @param {object} body - the parsed request body.
 * @param {object|undefined} info - resolved model info.
 * @param {string[]} warnings - this request's warning list, appended to in place.
 * @returns {number|undefined} the cap to send, or undefined to leave it to the provider.
 * @throws {ApiFailure} 400 when the requested cap is not a positive integer.
 */
function resolveMaxTokens(body, info, warnings) {
    const raw = body?.max_tokens ?? body?.max_completion_tokens;
    if (raw === undefined || raw === null) return undefined;
    const requested = Number(raw);
    if (!Number.isFinite(requested) || Math.floor(requested) < 1) {
        throw new ApiFailure(400, 'invalid_request_error', 'max_tokens must be a positive integer.', 'invalid_request_error', 'max_tokens');
    }
    const floor = Math.floor(requested);
    const declared = typeof info?.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : undefined;
    if (declared !== undefined && floor > declared) {
        warnings.push(`max_tokens ${floor} exceeds this model's declared output limit of ${declared} tokens; ${declared} was used instead.`);
        return declared;
    }
    return floor;
}

/**
 * Resolve the sampling temperature, dropping it when thinking is on.
 * @param {unknown} value - the request's `temperature`.
 * @param {boolean} thinking - whether this request runs with thinking enabled.
 * @param {string[]} warnings - this request's warning list, appended to in place.
 * @returns {number|undefined} the temperature to send.
 * @throws {ApiFailure} 400 when the value is not a number.
 */
function resolveTemperature(value, thinking, warnings) {
    if (value === undefined || value === null) return undefined;
    const temperature = Number(value);
    if (!Number.isFinite(temperature)) {
        throw new ApiFailure(400, 'invalid_request_error', 'temperature must be a number.', 'invalid_request_error', 'temperature');
    }
    if (thinking) {
        warnings.push('temperature was dropped because thinking is enabled: the provider applies its own sampling for a reasoning pass.');
        return undefined;
    }
    return temperature;
}

/**
 * Normalise the request's `stop` field.
 * @param {unknown} value - a string or an array of strings.
 * @param {string[]} warnings - this request's warning list, appended to in place.
 * @returns {string[]|undefined} the stop sequences to send.
 */
function resolveStop(value, warnings) {
    const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
    if (list.length === 0) return undefined;
    if (list.length > MAX_STOP_SEQUENCES) {
        warnings.push(`Only the first ${MAX_STOP_SEQUENCES} stop sequences were used; ${list.length} were sent.`);
    }
    return list.slice(0, MAX_STOP_SEQUENCES);
}

/**
 * Refuse an image destined for a model that declares no image input.
 *
 * The Harness itself degrades an image to a placeholder for a text-only model
 * rather than failing, which silently drops what the caller sent. A client
 * asking this endpoint deserves to be told, so the modality declaration is
 * checked up front and the request is refused by name.
 * @param {object|undefined} info - resolved model info.
 * @param {object[]} messages - the request messages after conversion.
 * @returns {void}
 * @throws {ApiFailure} 400 `images_unsupported` when the model cannot see images.
 */
function assertModalities(info, messages) {
    const declared = info?.inputModalities;
    if (!Array.isArray(declared) || declared.includes('image')) return;
    // Checked on the request as sent, before any image is admitted to disk: a
    // model that cannot see images should cost the caller nothing.
    const hasImage = messages.some((message) => Array.isArray(message?.content)
        && message.content.some((part) => part?.type === 'image_url' || part?.type === 'input_image'));
    if (!hasImage) return;
    throw new ApiFailure(
        400,
        'images_unsupported',
        `This model does not accept images: it declares ${declared.length === 0 ? 'no input modalities' : declared.join(' and ')} only. Remove the image part, or pick a model whose capabilities.input_modalities includes "image" (GET /v1/models).`,
        'invalid_request_error',
        'messages',
    );
}

/**
 * Refuse a request that obviously cannot fit the model's context window.
 *
 * This is a coarse guard, not a tokenizer: it only fires when the prompt plus
 * the reserved output is already over the declared window by a wide margin. A
 * near-miss is left to the provider, whose own count is authoritative, and
 * whose error is mapped back to `context_length_exceeded`.
 * @param {object} plan - the assembled completion plan.
 * @param {object|undefined} info - resolved model info.
 * @returns {void}
 * @throws {ApiFailure} 400 `context_length_exceeded` when the request cannot fit.
 */
function guardContext(plan, info) {
    const window = info?.context?.contextWindow;
    if (typeof window !== 'number' || window <= 0) return;
    const promptChars = plan.messages.reduce((total, message) => total
        + message.content.reduce((sum, block) => sum + (block?.type === 'text' ? block.text.length : 0), 0), 0)
        + plan.system.length;
    const prompt = estimateTokens(' '.repeat(promptChars));
    const reserved = plan.maxTokens ?? 0;
    if (prompt + reserved <= window) return;
    throw new ApiFailure(
        400,
        'context_length_exceeded',
        `This request is roughly ${prompt} prompt tokens, and ${reserved} output tokens are reserved, which does not fit this model's ${window}-token context window. Shorten the conversation or lower max_tokens.`,
        'invalid_request_error',
        'messages',
    );
}

/**
 * Map a provider failure onto the HTTP shape an OpenAI client understands.
 * @param {object} failure - the terminal `finish.failure`.
 * @param {AbortSignal} signal - this request's cancellation signal.
 * @returns {ApiFailure} the failure to throw.
 */
function mapFailure(failure, signal) {
    const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : 'The model call failed.';
    const code = typeof failure?.code === 'string' ? failure.code : '';
    if (signal?.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason.message : 'the request was cancelled';
        return new ApiFailure(499, 'request_cancelled', `The request was cancelled before the model answered: ${reason}.`, 'server_error');
    }
    if (code === CONTEXT_WINDOW_EXCEEDED_CODE || isContextWindowExceededError(failure)) {
        return new ApiFailure(
            400,
            'context_length_exceeded',
            `This conversation does not fit the model's context window: ${message}`,
            'invalid_request_error',
            'messages',
        );
    }
    if (isQuotaExceededError(failure)) {
        return new ApiFailure(429, 'insufficient_quota', `The provider refused this request for quota reasons: ${message}`, 'server_error');
    }
    if (code === INVALID_CREDENTIAL_CODE) {
        return new ApiFailure(401, 'invalid_api_key', `The provider rejected this profile's credentials: ${message}`, 'server_error');
    }
    const status = typeof failure?.status === 'number' ? failure.status : undefined;
    if (/image/i.test(message) && /(support|modal|accept|not allowed)/i.test(message)) {
        return new ApiFailure(
            400,
            'images_unsupported',
            `This model does not accept images: ${message}`,
            'invalid_request_error',
            'messages',
        );
    }
    if (status === 429) return new ApiFailure(429, 'rate_limit_exceeded', `The provider rate-limited this request: ${message}`, 'server_error');
    if (status === 401 || status === 403) return new ApiFailure(status, 'invalid_api_key', `The provider rejected this profile's credentials: ${message}`, 'server_error');
    if (status === 400) return new ApiFailure(400, 'upstream_bad_request', `The provider rejected this request: ${message}`, 'invalid_request_error');
    return new ApiFailure(502, 'upstream_error', `The model provider failed: ${message}`, 'server_error');
}

/**
 * Map a thrown value from the stream call onto an ApiFailure.
 * @param {unknown} error - the thrown value.
 * @param {AbortSignal} signal - this request's cancellation signal.
 * @returns {ApiFailure} the failure to throw.
 */
function mapThrown(error, signal) {
    if (error instanceof ApiFailure) return error;
    if (signal?.aborted) return mapFailure(undefined, signal);
    if (isContextWindowExceededError(error)) {
        return new ApiFailure(
            400,
            'context_length_exceeded',
            `This conversation does not fit the model's context window: ${error instanceof Error ? error.message : String(error)}`,
            'invalid_request_error',
            'messages',
        );
    }
    const failure = {
        message: error instanceof Error ? error.message : String(error),
        code: typeof error?.code === 'string' ? error.code : '',
        status: typeof error?.status === 'number' ? error.status : undefined,
    };
    return mapFailure(failure, signal);
}

/**
 * Consume one model call, reporting deltas to a sink as they arrive.
 * @param {object} ctx - the plugin context.
 * @param {object} plan - the assembled completion plan.
 * @param {AbortSignal} signal - cancellation for this call.
 * @param {{text?: function, reasoning?: function}} sink - incremental callbacks.
 * @returns {Promise<{text: string, reasoning: string, usage: object|undefined, finish: object|undefined, failed: object|undefined}>} the outcome.
 */
async function runCompletion(ctx, plan, signal, sink) {
    const options = {
        provider: plan.route.provider,
        model: plan.route.model,
        messages: plan.messages,
        signal,
        ...(plan.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(plan.effort) }),
        ...(plan.system === '' ? {} : { system: plan.system }),
        ...(plan.maxTokens === undefined ? {} : { maxTokens: plan.maxTokens }),
        ...(plan.temperature === undefined ? {} : { temperature: plan.temperature }),
        ...(plan.stop === undefined ? {} : { stop: plan.stop }),
    };
    let text = '';
    let reasoning = '';
    let usage;
    let finish;
    for await (const chunk of ctx.llm.stream(options)) {
        switch (chunk?.type) {
            case 'text-delta':
                text += chunk.text;
                sink.text?.(chunk.text);
                break;
            case 'reasoning-delta':
                reasoning += chunk.text;
                sink.reasoning?.(chunk.text);
                break;
            case 'usage':
                usage = chunk.usage ?? usage;
                break;
            case 'finish':
                finish = chunk.reason;
                break;
            default:
                break;
        }
    }
    const failed = finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted') ? finish.failure : undefined;
    return { text, reasoning, usage, finish, failed };
}

/**
 * Map a Harness finish reason onto OpenAI's `finish_reason`.
 * @param {object|undefined} reason - the terminal finish reason.
 * @returns {string} the OpenAI finish reason.
 */
function finishReason(reason) {
    switch (reason?.kind) {
        case 'max-tokens':
            return 'length';
        case 'tool-calls':
            return 'tool_calls';
        case 'stop':
        default:
            return 'stop';
    }
}

/**
 * Build the OpenAI `usage` object from the provider's counts, or estimate it.
 *
 * The harness reports uncached input separately from cache reads and writes; an
 * OpenAI client expects `prompt_tokens` to include everything the prompt cost,
 * so the three are summed and the cached share is repeated where OpenAI clients
 * look for it.
 * @param {object|undefined} usage - the provider's token accounting.
 * @param {{promptText: string, completionText: string}} texts - what was sent and produced.
 * @returns {object} an OpenAI usage object.
 */
function openAiUsage(usage, texts) {
    if (usage !== undefined && usage !== null && (Number.isFinite(usage.inputTokens) || Number.isFinite(usage.outputTokens))) {
        const cached = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
        const written = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
        const prompt = (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0) + cached + written;
        const completion = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
        const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : prompt + completion;
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
            ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
            ...(Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens > 0
                ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
                : {}),
        };
    }
    const prompt = estimateTokens(texts.promptText);
    const completion = estimateTokens(texts.completionText);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: true };
}

/**
 * The text this request sent, for usage estimation only.
 * @param {object} plan - the assembled completion plan.
 * @returns {string} the concatenated prompt text.
 */
function promptTextOf(plan) {
    return [plan.system, ...plan.messages.map((message) => message.content
        .map((block) => (block?.type === 'text' ? block.text : ''))
        .join(''))].filter((part) => part !== '').join('\n');
}

/**
 * Answer one `POST /v1/chat/completions`.
 * @param {object} deps - {ctx, settings, bound, request, response}.
 * @returns {Promise<void>} resolves once the response is finished.
 * @throws {ApiFailure} for a malformed or unserviceable request.
 */
export async function handleChat(deps) {
    const { ctx, settings, request, response } = deps;
    const body = await readJsonBody(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiFailure(400, 'invalid_request_error', 'The request body must be a JSON object.');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new ApiFailure(400, 'invalid_request_error', 'messages must be a non-empty array.', 'invalid_request_error', 'messages');
    }
    assertNoTools(body);

    const controller = new AbortController();
    let unblocked = false;
    const timer = setTimeout(() => {
        if (unblocked) return;
        controller.abort(new Error(`no completion within ${settings.requestTimeoutMs} ms`));
    }, settings.requestTimeoutMs);
    // Watch the response, not the request: an IncomingMessage reports "close"
    // once its body has been consumed, which is immediately here and would
    // cancel every call before it started. A response that closes before it was
    // ended is a client that really went away.
    const onClose = () => {
        if (!response.writableEnded) controller.abort(new Error('the client disconnected'));
    };
    response.on?.('close', onClose);
    try {
        const route = await resolveRoute(ctx, settings, currentSelection(ctx), body.model, controller.signal);
        const info = await modelInfo(ctx, route, controller.signal);
        assertModalities(info, body.messages);
        const history = await toRequestMessages(ctx, body.messages, controller.signal);
        const warnings = [...history.warnings];
        const decision = resolveEffort(info, {
            reasoning_effort: body.reasoning_effort,
            enable_thinking: body.enable_thinking,
            reasoning: body.reasoning,
        });
        if (decision.warning !== undefined) warnings.push(decision.warning);
        const plan = {
            route,
            info,
            messages: history.messages,
            system: history.system,
            effort: decision.effort,
            thinking: decision.thinking,
            maxTokens: resolveMaxTokens(body, info, warnings),
            temperature: resolveTemperature(body.temperature, decision.thinking, warnings),
            stop: resolveStop(body.stop, warnings),
            warnings,
            signal: controller.signal,
            includeUsage: body.stream_options?.include_usage !== false,
        };
        guardContext(plan, info);
        if (body.stream === true) await streamChat(deps, plan);
        else await completeChat(deps, plan);
    } finally {
        unblocked = true;
        clearTimeout(timer);
        response.off?.('close', onClose);
    }
}

/**
 * Facts about what this request actually became, as response headers.
 *
 * The OpenAI body has no room for them, and inventing fields in it would make
 * every client that validates the schema choke. Headers are the extension
 * mechanism HTTP already provides: a client that ignores them sees a plain
 * OpenAI response.
 * @param {object} plan - the assembled completion plan.
 * @returns {Record<string, string>} the headers.
 */
function outcomeHeaders(plan) {
    const headers = {
        'x-dsh-provider': plan.route.provider,
        'x-dsh-model': plan.route.model,
        'x-dsh-thinking': plan.thinking ? 'on' : 'off',
    };
    if (plan.effort !== undefined) headers['x-dsh-reasoning-effort'] = plan.effort;
    if (plan.warnings.length > 0) headers['x-dsh-warning'] = plan.warnings.join(' | ');
    return headers;
}

/**
 * Answer one completion as a single JSON body.
 * @param {object} deps - {ctx, response}.
 * @param {object} plan - the assembled completion plan.
 * @returns {Promise<void>} resolves once the body is written.
 */
async function completeChat(deps, plan) {
    const { ctx, response } = deps;
    let outcome;
    try {
        outcome = await runCompletion(ctx, plan, plan.signal, {});
    } catch (error) {
        throw mapThrown(error, plan.signal);
    }
    if (outcome.failed !== undefined) throw mapFailure(outcome.failed, plan.signal);
    if (outcome.text === '' && outcome.reasoning === '') {
        throw new ApiFailure(502, EMPTY_RESPONSE, 'The model returned an empty response.', 'server_error');
    }
    const usage = openAiUsage(outcome.usage, {
        promptText: promptTextOf(plan),
        completionText: outcome.text + outcome.reasoning,
    });
    sendJson(response, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: routeLabel({ provider: plan.route.provider, id: plan.route.model }),
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: outcome.text,
                    ...(outcome.reasoning === '' ? {} : { reasoning_content: outcome.reasoning }),
                },
                finish_reason: finishReason(outcome.finish),
            },
        ],
        usage,
    }, outcomeHeaders(plan));
}

/**
 * Answer one completion as server-sent events.
 *
 * A failure after the first byte cannot become an HTTP status any more, so it
 * is emitted as an OpenAI-shaped `error` event and the stream is still
 * terminated cleanly: a client that already moved to streaming must be told
 * what happened, not left with a truncated body.
 * @param {object} deps - {ctx, response}.
 * @param {object} plan - the assembled completion plan.
 * @returns {Promise<void>} resolves once the stream is closed.
 */
async function streamChat(deps, plan) {
    const { ctx, response } = deps;
    response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...outcomeHeaders(plan),
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = routeLabel({ provider: plan.route.provider, id: plan.route.model });
    const emit = (payload) => {
        if (response.writableEnded) return;
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    // Per the OpenAI schema the usage of a streamed answer rides on the final
    // chunk as a sibling of `choices`, not inside it.
    const envelope = (delta, finish, usage) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        ...(usage === undefined ? {} : { usage }),
    });

    emit(envelope({ role: 'assistant', content: '' }, null));

    let outcome;
    let failure;
    try {
        outcome = await runCompletion(ctx, plan, plan.signal, {
            text: (text) => emit(envelope({ content: text }, null)),
            reasoning: (text) => emit(envelope({ reasoning_content: text }, null)),
        });
        if (outcome.failed !== undefined) failure = mapFailure(outcome.failed, plan.signal);
    } catch (error) {
        failure = mapThrown(error, plan.signal);
    }

    if (failure !== undefined) {
        emit({
            error: {
                message: failure.message,
                type: failure.type,
                code: failure.code,
                param: failure.param ?? null,
            },
        });
    } else {
        const usage = openAiUsage(outcome.usage, {
            promptText: promptTextOf(plan),
            completionText: outcome.text + outcome.reasoning,
        });
        emit(envelope({}, finishReason(outcome.finish), plan.includeUsage ? usage : undefined));
    }
    if (!response.writableEnded) {
        response.write('data: [DONE]\n\n');
        response.end();
    }
}
