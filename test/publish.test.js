/** Published names and the exposure list: which models exist, and what they are called. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedRows, resolveRoute, statusRows } from '../lib/capabilities.js';
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

test('without configuration, every model is published under its provider-qualified id', async () => {
    const rows = await publishedRows(registry(), {});
    assert.deepEqual(rows.map((row) => row.publicId), [
        'alpha/deepseek/flash',
        'alpha/solo',
        'beta/deepseek/flash',
    ]);
});

test('a bare id is never a published name, whatever the collisions', async () => {
    const ctx = registry();
    // Neither the colliding id (ambiguous) nor the unique one is addressable
    // until the settings page gives it an alias or a client uses the route.
    await assert.rejects(
        resolveRoute(ctx, {}, undefined, 'deepseek/flash'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
    await assert.rejects(
        resolveRoute(ctx, {}, undefined, 'solo'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
    assert.equal(await modelById(ctx, {}, 'solo'), undefined);
});

test('a configured alias names a model and hides the provider layout', async () => {
    const rows = await publishedRows(registry(), {
        modelIds: { 'alpha/deepseek/flash': 'flash' },
    });
    assert.equal(rows[0].publicId, 'flash');
    // One alias names one model: the twin keeps its provider-qualified default.
    assert.equal(rows.find((row) => row.provider === 'beta').publicId, 'beta/deepseek/flash');
});

test('an alias is routable and is echoed back as the published name', async () => {
    const settings = { modelIds: { 'beta/deepseek/flash': 'flash' } };
    const route = await resolveRoute(registry(), settings, undefined, 'flash');
    assert.deepEqual(route, { provider: 'beta', model: 'deepseek/flash', publicId: 'flash' });
    // Asking by the real route still works, and the answer says what was asked.
    const byRoute = await resolveRoute(registry(), settings, undefined, 'beta/deepseek/flash');
    assert.deepEqual(byRoute, { provider: 'beta', model: 'deepseek/flash', publicId: 'beta/deepseek/flash' });
});

test('an alias retires the old bare id in the model card too', async () => {
    const ctx = registry();
    const settings = { modelIds: { 'alpha/solo': 'solo2' } };
    // The two names a request may use: the published alias and the real route.
    assert.equal((await modelById(ctx, settings, 'solo2')).id, 'solo2');
    assert.equal((await modelById(ctx, settings, 'alpha/solo')).id, 'solo2');
    // The id an alias replaced resolves nowhere, exactly as it routes nowhere.
    assert.equal(await modelById(ctx, settings, 'solo'), undefined);
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'solo'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
});

test('a hand-written alias that steals a route leaves a URL-safe name behind', async () => {
    // The settings page refuses to save this; a hand-edited cordis.patch.yml
    // can still produce it, so the Host must not mint an id containing `#` —
    // a client building /v1/models/{id} would address the fragment instead.
    const settings = { modelIds: { 'alpha/solo': 'alpha/deepseek/flash' } };
    const rows = await publishedRows(registry(), settings);
    const ids = rows.map((row) => row.publicId);
    assert.ok(!ids.some((id) => id.includes('#')), `no publication name may contain "#": ${ids.join(', ')}`);
    // Both models stay addressable, one of them under a suffixed name.
    assert.ok(ids.includes('alpha/deepseek/flash'));
    const suffixed = ids.find((id) => id !== 'alpha/deepseek/flash' && id.includes('alpha/deepseek/flash'));
    assert.equal(suffixed, 'alpha/deepseek/flash.2');
    await assert.rejects(
        resolveRoute(registry(), settings, undefined, 'alpha/deepseek/flash'),
        (error) => error.status === 400 && error.code === 'ambiguous_model',
        'a name two models answer to must be refused rather than guessed',
    );
    assert.equal((await modelById(registry(), settings, suffixed)).id, suffixed);
});

test('the exposure list decides what exists, not merely what is advertised', async () => {
    const ctx = registry();
    const settings = { expose: ['alpha/*'] };
    const rows = await publishedRows(ctx, settings);
    assert.deepEqual(rows.map((row) => row.publicId), ['alpha/deepseek/flash', 'alpha/solo']);
    // Two routes are gone from the list, so they route and list nowhere.
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'beta/deepseek/flash'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
    const listed = await listModels(ctx, settings);
    assert.deepEqual(listed.data.map((card) => card.id), ['alpha/deepseek/flash', 'alpha/solo']);
});

test('an exact route in the exposure list publishes only that model', async () => {
    const rows = await publishedRows(registry(), { expose: ['alpha/solo'] });
    assert.deepEqual(rows.map((row) => row.publicId), ['alpha/solo']);
});

test('an unexposed model is not addressable through the model card either', async () => {
    const ctx = registry();
    const settings = { expose: ['alpha/solo'] };
    assert.equal(await modelById(ctx, settings, 'alpha/deepseek/flash'), undefined);
    assert.equal(await modelById(ctx, settings, 'solo'), undefined);
    assert.equal((await modelById(ctx, settings, 'alpha/solo')).id, 'alpha/solo');
});

test('two models configured with one alias keep two routable names', async () => {
    const settings = { modelIds: { 'alpha/deepseek/flash': 'flash', 'beta/deepseek/flash': 'flash' } };
    const rows = await publishedRows(registry(), settings);
    // The first alias wins; the second model falls back to its
    // provider-qualified default rather than becoming unroutable.
    assert.equal(rows[0].publicId, 'flash');
    const beta = rows.find((row) => row.provider === 'beta');
    assert.notEqual(beta.publicId, 'flash');
    assert.equal(beta.publicId, 'beta/deepseek/flash');
    const route = await resolveRoute(registry(), settings, undefined, beta.publicId);
    assert.equal(route.provider, 'beta');
});

test('an empty exposure list and an empty alias map change nothing', async () => {
    const rows = await publishedRows(registry(), { expose: [], modelIds: {} });
    assert.deepEqual(rows.map((row) => row.publicId), [
        'alpha/deepseek/flash',
        'alpha/solo',
        'beta/deepseek/flash',
    ]);
});
test('the profile selection does not break a tie between two models', async () => {
    // Hand-written yml: one model's alias steals another model's route. The
    // profile happens to be on alpha, so a "prefer my provider" tie-breaker
    // would answer 200 for whichever of the two alpha models came first.
    const settings = { modelIds: { 'alpha/solo': 'alpha/deepseek/flash' } };
    const selection = { provider: 'alpha', model: 'deepseek/flash' };
    await assert.rejects(
        resolveRoute(registry(), settings, selection, 'alpha/deepseek/flash'),
        (error) => error.status === 400 && error.code === 'ambiguous_model',
        'a tie must be refused even when the profile has a current selection',
    );
});

test('an unpublished row does not advertise a name another model already answers to', async () => {
    // Two models want the same alias; only one of them is exposed. The
    // settings page shows the other one as "would publish as ...", and that
    // placeholder must not be the name that already routes somewhere else.
    const settings = {
        expose: ['alpha/*'],
        modelIds: { 'alpha/solo': 'shared', 'beta/deepseek/flash': 'shared' },
    };
    const rows = await statusRows(registry(), settings);
    const byRoute = new Map(rows.map((row) => [row.route, row]));
    assert.deepEqual(byRoute.get('alpha/solo'), {
        route: 'alpha/solo',
        name: 'Solo',
        publicId: 'shared',
        exposed: true,
    });
    assert.equal(byRoute.get('beta/deepseek/flash').exposed, false);
    assert.equal(byRoute.get('beta/deepseek/flash').publicId, 'beta/deepseek/flash');
});
