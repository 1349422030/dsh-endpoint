/** End-to-end request handling over a real socket: what a client actually gets. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeCtx, fakeInfo, startServer, textChunks } from './helpers.js';

/**
 * POST one JSON body and parse the response.
 * @param {string} url - server base URL.
 * @param {object} body - request body.
 * @returns {Promise<{status: number, json: object, text: string, headers: Headers}>} the answer.
 */
async function post(url, body) {
    const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
}

/**
 * POST a streaming request and parse its SSE frames.
 * @param {string} url - server base URL.
 * @param {object} body - request body; `stream` is forced on.
 * @returns {Promise<{status: number, frames: object[], text: string}>} the frames and the raw body.
 */
async function stream(url, body) {
    const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
    });
    const text = await response.text();
    const frames = text
        .split('\n\n')
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith('data:'))
        .map((frame) => frame.slice('data:'.length).trim())
        .filter((data) => data !== '[DONE]')
        .map((data) => JSON.parse(data));
    return { status: response.status, frames, text };
}

/**
 * The chunks one tool call streams, in the harness's own vocabulary: deltas
 * carrying identity on the first fragment, then the complete block.
 * @param {number} index - the block index this call occupies.
 * @param {{id: string, name: string, arguments: string, fragments?: string[]}} call - the call.
 * @returns {object[]} the chunks.
 */
function toolCallChunks(index, call) {
    const fragments = call.fragments ?? [call.arguments];
    const chunks = [{ type: 'block-start', index, blockType: 'tool-call' }];
    for (const [position, fragment] of fragments.entries()) {
        chunks.push({
            type: 'tool-call-delta',
            index,
            id: call.id,
            ...(position === 0 ? { name: call.name } : {}),
            argumentsDelta: fragment,
        });
    }
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } });
    return chunks;
}

/**
 * One call, one usage chunk, one terminal finish.
 * @param {{id: string, name: string, arguments: string, fragments?: string[]}} call - the call.
 * @param {{finish?: object|null}} [options] - `finish: null` omits the finish chunk entirely.
 * @returns {object[]} the chunks.
 */
function callChunks(call, options = {}) {
    const finish = options.finish === undefined ? { kind: 'tool-calls' } : options.finish;
    return [
        ...toolCallChunks(0, call),
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
        ...(finish === null ? [] : [{ type: 'finish', reason: finish }]),
    ];
}

/**
 * Two calls whose deltas interleave, as a parallel-call stream does.
 * @returns {object[]} the chunks.
 */
function parallelCallChunks() {
    return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read_file', argumentsDelta: '{"path":' },
        { type: 'tool-call-delta', index: 1, id: 'call_b', name: 'list_dir', argumentsDelta: '{"dir":' },
        { type: 'tool-call-delta', index: 0, id: 'call_a', argumentsDelta: '"a.txt"}' },
        { type: 'tool-call-delta', index: 1, id: 'call_b', argumentsDelta: '"."}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_b', name: 'list_dir', arguments: '{"dir":"."}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
}

/** One declaration worth sending: a tool with a real schema. */
const READ_FILE_TOOL = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
};

/** A conversation that already used a tool once. */
const TOOL_HISTORY = [
    { role: 'user', content: 'Read a.txt.' },
    {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_hist', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_hist', content: 'alpha beta' },
];

test('a plain completion answers in the OpenAI shape', async () => {
    const ctx = fakeCtx(fakeInfo(), () => textChunks());
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'low',
        });
        assert.equal(answer.status, 200);
        assert.equal(answer.json.object, 'chat.completion');
        assert.equal(answer.json.choices[0].message.role, 'assistant');
        assert.equal(answer.json.choices[0].message.content, 'Hello there.');
        assert.equal(answer.json.choices[0].message.reasoning_content, 'thinking…');
        assert.equal(answer.json.choices[0].message.tool_calls, undefined);
        assert.equal(answer.json.choices[0].finish_reason, 'stop');
        // The body stays a plain OpenAI completion: no invented fields.
        assert.equal(answer.json.dsh, undefined);
        assert.equal(answer.json.warnings, undefined);
        assert.equal(answer.headers.get('x-dsh-provider'), 'p');
        assert.deepEqual(answer.json.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        // The effort really reached the provider, translated to its own id.
        assert.equal(ctx.calls[0].reasoningEffort, 'low');
    } finally {
        await server.close();
    }
});

test('a streamed completion emits role, deltas, usage and [DONE]', async () => {
    const ctx = fakeCtx(fakeInfo(), () => textChunks());
    const server = await startServer(ctx);
    try {
        const { status, frames, text } = await stream(server.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(status, 200);
        assert.equal(frames[0].choices[0].delta.role, 'assistant');
        assert.equal(frames.filter((frame) => frame.choices?.[0]?.delta?.content).length, 2);
        assert.ok(frames.some((frame) => frame.choices?.[0]?.delta?.reasoning_content === 'thinking…'));
        const last = frames.at(-1);
        assert.equal(last.choices[0].finish_reason, 'stop');
        assert.equal(last.usage.completion_tokens, 5);
        assert.match(text.trim(), /data: \[DONE\]$/);
    } finally {
        await server.close();
    }
});

test('a completion returns tool calls in the OpenAI shape', async () => {
    const ctx = fakeCtx(fakeInfo(), () => callChunks({ id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' }));
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, { model: 'm', messages: TOOL_HISTORY, tools: [READ_FILE_TOOL] });
        assert.equal(answer.status, 200);
        const message = answer.json.choices[0].message;
        assert.equal(message.role, 'assistant');
        // A turn that is only a call has no prose to report.
        assert.equal(message.content, null);
        assert.deepEqual(message.tool_calls, [{
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }]);
        assert.equal(answer.json.choices[0].finish_reason, 'tool_calls');
        // The supplied history really became tool-call and tool-result messages.
        const sent = ctx.calls[0].messages;
        const assistant = sent.find((item) => item.role === 'assistant');
        assert.ok(assistant.content.some((block) => block.type === 'tool-call' && block.id === 'call_hist' && block.name === 'read_file'));
        const result = sent.find((item) => item.role === 'tool');
        assert.equal(result.toolCallId, 'call_hist');
    } finally {
        await server.close();
    }
});

test('prose alongside a tool call keeps its content', async () => {
    const ctx = fakeCtx(fakeInfo(), () => [
        { type: 'text-delta', index: 1, text: 'Reading it.' },
        ...toolCallChunks(0, { id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' }),
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, { model: 'm', messages: TOOL_HISTORY, tools: [READ_FILE_TOOL] });
        assert.equal(answer.status, 200);
        assert.equal(answer.json.choices[0].message.content, 'Reading it.');
        assert.equal(answer.json.choices[0].message.tool_calls[0].id, 'call_a');
        assert.equal(answer.json.choices[0].finish_reason, 'tool_calls');
    } finally {
        await server.close();
    }
});

test('tool declarations reach the provider as harness schemas', async () => {
    const ctx = fakeCtx(fakeInfo(), () => textChunks());
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                READ_FILE_TOOL,
                { type: 'function', function: { name: 'ping' } },
            ],
        });
        assert.equal(answer.status, 200);
        // An OpenAI declaration is reduced to the fields the harness uses.
        assert.deepEqual(ctx.calls[0].tools, [
            {
                name: 'read_file',
                description: 'Read a file from disk.',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
            { name: 'ping', description: '', parameters: {} },
        ]);
        // A tool-free request stays exactly the request it was.
        await post(server.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(Object.hasOwn(ctx.calls[1], 'tools'), false);
        // An empty declaration list is omitted too, not sent as [].
        await post(server.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
        assert.equal(Object.hasOwn(ctx.calls[2], 'tools'), false);
    } finally {
        await server.close();
    }
});

test('a streamed tool call arrives as OpenAI deltas', async () => {
    const ctx = fakeCtx(fakeInfo(), () => callChunks({
        id: 'call_a',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
        fragments: ['{"path":', '"a.txt"}'],
    }));
    const server = await startServer(ctx);
    try {
        const { status, frames, text } = await stream(server.url, {
            model: 'm',
            messages: TOOL_HISTORY,
            tools: [READ_FILE_TOOL],
        });
        assert.equal(status, 200);
        const entries = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
        assert.equal(entries.length, 2);
        // Identity travels once, on the first fragment of the call.
        assert.deepEqual(entries[0], {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":' },
        });
        assert.deepEqual(entries[1], { index: 0, function: { arguments: '"a.txt"}' } });
        // The pieces concatenate to exactly the arguments the model produced.
        assert.equal(entries.map((entry) => entry.function.arguments).join(''), '{"path":"a.txt"}');
        assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
        // No prose was invented for a call-only turn.
        assert.equal(frames.filter((frame) => frame.choices[0].delta.content).length, 0);
        assert.match(text.trim(), /data: \[DONE\]$/);
    } finally {
        await server.close();
    }
});

test('parallel tool calls accumulate per index', async () => {
    const ctx = fakeCtx(fakeInfo(), () => parallelCallChunks());
    const server = await startServer(ctx);
    try {
        const { frames } = await stream(server.url, {
            model: 'm',
            messages: [{ role: 'user', content: 'read a.txt and list .' }],
            tools: [READ_FILE_TOOL],
        });
        const entries = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
        const byIndex = new Map();
        for (const entry of entries) {
            const state = byIndex.get(entry.index) ?? { ids: [], names: [], arguments: '' };
            if (entry.id !== undefined) state.ids.push(entry.id);
            if (entry.function?.name !== undefined) state.names.push(entry.function.name);
            state.arguments += entry.function?.arguments ?? '';
            byIndex.set(entry.index, state);
        }
        assert.deepEqual([...byIndex.keys()], [0, 1]);
        assert.deepEqual(byIndex.get(0), { ids: ['call_a'], names: ['read_file'], arguments: '{"path":"a.txt"}' });
        assert.deepEqual(byIndex.get(1), { ids: ['call_b'], names: ['list_dir'], arguments: '{"dir":"."}' });
        assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
    } finally {
        await server.close();
    }

    // The non-streamed answer reports the same two calls, in index order.
    const plainServer = await startServer(fakeCtx(fakeInfo(), () => parallelCallChunks()));
    try {
        const answer = await post(plainServer.url, {
            model: 'm',
            messages: [{ role: 'user', content: 'read a.txt and list .' }],
            tools: [READ_FILE_TOOL],
        });
        assert.deepEqual(answer.json.choices[0].message.tool_calls.map((call) => call.id), ['call_a', 'call_b']);
        assert.deepEqual(answer.json.choices[0].message.tool_calls.map((call) => call.function.name), ['read_file', 'list_dir']);
        assert.deepEqual(
            answer.json.choices[0].message.tool_calls.map((call) => call.function.arguments),
            ['{"path":"a.txt"}', '{"dir":"."}'],
        );
        assert.equal(answer.json.choices[0].finish_reason, 'tool_calls');
    } finally {
        await plainServer.close();
    }
});

test('a stream that ends without a finish still reports tool_calls', async () => {
    const ctx = fakeCtx(fakeInfo(), () => callChunks(
        { id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { finish: null },
    ));
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, { model: 'm', messages: TOOL_HISTORY, tools: [READ_FILE_TOOL] });
        assert.equal(answer.status, 200);
        assert.equal(answer.json.choices[0].finish_reason, 'tool_calls');
        assert.equal(answer.json.choices[0].message.tool_calls.length, 1);
    } finally {
        await server.close();
    }
});

test('a stop finish alongside tool calls is reported as tool_calls', async () => {
    // Some providers end a call turn with "stop" while the calls are there. An
    // agent loop that reads "stop" ignores the calls and never answers them, so
    // the presence of calls wins over the provider's word.
    const ctx = fakeCtx(fakeInfo(), () => callChunks(
        { id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}', fragments: ['{"path":', '"a.txt"}'] },
        { finish: { kind: 'stop' } },
    ));
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, { model: 'm', messages: TOOL_HISTORY, tools: [READ_FILE_TOOL] });
        assert.equal(answer.status, 200);
        assert.equal(answer.json.choices[0].message.tool_calls.length, 1);
        assert.equal(answer.json.choices[0].finish_reason, 'tool_calls');
    } finally {
        await server.close();
    }
});

test('a truncated turn with tool calls still reports length', async () => {
    // Cutting the output can cut a call in half, so a length hit keeps its own
    // reason even when a call was already collected: the caller has to know the
    // arguments may be incomplete.
    const ctx = fakeCtx(fakeInfo(), () => callChunks(
        { id: 'call_a', name: 'read_file', arguments: '{"path":"a.tx' },
        { finish: { kind: 'max-tokens' } },
    ));
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, { model: 'm', messages: TOOL_HISTORY, tools: [READ_FILE_TOOL] });
        assert.equal(answer.status, 200);
        assert.equal(answer.json.choices[0].message.tool_calls.length, 1);
        assert.equal(answer.json.choices[0].finish_reason, 'length');
    } finally {
        await server.close();
    }
});

test('a block-end-only adapter still streams its tool calls', async () => {
    // This adapter never sends a tool-call-delta: the call exists only as the
    // complete block at block-end. The stream still has to carry it, or the last
    // frame promises tool_calls the client never received.
    const ctx = fakeCtx(fakeInfo(), () => [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
    const server = await startServer(ctx);
    try {
        const { status, frames } = await stream(server.url, {
            model: 'm',
            messages: TOOL_HISTORY,
            tools: [READ_FILE_TOOL],
        });
        assert.equal(status, 200);
        const entries = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
        // One complete first-shaped delta: identity, name and the whole arguments.
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0], {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        });
        assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
    } finally {
        await server.close();
    }
});

test('a tool call later than block zero still streams as tool call zero', async () => {
    // Harness block indexes count every content block, so a turn that speaks
    // first numbers its tool call 1. OpenAI clients index tool calls from zero;
    // a delta at index 1 with nothing at 0 would leave them a sparse array.
    const ctx = fakeCtx(fakeInfo(), () => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Checking.' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking.' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: 'call_a', name: 'read_file', argumentsDelta: '{"path":"a.txt"}' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
    const server = await startServer(ctx);
    try {
        const { frames } = await stream(server.url, {
            model: 'm',
            messages: TOOL_HISTORY,
            tools: [READ_FILE_TOOL],
        });
        const entries = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].index, 0);
        assert.equal(entries[0].id, 'call_a');
        assert.equal(entries[0].function.arguments, '{"path":"a.txt"}');
    } finally {
        await server.close();
    }
});

test('a call already streamed as deltas is not sent again at the end', async () => {
    const ctx = fakeCtx(fakeInfo(), () => callChunks({
        id: 'call_a',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
        fragments: ['{"path":', '"a.txt"}'],
    }));
    const server = await startServer(ctx);
    try {
        const { frames } = await stream(server.url, {
            model: 'm',
            messages: TOOL_HISTORY,
            tools: [READ_FILE_TOOL],
        });
        const entries = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
        // Exactly the two fragments: no third, complete delta repeated at the end.
        assert.equal(entries.length, 2);
        assert.equal(entries.filter((entry) => entry.id !== undefined).length, 1);
        assert.equal(entries.filter((entry) => entry.function.arguments === '{"path":"a.txt"}').length, 0);
        assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
    } finally {
        await server.close();
    }
});

test('a malformed tool declaration is refused', async () => {
    const server = await startServer(fakeCtx(fakeInfo(), () => textChunks()));
    try {
        const declarations = [
            // No name.
            [{ type: 'function', function: { description: 'nameless' } }],
            // Parameters are not a schema object.
            [{ type: 'function', function: { name: 'x', parameters: [] } }],
            // Not a function declaration at all.
            [{ type: 'function', function: 'nope' }],
        ];
        for (const tools of declarations) {
            const answer = await post(server.url, {
                model: 'm',
                messages: [{ role: 'user', content: 'hi' }],
                tools,
            });
            assert.equal(answer.status, 400);
            assert.equal(answer.json.error.type, 'invalid_request_error');
            assert.equal(answer.json.error.code, 'invalid_request_error');
            assert.equal(answer.json.error.param, 'tools');
        }
    } finally {
        await server.close();
    }
});

test('an image is refused before upload when the model takes text only', async () => {
    const info = fakeInfo({ inputModalities: ['text'] });
    const server = await startServer(fakeCtx(info, () => textChunks()));
    try {
        const answer = await post(server.url, {
            model: 'm',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'what is this?' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
                ],
            }],
        });
        assert.equal(answer.status, 400);
        assert.equal(answer.json.error.code, 'images_unsupported');
        assert.equal(answer.json.error.param, 'messages');
    } finally {
        await server.close();
    }
});

test('an output limit above the model ceiling is clamped and reported', async () => {
    const ctx = fakeCtx(fakeInfo(), () => textChunks());
    const server = await startServer(ctx);
    try {
        const answer = await post(server.url, {
            model: 'm',
            max_tokens: 999_999,
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert.equal(answer.status, 200);
        assert.equal(ctx.calls[0].maxTokens, 1_000);
        assert.match(answer.headers.get('x-dsh-warning') ?? '', /max_tokens 999999/);
    } finally {
        await server.close();
    }
});

test('a browser client is allowed to read the outcome headers', async () => {
    // CORS hides every response header from a browser unless it is exposed, so
    // the facts this endpoint reports out of band would be invisible without
    // an explicit list.
    const server = await startServer(fakeCtx(fakeInfo(), () => textChunks()));
    try {
        const answer = await post(server.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        const exposed = (answer.headers.get('access-control-expose-headers') ?? '')
            .split(',')
            .map((name) => name.trim());
        for (const name of ['x-dsh-provider', 'x-dsh-model', 'x-dsh-thinking', 'x-dsh-reasoning-effort', 'x-dsh-warning']) {
            assert.ok(exposed.includes(name), `${name} is not exposed`);
        }
    } finally {
        await server.close();
    }
});

test('an unknown model names the ones that exist', async () => {
    const server = await startServer(fakeCtx(fakeInfo(), () => textChunks()));
    try {
        const answer = await post(server.url, { model: 'nope', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(answer.status, 404);
        assert.equal(answer.json.error.code, 'model_not_found');
        assert.match(answer.json.error.message, /published model\(s\): m/);
    } finally {
        await server.close();
    }
});
test('an alias is what the answer calls the model, and the route stays visible in the headers', async () => {
    const ctx = fakeCtx(fakeInfo(), () => textChunks());
    const server = await startServer(ctx, { modelIds: { 'p/m': 'mind' } });
    try {
        const answer = await post(server.url, { model: 'mind', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(answer.status, 200);
        // The id the caller used comes back unchanged, so request and answer match.
        assert.equal(answer.json.model, 'mind');
        // The truth about which provider/model served it is out of band.
        assert.equal(answer.headers.get('x-dsh-provider'), 'p');
        assert.equal(answer.headers.get('x-dsh-model'), 'm');
        const { frames } = await stream(server.url, { model: 'mind', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(frames[0].model, 'mind');
    } finally {
        await server.close();
    }
});

test('a model left out of the exposure list cannot be used', async () => {
    const rows = [{ provider: 'p', id: 'm', name: 'M' }, { provider: 'p', id: 'other', name: 'Other' }];
    const server = await startServer(fakeCtx(fakeInfo(), () => textChunks(), rows), { expose: ['p/other'] });
    try {
        const answer = await post(server.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(answer.status, 404);
        assert.equal(answer.json.error.code, 'model_not_found');
    } finally {
        await server.close();
    }
});

