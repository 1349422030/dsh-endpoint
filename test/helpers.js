/**
 * Test doubles: a fake LLM registry, a fake model, and a real HTTP server whose
 * only handler is `handleChat`. Requests go over a socket so the response
 * shapes under test are the ones clients actually receive.
 */
import { createServer } from 'node:http';
import { handleChat } from '../lib/chat.js';
import { failRequest } from '../lib/http.js';

/**
 * A resolved model description with the fields this endpoint reads.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} a fake LlmResolvedModelInfo.
 */
export function fakeInfo(overrides = {}) {
    return {
        provider: 'p',
        id: 'm',
        name: 'Model M',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 100_000 },
        defaultMaxTokens: 1_000,
        reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
        },
        ...overrides,
    };
}

/**
 * A plugin context exposing only the `llm` surface `handleChat` uses.
 * @param {object} info - what `resolveModelInfo` returns.
 * @param {function(object): object[]} chunks - produces the chunk stream for one call.
 * @returns {object} the fake context, with a `calls` array of stream options.
 */
export function fakeCtx(info, chunks) {
    const calls = [];
    return {
        calls,
        get: () => undefined,
        llm: {
            listProviders: () => [{ id: 'p' }],
            listModels: async () => [{ id: 'm', name: 'Model M' }],
            resolveModelInfo: async () => info,
            stream: (options) => {
                calls.push(options);
                return (async function* stream() {
                    for (const chunk of chunks(options)) yield chunk;
                })();
            },
        },
    };
}

/**
 * Serve `handleChat` on an ephemeral loopback port.
 * @param {object} ctx - the fake context.
 * @param {object} [settings] - settings snapshot overrides.
 * @returns {Promise<{url: string, close: function(): Promise<void>}>} the server.
 */
export async function startServer(ctx, settings = {}) {
    const merged = {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        apiKey: '',
        requestTimeoutMs: 10_000,
        provider: '',
        model: '',
        corsOrigin: '*',
        ...settings,
    };
    const server = createServer((request, response) => {
        handleChat({ ctx, settings: merged, bound: { port: 0 }, request, response })
            .catch((error) => failRequest(response, error));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
        url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/**
 * A plain text completion stream: one reasoning chunk, two text chunks, usage, finish.
 * @returns {object[]} the chunks.
 */
export function textChunks() {
    return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'reasoning-delta', index: 0, text: 'thinking…' },
        { type: 'text-delta', index: 0, text: 'Hello' },
        { type: 'text-delta', index: 0, text: ' there.' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello there.' } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { type: 'finish', reason: { kind: 'stop' } },
    ];
}
