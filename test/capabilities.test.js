/** Model routing and effort translation, without any network or registry. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesOf, resolveEffort, routeLabel } from '../lib/capabilities.js';
import { fakeInfo } from './helpers.js';

test('capabilities mirror the resolved model and never invent a tool surface', () => {
    const capabilities = capabilitiesOf(fakeInfo());
    assert.equal(capabilities.context_length, 100_000);
    assert.equal(capabilities.max_output_tokens, 1_000);
    assert.deepEqual(capabilities.input_modalities, ['text', 'image']);
    assert.equal(capabilities.tool_calls, false);
    assert.equal(capabilities.reasoning.supported, true);
    assert.equal(capabilities.reasoning.default_effort, 'high');
});

test('an unknown model yields an all-unknown capability object', () => {
    const capabilities = capabilitiesOf(undefined);
    assert.equal(capabilities.context_length, null);
    assert.equal(capabilities.max_output_tokens, null);
    // null, not []: the profile declares nothing, which is not the same claim as "text only".
    assert.equal(capabilities.input_modalities, null);
    assert.equal(capabilities.reasoning.supported, false);
});

test('a declared effort passes through untouched', () => {
    const decided = resolveEffort(fakeInfo(), { reasoning_effort: 'low' });
    assert.equal(decided.effort, 'low');
    assert.equal(decided.warning, undefined);
});

test('off maps to the lowest declared effort, with a warning when there is no switch', () => {
    const decided = resolveEffort(fakeInfo(), { reasoning_effort: 'none' });
    assert.equal(decided.effort, 'low');
    assert.match(decided.warning, /no off switch/);
});

test('an off effort id is honoured when the model declares one', () => {
    const info = fakeInfo({
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    });
    const decided = resolveEffort(info, { enable_thinking: false });
    assert.equal(decided.effort, 'off');
    assert.equal(decided.thinking, false);
    assert.equal(decided.warning, undefined);
});

test('a familiar name lands on the nearest declared effort', () => {
    const decided = resolveEffort(fakeInfo(), { reasoning_effort: 'medium' });
    // low (1) and high (3) are both one step from medium (2); the cheaper one wins.
    assert.equal(decided.effort, 'low');
    assert.match(decided.warning, /nearest effort/);
});

test('a model with no reasoning ignores the request instead of failing', () => {
    const decided = resolveEffort(fakeInfo({ reasoning: undefined }), { reasoning_effort: 'high' });
    assert.equal(decided.effort, undefined);
    assert.equal(decided.thinking, false);
    assert.match(decided.warning, /no reasoning efforts/);
});

test('route labels stay provider-qualified', () => {
    assert.equal(routeLabel({ provider: 'commandcode', id: 'deepseek/x' }), 'commandcode/deepseek/x');
});
