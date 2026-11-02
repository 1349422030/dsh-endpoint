/** Wire-format conversion: messages, tool history, and tool declarations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toRequestMessages, toolsOf } from '../lib/protocol.js';

const ctx = { get: () => undefined };

/**
 * Assert that reading `body`'s tools is refused as a malformed request.
 * @param {object} body - the request body to read.
 * @param {RegExp} pattern - what the message must say.
 * @returns {void}
 */
function refused(body, pattern) {
    assert.throws(() => toolsOf(body), (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_request_error');
        assert.equal(error.param, 'tools');
        assert.match(error.message, pattern);
        return true;
    });
}

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

test('tools are mapped to harness schemas, with defaults for missing fields', () => {
    const { tools, warnings } = toolsOf({
        tools: [
            { type: 'function', function: { name: 'read_file' } },
            {
                type: 'function',
                function: {
                    name: 'write_file',
                    description: 'Write a file.',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            },
        ],
    });
    assert.equal(tools.length, 2);
    assert.deepEqual(tools[0], { name: 'read_file', description: '', parameters: {} });
    assert.equal(tools[1].description, 'Write a file.');
    assert.deepEqual(tools[1].parameters, { type: 'object', properties: { path: { type: 'string' } } });
    assert.deepEqual(warnings, []);
});

test('a request without tools still yields an empty array', () => {
    assert.deepEqual(toolsOf({}), { tools: [], warnings: [] });
    assert.deepEqual(toolsOf({ tools: [], functions: [] }).tools, []);
    assert.deepEqual(toolsOf(undefined).tools, []);
});

test('a malformed tool declaration is refused by name', () => {
    refused({ tools: [{ type: 'retrieval', function: { name: 't' } }] }, /tools\[0\]\.type must be "function"/);
    refused({ tools: [{ type: 'function', function: { name: '' } }] }, /tools\[0\]\.function\.name must be a non-empty string/);
    refused({ tools: [{ type: 'function', function: { name: 't', parameters: '{}' } }] }, /tools\[0\]\.function\.parameters must be a JSON Schema object/);
    refused({ tools: [{ type: 'function', function: { name: 't', parameters: null } }] }, /tools\[0\]\.function\.parameters/);
    refused({ tools: [{ type: 'function', function: { name: 'ok' } }, { type: 'function', function: { name: 'bad', parameters: [] } }] }, /tools\[1\]\.function\.parameters/);
    refused({ tools: [{ type: 'function', function: { name: 'ok' } }, 'text', { type: 'function', function: { name: 'other' } }] }, /tools\[1\] must be an object/);
    refused({ tools: 'read_file' }, /tools must be an array/);
    refused({ functions: [{ name: '' }] }, /functions\[0\]\.name must be a non-empty string/);
});

test('legacy functions are merged with tools, the later declaration winning', () => {
    const { tools } = toolsOf({
        tools: [{ type: 'function', function: { name: 'read_file', description: 'from tools' } }],
        functions: [
            { name: 'read_file', description: 'from functions', parameters: { type: 'object' } },
            { name: 'list_dir' },
        ],
    });
    assert.deepEqual(tools.map((tool) => tool.name), ['read_file', 'list_dir']);
    assert.equal(tools[0].description, 'from functions');
    assert.deepEqual(tools[0].parameters, { type: 'object' });
    assert.deepEqual(tools[1], { name: 'list_dir', description: '', parameters: {} });
});

test('tool_choice and parallel_tool_calls are accepted but reported as ignored', () => {
    const single = toolsOf({ tools: [], tool_choice: 'auto' });
    assert.equal(single.warnings.length, 1);
    assert.match(single.warnings[0], /tool_choice/);
    assert.match(single.warnings[0], /accepted but ignored/);
    assert.match(single.warnings[0], /no corresponding field/);

    const both = toolsOf({ tools: [], tool_choice: 'required', parallel_tool_calls: false });
    assert.equal(both.warnings.length, 1);
    assert.match(both.warnings[0], /tool_choice and parallel_tool_calls were accepted but ignored/);

    assert.deepEqual(toolsOf({ tools: [], tool_choice: null }).warnings, []);
});

test('assistant tool calls become tool-call blocks carrying the raw arguments string', async () => {
    const result = await toRequestMessages(ctx, [
        { role: 'user', content: 'weather?' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Oslo"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'snow' },
    ]);
    const [user, assistant, tool] = result.messages;
    assert.equal(user.role, 'user');
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content.map((block) => block.type), ['tool-call']);
    assert.equal(assistant.content[0].id, 'call_1');
    assert.equal(assistant.content[0].name, 'get_weather');
    assert.equal(assistant.content[0].arguments, '{"city": "Oslo"}');
    assert.equal(typeof assistant.content[0].arguments, 'string');
    assert.equal(tool.role, 'tool');
    assert.equal(tool.toolCallId, 'call_1');
    assert.equal(tool.source.kind, 'tool');
    assert.equal(tool.source.callId, 'call_1');
    assert.deepEqual(tool.content, [{ type: 'text', text: 'snow' }]);
    assert.equal(tool.isError, false);
    assert.deepEqual(result.warnings, []);
});

test('an assistant text block precedes its tool-call blocks', async () => {
    const result = await toRequestMessages(ctx, [
        {
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [
                { id: 'call_a', function: { name: 'one', arguments: '{}' } },
                { id: 'call_b', function: { name: 'two', arguments: '{"x":1}' } },
            ],
        },
    ]);
    assert.deepEqual(result.messages[0].content.map((block) => block.type), ['text', 'tool-call', 'tool-call']);
    assert.equal(result.messages[0].content[1].arguments, '{}');
    assert.equal(result.messages[0].content[2].arguments, '{"x":1}');
});

test('empty tool call arguments become an empty JSON object', async () => {
    const result = await toRequestMessages(ctx, [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
    const assistant = result.messages[0];
    assert.deepEqual(assistant.content.map((block) => block.type), ['tool-call']);
    assert.equal(assistant.content[0].arguments, '{}');
    assert.equal(assistant.content[0].name, 'list_dir');
});

test('an assistant message with no content and no tool calls keeps one empty text block', async () => {
    const result = await toRequestMessages(ctx, [{ role: 'assistant', content: null }]);
    assert.deepEqual(result.messages[0].content, [{ type: 'text', text: '' }]);
});

test('tool call arguments that are not JSON are refused', async () => {
    await assert.rejects(
        () => toRequestMessages(ctx, [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 't', arguments: '{"a":' } }] },
        ]),
        (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.code, 'invalid_request_error');
            assert.equal(error.param, 'messages');
            assert.match(error.message, /messages\[0\]\.tool_calls\[0\]\.function\.arguments is not valid JSON/);
            return true;
        },
    );
    await assert.rejects(
        () => toRequestMessages(ctx, [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 't', arguments: { a: 1 } } }] },
        ]),
        (error) => error.status === 400 && error.code === 'invalid_request_error' && error.param === 'messages',
    );
});

test('a legacy function result becomes a tool result keyed by its name', async () => {
    const result = await toRequestMessages(ctx, [
        { role: 'user', content: 'weather?' },
        { role: 'function', name: 'get_weather', content: 'snow' },
    ]);
    const tool = result.messages[1];
    assert.equal(tool.role, 'tool');
    assert.equal(tool.toolCallId, 'get_weather');
    assert.equal(tool.source.callId, 'get_weather');
    assert.deepEqual(tool.content, [{ type: 'text', text: 'snow' }]);
});

test('the whole body can be passed so tool declarations are resolved in the same pass', async () => {
    const result = await toRequestMessages(ctx, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'read_file' } }],
        tool_choice: 'auto',
    });
    assert.deepEqual(result.tools.map((tool) => tool.name), ['read_file']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /tool_choice/);
});

test('a messages array alone yields an empty tool list', async () => {
    const result = await toRequestMessages(ctx, [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.warnings, []);
});

test('an unknown role is refused', async () => {
    await assert.rejects(
        () => toRequestMessages(ctx, [{ role: 'narrator', content: 'x' }]),
        (error) => error.status === 400 && error.code === 'invalid_request_error',
    );
});
