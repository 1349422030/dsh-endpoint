/** Wire-format conversion: the rules a client's history is folded by. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoTools, toRequestMessages } from '../lib/protocol.js';

const ctx = { get: () => undefined };

test('system and developer messages become one system string', async () => {
    const result = await toRequestMessages(ctx, [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'and precise' },
    ]);
    assert.equal(result.system, 'be brief\n\nand precise');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
});

test('assistant tool calls are folded into readable text', async () => {
    const result = await toRequestMessages(ctx, [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'snow' },
    ]);
    const assistant = result.messages[1];
    assert.equal(assistant.content[0].text, '[tool call call_1] get_weather({"city":"Oslo"})');
    const tool = result.messages[2];
    assert.equal(tool.role, 'user');
    assert.match(tool.content[0].text, /^\[tool result call_1\]/);
    assert.equal(result.warnings.length, 1);
});

test('an unknown role is refused', async () => {
    await assert.rejects(
        () => toRequestMessages(ctx, [{ role: 'narrator', content: 'x' }]),
        (error) => error.status === 400 && error.code === 'invalid_request_error',
    );
});

test('declared tools are refused by name', () => {
    assert.throws(
        () => assertNoTools({ tools: [{ type: 'function', function: { name: 't' } }] }),
        (error) => error.status === 400 && error.code === 'tools_unsupported' && error.param === 'tools',
    );
    assert.doesNotThrow(() => assertNoTools({ tools: [] }));
});
