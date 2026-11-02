/** End-to-end request handling over a real socket: what a client actually gets. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeCtx, fakeInfo, startServer, textChunks } from './helpers.js';

/**
 * POST one JSON body and parse the response.
 * @param {string} url - server base URL.
 * @param {object} body - request body.
 * @returns {Promise<{status: number, json: object, text: string}>} the answer.
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
    return { status: response.status, json, text };
}

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
        assert.equal(answer.json.choices[0].finish_reason, 'stop');
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
        const response = await fetch(`${server.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
        const frames = (await response.text())
            .split('\n\n')
            .map((frame) => frame.trim())
            .filter((frame) => frame.startsWith('data:'))
            .map((frame) => frame.slice('data:'.length).trim())
            .filter((data) => data !== '[DONE]')
            .map((data) => JSON.parse(data));
        assert.equal(frames[0].choices[0].delta.role, 'assistant');
        assert.equal(frames.filter((frame) => frame.choices?.[0]?.delta?.content).length, 2);
        assert.ok(frames.some((frame) => frame.choices?.[0]?.delta?.reasoning_content === 'thinking…'));
        const last = frames.at(-1);
        assert.equal(last.choices[0].finish_reason, 'stop');
        assert.equal(last.usage.completion_tokens, 5);
    } finally {
        await server.close();
    }
});

test('declared tools are refused instead of silently dropped', async () => {
    const server = await startServer(fakeCtx(fakeInfo(), () => textChunks()));
    try {
        const answer = await post(server.url, {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
        });
        assert.equal(answer.status, 400);
        assert.equal(answer.json.error.code, 'tools_unsupported');
        assert.equal(answer.json.error.param, 'tools');
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
        assert.ok(answer.json.warnings.some((warning) => /max_tokens 999999/.test(warning)));
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
        assert.match(answer.json.error.message, /p\/m/);
    } finally {
        await server.close();
    }
});
