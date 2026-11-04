/**
 * The settings page, loaded the way the Harness loads it: through
 * `window.__ModuleLoader__`, with `react` as its only dependency.
 *
 * The page is rendered with a stub `react` that records the element tree
 * instead of mounting it, so this test needs no browser and no DOM. It proves
 * the module registers, the slot is taken, and the four settings render.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Just enough `react` for the factory: hooks return stable stand-ins, and
 * `createElement` builds a plain tree.
 * @returns {object} the stub module.
 */
function stubReact() {
    const element = (type, props, ...children) => ({ type, props: props ?? {}, children });
    return {
        createElement: element,
        useCallback: (fn) => fn,
        useEffect: () => undefined,
        useMemo: (fn) => fn(),
        useRef: (initial) => ({ current: initial }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
}

/** Flatten a stub element tree into the text it would show. */
function textOf(node) {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    return node.children.map(textOf).join(' ');
}

/** Every stub element matching `predicate`, depth-first. */
function findNodes(node, predicate, found = []) {
    if (node === null || node === undefined || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
        for (const child of node) findNodes(child, predicate, found);
        return found;
    }
    if (predicate(node)) found.push(node);
    for (const child of node.children) findNodes(child, predicate, found);
    return found;
}

/** The form controller the settings page reads and writes. */
function fakeForm(value) {
    return {
        subscribe: () => () => undefined,
        getSnapshot: () => ({ value, revision: 0, writable: true }),
        set: async () => true,
        unset: async () => true,
    };
}

// The module loader consumes itself once the file is imported, so both tests
// share the one registration the first import produced.
let registration = null;

test('the client half registers a settings page that renders the endpoint fields', async () => {
    globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
    await import('../lib/client.js');
    // The boot graph addresses this bundle by package name; register under
    // anything else and the page reports the plugin as failed to load.
    const manifestName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
    assert.equal(registration.id, manifestName);
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    assert.equal(typeof module.apply, 'function');
    assert.deepEqual(module.inject, ['slots', 'locale', 'configForms']);

    let section;
    let slotSpec;
    const ctx = {
        effect: (fn) => fn(),
        locale: { register: () => undefined, bind: () => (key) => key },
        slots: {
            inject: (_name, register) => register(),
            register: (spec, component) => {
                slotSpec = spec;
                section = component;
                return () => undefined;
            },
        },
    };
    module.apply(ctx);
    assert.equal(slotSpec.name, 'settings.section');
    assert.equal(slotSpec.id, 'dsh-endpoint');

    const tree = section({
        configForms: { get: () => fakeForm({ enabled: true, host: '127.0.0.1', port: 8789, apiKey: '' }) },
        t: (key) => key,
    });
    const text = textOf(tree);
    for (
        const expected of [
            'title',
            'enabledLabel',
            'hostLabel',
            'portLabel',
            'apiKeyLabel',
            'modelsLabel',
            'exposeAllLabel',
            'save',
            'discard',
        ]
    ) {
        assert.ok(text.includes(expected), `settings page should render "${expected}"`);
    }
    // The four fields, and only those four, are writable from the page.
    const inputs = [];
    const walk = (node) => {
        if (node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.type === 'input') inputs.push(node); else if (node.type === 'div') {
            if (node.props.className === 'dsh-ep-field') inputs.push(node);
        }
        node.children.forEach(walk);
    };
    walk(tree);
    assert.ok(inputs.length >= 4);
    assert.ok(!text.includes('corsOrigin') && !text.includes('requestTimeoutMs'));
});

test('the publish switch shows the saved mode', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    let section;
    const ctx = {
        effect: (fn) => fn(),
        locale: { register: () => undefined, bind: () => (key) => key },
        slots: {
            inject: (_name, register) => register(),
            register: (_spec, component) => {
                section = component;
                return () => undefined;
            },
        },
    };
    module.apply(ctx);
    const tree = section({
        configForms: {
            get: () =>
                fakeForm({
                    enabled: true,
                    host: '127.0.0.1',
                    port: 8789,
                    apiKey: '',
                    exposeAll: false,
                    expose: [],
                }),
        },
        t: (key) => key,
    });
    const text = textOf(tree);
    assert.ok(text.includes('exposeListedLabel'), 'the switch reads "only the models I check"');
    assert.ok(text.includes('exposeListedHint'));
    assert.ok(!text.includes('exposeAllLabel'));
    // An empty selection is a legal state now, so the card warns instead of
    // blocking; that behaviour is covered by modelsCardFlags below.
});

test('the card starts in the configured mode and checks every box when publishing all', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const config = { expose: [], modelIds: { 'alpha/solo': 'solo2' } };
    const models = [
        { route: 'alpha/deepseek/flash', name: 'Flash (alpha)', exposed: true },
        { route: 'beta/deepseek/flash', name: 'Flash (beta)', exposed: false },
        { route: 'alpha/solo', name: 'Solo', exposed: true },
    ];

    // The initial mode comes from the saved config. A missing key is an archive
    // from before the switch: it meant "everything", so it must read as all.
    assert.equal(module.exposeMode(config), 'all');
    assert.equal(module.exposeMode({ exposeAll: true }), 'all');
    assert.equal(module.exposeMode({ exposeAll: false }), 'listed');

    // In all mode the list decides nothing: every box shows checked even where
    // the live document says the model is not exposed today.
    const rows = module.modelRows({ models }, config);
    assert.deepEqual(
        rows.map((row) => ({ route: row.route, checked: row.checked, customId: row.customId })),
        [
            { route: 'alpha/deepseek/flash', checked: true, customId: '' },
            { route: 'beta/deepseek/flash', checked: true, customId: '' },
            { route: 'alpha/solo', checked: true, customId: 'solo2' },
        ],
    );
    // Routes the status document does not list stay out of the card; no models
    // at all means no rows rather than a crash.
    assert.deepEqual(module.modelRows({}, config).length, 0);
    assert.deepEqual(module.modelRows(null, config).length, 0);

    // All mode writes the switch on and carries the saved list over untouched;
    // the checkboxes are ignored, and clearing the list here would throw away
    // the whitelist the user will need when turning the switch back off.
    assert.deepEqual(module.modelConfig(rows, config), {
        exposeAll: true,
        expose: [],
        modelIds: { 'alpha/solo': 'solo2' },
    });
    assert.deepEqual(module.modelConfig(rows, { expose: ['commandcode/*'] }, 'all').expose, ['commandcode/*']);

    // With no rows at all the saved fields pass through, and the mode is
    // preserved: a registry outage must not flip the switch either way.
    assert.deepEqual(module.modelConfig([], config), {
        exposeAll: true,
        expose: [],
        modelIds: { 'alpha/solo': 'solo2' },
    });
    assert.deepEqual(module.modelConfig([], { exposeAll: false, expose: ['p/m'], modelIds: {} }), {
        exposeAll: false,
        expose: ['p/m'],
        modelIds: {},
    });
});

test('listed mode writes exactly the checked routes, including none at all', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const config = {
        exposeAll: false,
        expose: ['alpha/deepseek/flash', 'alpha/solo'],
        modelIds: { 'alpha/solo': 'solo2' },
    };
    const models = [
        { route: 'alpha/deepseek/flash', name: 'Flash (alpha)', exposed: true },
        { route: 'beta/deepseek/flash', name: 'Flash (beta)', exposed: false },
        { route: 'alpha/solo', name: 'Solo', exposed: true },
    ];

    // Listed mode is the one place the live exposure flag drives the box.
    const rows = module.modelRows({ models }, config);
    assert.deepEqual(rows.map((row) => row.checked), [true, false, true]);
    assert.deepEqual(module.modelConfig(rows, config), {
        exposeAll: false,
        expose: ['alpha/deepseek/flash', 'alpha/solo'],
        modelIds: { 'alpha/solo': 'solo2' },
    });

    // Checking everything stays explicit: [] now means "publish nothing", and
    // a model added later must not slip out without a check.
    const allChecked = rows.map((row) => ({ ...row, checked: true }));
    assert.deepEqual(module.modelConfig(allChecked, config).expose, [
        'alpha/deepseek/flash',
        'beta/deepseek/flash',
        'alpha/solo',
    ]);

    // Checking nothing is a legal save: the endpoint publishes no models.
    const none = rows.map((row) => ({ ...row, checked: false }));
    assert.deepEqual(module.modelConfig(none, config), {
        exposeAll: false,
        expose: [],
        modelIds: { 'alpha/solo': 'solo2' },
    });

    // Clearing an alias field removes its key; whitespace is not an alias.
    const cleared = rows.map((row) => (row.route === 'alpha/solo' ? { ...row, customId: '   ' } : row));
    assert.deepEqual(module.modelConfig(cleared, config).modelIds, {});
});

test('an empty selection warns but still saves; a broken id blocks only after an edit', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const row = (route, checked = true, customId = '') => ({ route, name: route, checked, customId });

    // Listed with nothing checked: the page warns, and the save goes through.
    assert.deepEqual(module.modelsCardFlags([row('alpha/a', false), row('beta/b', false)], 'listed', false, 0), {
        noneChecked: true,
        saveBlocked: false,
    });
    // A collision blocks only once the card was actually edited, so an
    // untouched config cannot hold the save button hostage.
    assert.deepEqual(module.modelsCardFlags([row('alpha/a', true, 'x'), row('beta/b', true, 'x')], 'listed', true, 2), {
        noneChecked: false,
        saveBlocked: true,
    });
    assert.deepEqual(module.modelsCardFlags([row('alpha/a', true, 'x'), row('beta/b', true, 'x')], 'listed', false, 2), {
        noneChecked: false,
        saveBlocked: false,
    });
    // All mode publishes regardless of the boxes, so "none checked" cannot apply.
    assert.deepEqual(module.modelsCardFlags([row('alpha/a', false)], 'all', false, 0), {
        noneChecked: false,
        saveBlocked: false,
    });
    // No rows at all is not "none checked" either: there is nothing to check.
    assert.equal(module.modelsCardFlags([], 'listed', false, 0).noneChecked, false);
});

test('the publish switch stays locked while there is nothing to prefill from', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const rows = [{ route: 'alpha/a', name: 'A', checked: true, customId: '' }];
    // No live status: the switch cannot know what to prefill, and entering
    // listed would write an empty whitelist over the saved one.
    assert.equal(module.modelsSwitchLocked(null, rows), true);
    // A directory that enumerates nothing is the same situation.
    assert.equal(module.modelsSwitchLocked({ models: [] }, []), true);
    // A real document with models is safe to switch.
    assert.equal(module.modelsSwitchLocked({ models: [{ route: 'alpha/a' }] }, rows), false);
});

test('the publish switch is disabled when the live model list cannot be read', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    let section;
    const ctx = {
        effect: (fn) => fn(),
        locale: { register: () => undefined, bind: () => (key) => key },
        slots: {
            inject: (_name, register) => register(),
            register: (_spec, component) => {
                section = component;
                return () => undefined;
            },
        },
    };
    module.apply(ctx);
    // The stub's useStatus stays in 'loading', so the page renders with no live
    // document — the state the switch must not act from.
    const tree = section({
        configForms: {
            get: () => fakeForm({ enabled: true, exposeAll: false, expose: ['alpha/a'] }),
        },
        t: (key) => key,
    });
    const labels = findNodes(tree, (node) => node.type === 'label' && textOf(node).includes('exposeListedLabel'));
    assert.equal(labels.length, 1, 'the card shows the listed-mode switch');
    const toggle = findNodes(labels[0], (node) => node.type === 'input')[0];
    assert.equal(toggle.props.type, 'checkbox');
    assert.equal(toggle.props.disabled, true);
});

test('switching the publish-everything switch off pre-checks everything listed', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const rows = [
        { route: 'alpha/a', name: 'A', checked: true, customId: '' },
        { route: 'beta/b', name: 'B', checked: false, customId: 'x' },
    ];

    // Entering listed must not turn into "publish nothing": the moment of the
    // switch checks every listed row, keeping edits already made.
    assert.deepEqual(module.prefillOverrides(rows, {}, 'listed'), {
        'alpha/a': { checked: true },
        'beta/b': { checked: true },
    });
    assert.deepEqual(module.prefillOverrides(rows, { 'beta/b': { customId: 'y' } }, 'listed'), {
        'alpha/a': { checked: true },
        'beta/b': { customId: 'y', checked: true },
    });
    // Back to all, the row edits stop meaning anything and are dropped.
    assert.deepEqual(module.prefillOverrides(rows, { 'beta/b': { customId: 'y' } }, 'all'), {
        'beta/b': { customId: 'y' },
    });

    // The whole switch-off path, as the page runs it: prefill, fold in listed
    // mode, and write through editedFields. Both fields must land, so the
    // whitelist that keeps today's published set alive is on disk even if the
    // page is reloaded before the user checks anything again.
    const config = { expose: ['alpha/*'], modelIds: {} };
    const live = module.modelRows(
        {
            models: [
                { route: 'alpha/a', name: 'A', exposed: true },
                { route: 'beta/b', name: 'B', exposed: false },
            ],
        },
        config,
    );
    const prefilled = module.modelRows(
        { models: [{ route: 'alpha/a', name: 'A', exposed: true }, { route: 'beta/b', name: 'B', exposed: false }] },
        config,
        module.prefillOverrides(live, {}, 'listed'),
        'listed',
    );
    const listed = module.modelConfig(prefilled, config, 'listed');
    assert.deepEqual(listed, { exposeAll: false, expose: ['alpha/a', 'beta/b'], modelIds: {} });
    assert.deepEqual(module.editedFields({ mode: 'listed' }, listed), {
        exposeAll: false,
        expose: ['alpha/a', 'beta/b'],
    });
});

test('the card refuses ids that would not address the model they name', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const row = (route, customId = '') => ({ route, name: route, checked: true, customId });

    // Two custom ids that are the same string name one model twice.
    const twins = module.modelIdIssues([row('alpha/a', 'shared'), row('beta/b', 'shared')]);
    assert.deepEqual([...twins.keys()], ['alpha/a', 'beta/b']);
    assert.equal(twins.get('alpha/a'), 'modelIdTaken');

    // A custom id that spells another model's route does the same thing, only
    // less visibly: the Host would answer that request as ambiguous.
    const shadow = module.modelIdIssues([row('alpha/a', 'beta/b'), row('beta/b')]);
    assert.equal(shadow.get('alpha/a'), 'modelIdTaken');
    assert.equal(shadow.has('beta/b'), false, 'the model that owns the route is not at fault');

    // Words the Host reads as "pick the default model" cannot be published.
    for (const word of ['auto', 'DEFAULT', 'on', 'true', '1']) {
        assert.equal(module.modelIdIssues([row('alpha/a', word)]).get('alpha/a'), 'modelIdReserved', word);
    }

    // Unrenamed rows cannot collide: their routes are unique by construction.
    assert.equal(module.modelIdIssues([row('alpha/a'), row('beta/b')]).size, 0);
});

test('each card edit writes only the config fields it is about', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const fold = { exposeAll: false, expose: ['commandcode/*'], modelIds: { 'alpha/a': 'flash' } };

    // Only the touched field is written: a wildcard exposure list keeps its
    // "publish models added later" meaning through an unrelated keystroke.
    assert.deepEqual(module.editedFields({ customId: 'flash' }, fold), {
        modelIds: { 'alpha/a': 'flash' },
    });
    assert.deepEqual(module.editedFields({ checked: false }, fold), {
        expose: ['commandcode/*'],
    });

    // Switching on writes only the switch: the stored list is dead config and
    // must survive for a later switch-off.
    assert.deepEqual(module.editedFields({ mode: 'all' }, { ...fold, exposeAll: true }), {
        exposeAll: true,
    });
    // Switching off must also persist the prefill, or a refresh before the next
    // save would show an empty (publish-nothing) whitelist.
    assert.deepEqual(module.editedFields({ mode: 'listed' }, fold), {
        exposeAll: false,
        expose: ['commandcode/*'],
    });
});
