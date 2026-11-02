/**
 * dsh-endpoint — OpenAI wire protocol to Harness messages.
 *
 * The only file that knows what an OpenAI `messages` array and an OpenAI `tools`
 * declaration look like. Turns them into the messages, tool-call history, and
 * tool schemas `ctx.llm.stream` accepts, including image parts. This endpoint
 * never executes a tool: declarations go up to the model, and calls come back
 * to the client that owns them. Owns no model semantics and no transport.
 */
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
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
 * Name a JSON value's shape for an error message.
 * @param {unknown} value - the offending value.
 * @returns {string} wording that completes "got …".
 */
function jsonKind(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    switch (typeof value) {
        case 'string': return 'a string';
        case 'number': return 'a number';
        case 'boolean': return 'a boolean';
        case 'undefined': return 'nothing';
        default: return 'an object';
    }
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
 * Convert one declared tool into a Harness `ToolSchema`.
 *
 * Only the fields the harness uses are kept. `description` defaults to an empty
 * string, and `parameters` to an empty object, so a declaration without either
 * is still a usable schema rather than a rejected request.
 * @param {unknown} value - one `tools[].function` or one `functions[]` entry.
 * @param {string} where - field path for error messages.
 * @returns {{name: string, description: string, parameters: object}} the schema.
 * @throws {ApiFailure} 400 when the entry is not a usable tool declaration.
 */
function toolSchema(value, where) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiFailure(400, 'invalid_request_error', `${where} must be an object describing one tool; got ${jsonKind(value)}.`, 'invalid_request_error', 'tools');
    }
    if (typeof value.name !== 'string' || value.name === '') {
        throw new ApiFailure(400, 'invalid_request_error', `${where}.name must be a non-empty string; got ${jsonKind(value.name)}.`, 'invalid_request_error', 'tools');
    }
    let parameters = {};
    if (value.parameters !== undefined) {
        if (value.parameters === null || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) {
            throw new ApiFailure(400, 'invalid_request_error', `${where}.parameters must be a JSON Schema object; got ${jsonKind(value.parameters)}.`, 'invalid_request_error', 'tools');
        }
        parameters = value.parameters;
    }
    return {
        name: value.name,
        description: typeof value.description === 'string' ? value.description : '',
        parameters,
    };
}

/**
 * Read a request's tool declarations as Harness `ToolSchema` values.
 *
 * The OpenAI `tools` array is the modern form; a legacy `functions` array is
 * accepted and merged with it by name, and a later declaration of the same name
 * replaces an earlier one. `tool_choice` and `parallel_tool_calls` have no
 * harness counterpart: a request that sends them is served unchanged, and told
 * so through `warnings`.
 * @param {object} body - the parsed request body.
 * @returns {{tools: object[], warnings: string[]}} the declarations (always an array) and advisory notes.
 * @throws {ApiFailure} 400 `invalid_request_error`, `param: "tools"`, for a malformed declaration.
 */
export function toolsOf(body) {
    const byName = new Map();
    const tools = body?.tools;
    if (tools !== undefined && tools !== null) {
        if (!Array.isArray(tools)) {
            throw new ApiFailure(400, 'invalid_request_error', `tools must be an array of tool declarations; got ${jsonKind(tools)}.`, 'invalid_request_error', 'tools');
        }
        for (const [index, tool] of tools.entries()) {
            const where = `tools[${index}]`;
            if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
                throw new ApiFailure(400, 'invalid_request_error', `${where} must be an object; got ${jsonKind(tool)}.`, 'invalid_request_error', 'tools');
            }
            if (tool.type !== 'function') {
                const got = typeof tool.type === 'string' ? `"${tool.type}"` : jsonKind(tool.type);
                throw new ApiFailure(400, 'invalid_request_error', `${where}.type must be "function"; got ${got}.`, 'invalid_request_error', 'tools');
            }
            const schema = toolSchema(tool.function, `${where}.function`);
            byName.set(schema.name, schema);
        }
    }
    const functions = body?.functions;
    if (functions !== undefined && functions !== null) {
        if (!Array.isArray(functions)) {
            throw new ApiFailure(400, 'invalid_request_error', `functions must be an array of tool declarations; got ${jsonKind(functions)}.`, 'invalid_request_error', 'tools');
        }
        for (const [index, fn] of functions.entries()) {
            const schema = toolSchema(fn, `functions[${index}]`);
            byName.set(schema.name, schema);
        }
    }
    const warnings = [];
    const ignored = [];
    if (body?.tool_choice !== undefined && body.tool_choice !== null) ignored.push('tool_choice');
    if (body?.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) ignored.push('parallel_tool_calls');
    if (ignored.length > 0) {
        const verb = ignored.length === 1 ? 'was' : 'were';
        warnings.push(`${ignored.join(' and ')} ${verb} accepted but ignored: the Harness request has no corresponding field.`);
    }
    return { tools: [...byName.values()], warnings };
}

/**
 * Convert one assistant message's `tool_calls` into Harness tool-call blocks.
 *
 * `arguments` is passed through as the exact JSON string the client sent, which
 * is also what dsh-llm's `ToolCallBlock` carries, so re-serialising it here
 * could change the model's own formatting. It is parsed once anyway: a string
 * that is not JSON would otherwise fail much deeper with a far less useful
 * error.
 * @param {unknown} calls - the message's `tool_calls`.
 * @param {string} where - field path for error messages.
 * @returns {object[]} Harness tool-call blocks.
 * @throws {ApiFailure} 400 when a call is malformed or its arguments are not JSON.
 */
function toolCallBlocks(calls, where) {
    if (calls === undefined || calls === null) return [];
    if (!Array.isArray(calls)) {
        throw new ApiFailure(400, 'invalid_request_error', `${where}.tool_calls must be an array; got ${jsonKind(calls)}.`, 'invalid_request_error', 'messages');
    }
    const blocks = [];
    for (const [index, call] of calls.entries()) {
        const at = `${where}.tool_calls[${index}]`;
        const sent = call?.function?.arguments;
        if (typeof sent !== 'string') {
            throw new ApiFailure(400, 'invalid_request_error', `${at}.function.arguments must be a JSON string; got ${jsonKind(sent)}.`, 'invalid_request_error', 'messages');
        }
        // Upstreams send "" for a call with no parameters, and "" is not JSON;
        // treating it as "{}" keeps a parameterless call replayable instead of
        // failing history the client already holds.
        const raw = sent === '' ? '{}' : sent;
        try {
            JSON.parse(raw);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new ApiFailure(400, 'invalid_request_error', `${at}.function.arguments is not valid JSON: ${detail}`, 'invalid_request_error', 'messages');
        }
        const name = typeof call?.function?.name === 'string' ? call.function.name : '';
        // A call without an id cannot be correlated by the client either way;
        // a local placeholder keeps the history structurally valid.
        const id = typeof call?.id === 'string' && call.id !== '' ? call.id : `call_${index}`;
        blocks.push({ type: 'tool-call', id, name, arguments: raw });
    }
    return blocks;
}

/**
 * Convert one client-supplied tool result into a Harness tool message.
 * @param {unknown} content - the message's `content`.
 * @param {string} callId - the call this result answers.
 * @returns {object} a frozen tool-role message.
 */
function toolResultMessage(content, callId) {
    return createToolResultMessage({
        callId,
        content: [{ type: 'text', text: contentText(content) }],
        isError: false,
    });
}

/**
 * Convert one request's `messages` into Harness request messages.
 *
 * A mid-history `system`/`developer` message is folded into the request's
 * `system` string instead of a user turn, so a client that opens with a system
 * prompt and a client that inserts one halfway both end up with the same
 * instruction text rather than a duplicated paraphrase of it.
 *
 * The second argument is the messages array, or the whole request body when the
 * caller wants the tool declarations resolved in the same pass; an array keeps
 * the original signature working and yields an empty `tools` list.
 * @param {object} ctx - the plugin context.
 * @param {unknown[]|object} request - the request's `messages`, or the request body.
 * @param {AbortSignal} [signal] - request lifetime (unused for now; kept for admission work).
 * @returns {Promise<{messages: object[], system: string, tools: object[], warnings: string[]}>} converted history and tool declarations.
 * @throws {ApiFailure} 400 for an unsupported role, malformed content, or bad tool history.
 */
export async function toRequestMessages(ctx, request, signal) {
    const messages = Array.isArray(request) ? request : Array.isArray(request?.messages) ? request.messages : undefined;
    if (messages === undefined) {
        throw new ApiFailure(400, 'invalid_request_error', 'messages must be an array.', 'invalid_request_error', 'messages');
    }
    const declared = Array.isArray(request) ? { tools: [], warnings: [] } : toolsOf(request);
    const history = [];
    const systemParts = [];
    const warnings = [...declared.warnings];
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
            const calls = toolCallBlocks(message.tool_calls, where);
            const content = [];
            // A message that is nothing but tool calls carries no text block at
            // all: an empty one would read as "the assistant said nothing here".
            if (text !== '' || calls.length === 0) content.push({ type: 'text', text });
            content.push(...calls);
            history.push(createAssistantMessage({ content, source: ASSISTANT_SOURCE }));
            continue;
        }
        if (role === 'tool') {
            const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
            history.push(toolResultMessage(message.content, callId));
            continue;
        }
        if (role === 'function') {
            // Legacy function-calling clients answer with the function name
            // instead of a call id; that name is all the correlation they have.
            const callId = typeof message.name === 'string' ? message.name : '';
            history.push(toolResultMessage(message.content, callId));
            continue;
        }
        throw new ApiFailure(
            400,
            'invalid_request_error',
            `${where}.role "${role}" is not supported. Use system, developer, user, assistant, tool, or function.`,
            'invalid_request_error',
            `${where}.role`,
        );
    }
    return { messages: history, system: systemParts.join('\n\n'), tools: declared.tools, warnings };
}
