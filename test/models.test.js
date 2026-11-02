/** The model catalogue: OpenRouter's schema, and nothing invented on top of it. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeCtx, fakeInfo } from './helpers.js';
import { listModels, modelById } from '../lib/models.js';

test('a model card carries the OpenRouter fields and no private ones', async () => {
    const list = await listModels(fakeCtx(fakeInfo()));
    const card = list.data[0];
    assert.equal(list.object, 'list');
    assert.equal(card.object, 'model');
    assert.equal(card.id, 'm');
    assert.equal(card.context_length, 100_000);
    assert.deepEqual(card.architecture.input_modalities, ['text', 'image']);
    assert.equal(card.architecture.modality, 'text+image->text');
    assert.equal(card.top_provider.max_completion_tokens, 1_000);
    assert.deepEqual(card.reasoning.supported_efforts, ['low', 'high']);
    assert.equal(card.reasoning.default_effort, 'high');
    assert.equal(card.capabilities, undefined);
});

test('a model with no declared metadata degrades to nulls instead of guesses', async () => {
    const list = await listModels(fakeCtx(undefined));
    const card = list.data[0];
    assert.equal(card.context_length, null);
    assert.equal(card.architecture, null);
    assert.equal(card.top_provider, null);
    assert.equal(card.reasoning, null);
    assert.deepEqual(card.supported_parameters, ['max_tokens', 'stop', 'temperature', 'tools']);
});

test('supported_parameters advertises tools, which the endpoint passes through', async () => {
    const list = await listModels(fakeCtx(fakeInfo()));
    const card = list.data[0];
    assert.ok(card.supported_parameters.includes('tools'));
    assert.deepEqual(
        card.supported_parameters,
        ['max_tokens', 'stop', 'temperature', 'tools', 'reasoning', 'reasoning_effort'],
    );
});

test('a model is addressable by bare id and by provider-qualified id', async () => {
    const ctx = fakeCtx(fakeInfo());
    assert.equal((await modelById(ctx, 'm')).id, 'm');
    assert.equal((await modelById(ctx, 'p/m')).id, 'm');
    assert.equal(await modelById(ctx, 'nope'), undefined);
});
