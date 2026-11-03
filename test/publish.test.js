/** Published names and the exposure list: which models exist, and what they are called. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedRows, resolveRoute } from '../lib/capabilities.js';
import { listModels, modelById } from '../lib/models.js';
import { fakeCtx, fakeInfo } from './helpers.js';

/** Two providers shipping the same model id, which is the case aliases exist for. */
const ROWS = [
    { provider: 'alpha', id: 'deepseek/flash', name: 'Flash (alpha)' },
    { provider: 'beta', id: 'deepseek/flash', name: 'Flash (beta)' },
    { provider: 'alpha', id: 'solo', name: 'Solo' },
];

/**
 * A context over {@link ROWS}.
 * @returns {object} the fake context.
 */
function registry() {
    return fakeCtx(fakeInfo(), () => [], ROWS);
}

test('without configuration, a colliding id is qualified and the rest stay bare', async () => {
    const rows = await publishedRows(registry(), {});
    assert.deepEqual(rows.map((row) => row.publicId), [
        'alpha/deepseek/flash',
        'solo',
        'beta/deepseek/flash',
    ]);
});

test('a configured alias names a model and hides the provider layout', async () => {
    const rows = await publishedRows(registry(), {
        modelIds: { 'alpha/deepseek/flash': 'flash' },
    });
    assert.equal(rows[0].publicId, 'flash');
    // The other provider keeps an automatic name, and its bare id is free again
    // once the twin is published as "flash": one alias does not rename both.
    assert.equal(rows.find((row) => row.provider === 'beta').publicId, 'deepseek/flash');
});

test('an alias is routable and is echoed back as the published name', async () => {
    const settings = { modelIds: { 'beta/deepseek/flash': 'flash' } };
    const route = await resolveRoute(registry(), settings, undefined, 'flash');
    assert.deepEqual(route, { provider: 'beta', model: 'deepseek/flash', publicId: 'flash' });
    // Asking by the real route still works, and the answer says what was asked.
    const byRoute = await resolveRoute(registry(), settings, undefined, 'beta/deepseek/flash');
    assert.deepEqual(byRoute, { provider: 'beta', model: 'deepseek/flash', publicId: 'beta/deepseek/flash' });
});

test('the exposure list decides what exists, not merely what is advertised', async () => {
    const ctx = registry();
    const settings = { expose: ['alpha/*'] };
    const rows = await publishedRows(ctx, settings);
    assert.deepEqual(rows.map((row) => row.publicId), ['deepseek/flash', 'solo']);
    // Two routes are gone from the list, so the survivor keeps its bare id.
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'beta/deepseek/flash'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
    const listed = await listModels(ctx, settings);
    assert.deepEqual(listed.data.map((card) => card.id), ['deepseek/flash', 'solo']);
});

test('an exact route in the exposure list publishes only that model', async () => {
    const rows = await publishedRows(registry(), { expose: ['alpha/solo'] });
    assert.deepEqual(rows.map((row) => row.publicId), ['solo']);
});

test('an unexposed model is not addressable through the model card either', async () => {
    const ctx = registry();
    const settings = { expose: ['alpha/solo'] };
    assert.equal(await modelById(ctx, settings, 'alpha/deepseek/flash'), undefined);
    assert.equal((await modelById(ctx, settings, 'solo')).id, 'solo');
});

test('two models configured with one alias keep two routable names', async () => {
    const settings = { modelIds: { 'alpha/deepseek/flash': 'flash', 'beta/deepseek/flash': 'flash' } };
    const rows = await publishedRows(registry(), settings);
    // The first alias wins; the second model falls back rather than becoming unroutable.
    assert.equal(rows[0].publicId, 'flash');
    const beta = rows.find((row) => row.provider === 'beta');
    assert.notEqual(beta.publicId, 'flash');
    const route = await resolveRoute(registry(), settings, undefined, beta.publicId);
    assert.equal(route.provider, 'beta');
});

test('an empty exposure list and an empty alias map change nothing', async () => {
    const rows = await publishedRows(registry(), { expose: [], modelIds: {} });
    assert.deepEqual(rows.map((row) => row.publicId), ['alpha/deepseek/flash', 'solo', 'beta/deepseek/flash']);
});
