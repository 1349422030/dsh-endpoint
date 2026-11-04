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
    const settings = { exposeAll: false, expose: ['alpha/*'] };
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
    const rows = await publishedRows(registry(), { exposeAll: false, expose: ['alpha/solo'] });
    assert.deepEqual(rows.map((row) => row.publicId), ['alpha/solo']);
});

test('an unexposed model is not addressable through the model card either', async () => {
    const ctx = registry();
    const settings = { exposeAll: false, expose: ['alpha/solo'] };
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

test('the 0.1.4 archive shape stays permissive: expose there is ignored by default', async () => {
    // An archive written before the switch existed has no exposeAll key and an
    // empty list. Treating that as "publish nothing" would take every model
    // offline on upgrade, so a missing key must mean the switch is on.
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

test('with the switch on, a restrictive exposure list publishes everything', async () => {
    // On is authoritative: the list is not a filter, it is dead config kept
    // only so that turning the switch off later has something to start from.
    const ctx = registry();
    const settings = { exposeAll: true, expose: ['alpha/solo'] };
    const rows = await publishedRows(ctx, settings);
    assert.deepEqual(rows.map((row) => row.publicId), [
        'alpha/deepseek/flash',
        'alpha/solo',
        'beta/deepseek/flash',
    ]);
    const status = await statusRows(ctx, settings);
    assert.ok(status.every((row) => row.exposed), 'every routable model is exposed');
});

test('switching it off with an empty list publishes nothing, and that is not a wildcard', async () => {
    const ctx = registry();
    const settings = { exposeAll: false, expose: [] };
    assert.deepEqual(await publishedRows(ctx, settings), []);
    assert.deepEqual((await listModels(ctx, settings)).data, []);
    const status = await statusRows(ctx, settings);
    assert.ok(status.every((row) => row.exposed === false), 'the page still lists every model, all unchecked');
    // The page must keep offering a placeholder for each one, or the switch
    // could never be undone from the UI.
    assert.equal(status.length, 3);
    assert.ok(status.every((row) => typeof row.publicId === 'string' && row.publicId !== ''));
    // A named request for a model that exists but is not published is an
    // ordinary 404 — the same answer any unknown name gets — and its message
    // names the settings that produce that state instead of trailing off after
    // a list of nothing.
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'alpha/solo'),
        (error) => error.status === 404
            && error.code === 'model_not_found'
            && error.message.includes('currently publishes no models'),
    );
    // The default-model path has nothing to fall back on, which is the one
    // place "nothing is published" is reported as a 503 rather than a 404.
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, undefined),
        (error) => error.status === 503 && error.code === 'no_models',
    );
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'auto'),
        (error) => error.status === 503 && error.code === 'no_models',
    );
});

test('the 404 message spells the published count in the singular or plural', async () => {
    const ctx = registry();
    // One published model reads as English: "lists 1 published model: alpha/solo".
    await assert.rejects(
        resolveRoute(ctx, { exposeAll: false, expose: ['alpha/solo'] }, undefined, 'nope'),
        (error) => error.status === 404
            && error.message.includes('GET /v1/models lists 1 published model: alpha/solo.'),
    );
    // More than one keeps the plural and the comma-separated list.
    await assert.rejects(
        resolveRoute(ctx, { exposeAll: false, expose: ['alpha/*'] }, undefined, 'nope'),
        (error) => error.status === 404
            && error.message.includes('lists 2 published models: alpha/deepseek/flash, alpha/solo.'),
    );
});

test('with the switch off, only the listed models are published', async () => {
    const ctx = registry();
    const settings = { exposeAll: false, expose: ['beta/*'] };
    const rows = await publishedRows(ctx, settings);
    assert.deepEqual(rows.map((row) => row.publicId), ['beta/deepseek/flash']);
    assert.deepEqual((await listModels(ctx, settings)).data.map((card) => card.id), ['beta/deepseek/flash']);
    await assert.rejects(
        resolveRoute(ctx, settings, undefined, 'alpha/solo'),
        (error) => error.status === 404 && error.code === 'model_not_found',
    );
});

test('an unpublished row whose route is taken is offered a suffixed placeholder', async () => {
    // The published alias deliberately steals the *route* of a model that is
    // not published. 0.1.4 fell back to that route once, so the card showed a
    // name that already answered for a different model; ticking the box then
    // published under a second choice. The whole directory must stay unique.
    const settings = {
        exposeAll: false,
        expose: ['alpha/*'],
        modelIds: { 'alpha/solo': 'beta/deepseek/flash' },
    };
    const rows = await statusRows(registry(), settings);
    const byRoute = new Map(rows.map((row) => [row.route, row]));
    assert.equal(byRoute.get('alpha/solo').publicId, 'beta/deepseek/flash');
    const placeholder = byRoute.get('beta/deepseek/flash');
    assert.equal(placeholder.exposed, false);
    assert.equal(placeholder.publicId, 'beta/deepseek/flash.2');
    const ids = rows.map((row) => row.publicId);
    assert.equal(new Set(ids).size, ids.length, `public ids must be unique: ${ids.join(', ')}`);
});

test('an unpublished row does not advertise a name another model already answers to', async () => {
    // Two models want the same alias; only one of them is exposed. The
    // settings page shows the other one as "would publish as ...", and that
    // placeholder must not be the name that already routes somewhere else.
    const settings = {
        exposeAll: false,
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
