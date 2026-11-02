/**
 * dsh-endpoint — OpenAI wire protocol to Harness messages.
 *
 * The only file that knows what an OpenAI `messages` array looks like. Turns it
 * into the request messages `ctx.llm.stream` accepts, including image parts and
 * the tool-history folding rule. Owns no model semantics and no transport.
 */
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { ApiFailure, service } from './http.js';

/** Producer tag for every message this endpoint constructs. */
const USER_SOURCE = { kind: 'dsh-endpoint' };
/** Assistant-side attribution for history the client supplied. */
const ASSISTANT_SOURCE = { provider: 'dsh-endpoint', model: 'client' };
/** A `data:` URL carrying a base64 payload. */
const DATA_URL = /^data:([a-z0-9.!$&'*+\-.^_`]+\/[a-z0-9.!$&'*+\-.^_`]+);base64,([\s\S]*)$/i;

/**
 * Read one message's `content` as plain text.
 * @param {unknown} content - a string, a content-part array, or null.
 * @returns {string} the concatenated text.
 */
export function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (typeof part?.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
}

/**
 * Extract an image part's declared media type and base64 payload.
 *
 * Only inline `data:` URLs are accepted. A fetchable `http(s)` URL would make
 * this endpoint spend its own network access and its own image budget on the
 * caller's behalf, so it is refused by name rather than silently fetched.
 * @param {unknown} part - one `image_url` content part.
 * @param {string} where - field path for the error message.
 * @returns {{ mediaType: string, data: string, name: string|undefined }} the payload.
 * @throws {ApiFailure} 400 when the part is not a base64 data URL.
 */
function imagePayload(part, where) {
    const imageUrl = part?.image_url;
    const url = typeof imageUrl === 'string' ? imageUrl : typeof imageUrl?.url === 'string' ? imageUrl.url : '';
    if (url === '') {
        throw new ApiFailure(400, 'invalid_request_error', `${where}.image_url.url is required.`, 'invalid_request_error', where);
    }
    const match = DATA_URL.exec(url.trim());
    if (match === null) {
        throw new ApiFailure(
            400,
            'image_url_unsupported',
            `${where}.image_url.url must be a base64 "data:" URL. Fetchable http(s) URLs are not supported: this endpoint does not fetch images on a caller's behalf.`,
            'invalid_request_error',
            where,
        );
    }
    const name = typeof part?.name === 'string' && part.name !== '' ? part.name : undefined;
    return { mediaType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, ''), name };
}

/**
 * Convert a user message's content into Harness blocks, admitting images.
 *
 * Images are promoted to durable attachments through
 * `ctx.attachments.admitPromptContent()`, which is the only path that enforces
 * the deployment's own size, count, pixel, and format limits — this file
 * deliberately re-states none of those numbers.
 * @param {object} ctx - the plugin context.
 * @param {unknown} content - the message's `content`.
 * @param {string} where - field path for error messages.
 * @returns {Promise<object[]>} Harness content blocks.
 * @throws {ApiFailure} 400 for an unsupported part or a rejected image.
 */
async function userBlocks(ctx, content, where) {
    if (typeof content === 'string') {
        return content === '' ? [] : [{ type: 'text', text: content }];
    }
    if (content === undefined || content === null) return [];
    if (!Array.isArray(content)) {
        throw new ApiFailure(400, 'invalid_request_error', `${where}.content must be a string or an array of content parts.`, 'invalid_request_error', where);
    }
    const blocks = [];
    const pending = [];
    for (const [index, part] of content.entries()) {
        const type = typeof part === 'string' ? 'text' : part?.type;
        if (type === 'text' || type === 'input_text') {
            const text = typeof part === 'string' ? part : typeof part.text === 'string' ? part.text : '';
            if (text !== '') {
                blocks.push({ type: 'text', text });
                pending.push({ type: 'text', text });
            }
            continue;
        }
        if (type === 'image_url' || type === 'input_image') {
            const { mediaType, data, name } = imagePayload(part, `${where}.content[${index}]`);
            blocks.push(null);
            pending.push({ type: 'image', mediaType, data, ...(name === undefined ? {} : { name }) });
            continue;
        }
        throw new ApiFailure(
            400,
            'unsupported_content',
            `${where}.content[${index}] has type "${String(type)}". This endpoint accepts text and image parts only.`,
            'invalid_request_error',
            where,
        );
    }
    if (!pending.some((part) => part.type === 'image')) return blocks.filter((block) => block !== null);
    const attachments = service(ctx, 'attachments');
    if (attachments === undefined || attachments === null || typeof attachments.admitPromptContent !== 'function') {
        throw new ApiFailure(503, 'attachments_unavailable', 'This profile has no attachment service, so it cannot accept inline images.', 'server_error');
    }
    let admitted;
    try {
        admitted = await attachments.admitPromptContent(pending);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ApiFailure(400, 'image_rejected', `An image in ${where} was rejected: ${detail}`, 'invalid_request_error', where);
    }
    const resolved = [];
    for (const part of admitted) {
        if (part?.type === 'text') resolved.push({ type: 'text', text: part.text });
        else if (part?.type === 'image') resolved.push({ type: 'image', attachment: part.attachment });
    }
    return resolved;
}

/**
 * Fold one assistant `tool_calls` array into text the model can still read.
 * @param {unknown} calls - the message's `tool_calls`.
 * @returns {string} one line per call, or an empty string.
 */
function foldedCalls(calls) {
    if (!Array.isArray(calls)) return '';
    const lines = [];
    for (const call of calls) {
        const name = typeof call?.function?.name === 'string' ? call.function.name : 'unknown_tool';
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}';
        const id = typeof call?.id === 'string' && call.id !== '' ? call.id : 'call';
        lines.push(`[tool call ${id}] ${name}(${args})`);
    }
    return lines.join('\n');
}

/**
 * Convert one request's `messages` into Harness request messages.
 *
 * A mid-history `system`/`developer` message is folded into the request's
 * `system` string instead of a user turn, so a client that opens with a system
 * prompt and a client that inserts one halfway both end up with the same
 * instruction text rather than a duplicated paraphrase of it.
 * @param {object} ctx - the plugin context.
 * @param {unknown[]} messages - the request's `messages` array.
 * @param {AbortSignal} [signal] - request lifetime (unused for now; kept for admission work).
 * @returns {Promise<{messages: object[], system: string, warnings: string[]}>} converted history.
 * @throws {ApiFailure} 400 for an unsupported role or malformed content.
 */
export async function toRequestMessages(ctx, messages, signal) {
    const history = [];
    const systemParts = [];
    const warnings = [];
    let folded = 0;
    for (const [index, message] of messages.entries()) {
        const where = `messages[${index}]`;
        const role = typeof message?.role === 'string' ? message.role : '';
        if (role === 'system' || role === 'developer') {
            const text = contentText(message.content);
            if (text.trim() !== '') systemParts.push(text);
            continue;
        }
        if (role === 'user') {
            const blocks = await userBlocks(ctx, message.content, where);
            const content = blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
            history.push(createUserMessage({ content, source: USER_SOURCE }));
            continue;
        }
        if (role === 'assistant') {
            const text = contentText(message.content);
            const calls = foldedCalls(message.tool_calls);
            if (calls !== '') folded += 1;
            const combined = [text, calls].filter((part) => part !== '').join('\n');
            history.push(createAssistantMessage({
                content: combined === '' ? [{ type: 'text', text: '' }] : [{ type: 'text', text: combined }],
                source: ASSISTANT_SOURCE,
            }));
            continue;
        }
        if (role === 'tool' || role === 'function') {
            const text = contentText(message.content);
            const label = role === 'tool'
                ? `[tool result ${typeof message.tool_call_id === 'string' ? message.tool_call_id : 'unknown'}]`
                : `[function result ${typeof message.name === 'string' ? message.name : 'unknown'}]`;
            folded += 1;
            history.push(createUserMessage({
                content: [{ type: 'text', text: `${label}\n${text}` }],
                source: USER_SOURCE,
            }));
            continue;
        }
        throw new ApiFailure(
            400,
            'invalid_request_error',
            `${where}.role "${role}" is not supported. Use system, developer, user, or assistant.`,
            'invalid_request_error',
            `${where}.role`,
        );
    }
    if (folded > 0) {
        warnings.push(
            'Tool history was folded into plain text: this endpoint does not serve tool calling, so the model reads past calls and results as quoted lines rather than as a tool protocol.',
        );
    }
    return { messages: history, system: systemParts.join('\n\n'), warnings };
}

/**
 * Reject a request that asks for tool calling this endpoint does not serve.
 * @param {object} body - the parsed request body.
 * @returns {void}
 * @throws {ApiFailure} 400 `tools_unsupported` when the request declares tools.
 */
export function assertNoTools(body) {
    const declared = [];
    if (Array.isArray(body?.tools) && body.tools.length > 0) declared.push('tools');
    if (Array.isArray(body?.functions) && body.functions.length > 0) declared.push('functions');
    if (body?.tool_choice !== undefined && body.tool_choice !== null) declared.push('tool_choice');
    if (declared.length === 0) return;
    throw new ApiFailure(
        400,
        'tools_unsupported',
        `This endpoint does not serve tool calling, but the request declares ${declared.join(', ')}. Remove it and ask the model for plain text: tool execution belongs to the client that owns the tools, and this profile's own tools are never lent out.`,
        'invalid_request_error',
        declared[0],
    );
}
