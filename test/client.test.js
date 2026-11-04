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

test('model rows merge the status documents exposure with the saved aliases', async () => {
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

    // The checkbox shows the live exposure; the alias field shows the saved id.
    const rows = module.modelRows({ models }, config);
    assert.deepEqual(
        rows.map((row) => ({ route: row.route, checked: row.checked, customId: row.customId })),
        [
            { route: 'alpha/deepseek/flash', checked: true, customId: '' },
            { route: 'beta/deepseek/flash', checked: false, customId: '' },
            { route: 'alpha/solo', checked: true, customId: 'solo2' },
        ],
    );
    // Routes the status document does not list stay out of the card; no models
    // at all means no rows rather than a crash.
    assert.deepEqual(module.modelRows({}, config).length, 0);
    assert.deepEqual(module.modelRows(null, config).length, 0);

    // Two rows checked, one not: the precise list, and the saved alias kept.
    assert.deepEqual(module.modelConfig(rows, config), {
        expose: ['alpha/deepseek/flash', 'alpha/solo'],
        modelIds: { 'alpha/solo': 'solo2' },
        emptySelection: false,
    });

    // Everything checked collapses to the empty list, which means "publish
    // everything" — a model added later needs no second visit.
    const allChecked = rows.map((row, index) =>
        index === 1 ? { ...row, checked: true, customId: 'flash2' } : row,
    );
    assert.deepEqual(module.modelConfig(allChecked, config), {
        expose: [],
        modelIds: { 'alpha/solo': 'solo2', 'beta/deepseek/flash': 'flash2' },
        emptySelection: false,
    });

    // Clearing an alias field removes its key; whitespace is not an alias.
    const cleared = allChecked.map((row, index) => (index === 2 ? { ...row, customId: '   ' } : row));
    assert.deepEqual(module.modelConfig(cleared, config).modelIds, { 'beta/deepseek/flash': 'flash2' });

    // Unchecking every row is the one selection the config cannot express, so
    // saving is blocked on it (and the card says why).
    const none = rows.map((row) => ({ ...row, checked: false }));
    assert.equal(module.modelConfig(none, config).emptySelection, true);

    // With no rows at all, the saved fields pass through unchanged so a
    // registry outage cannot silently publish everything.
    assert.deepEqual(module.modelConfig([], config), {
        expose: [],
        modelIds: { 'alpha/solo': 'solo2' },
        emptySelection: false,
    });
    assert.deepEqual(module.modelConfig([], { expose: ['p/m'], modelIds: {} }).expose, ['p/m']);
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

test('typing a custom id leaves the exposure list exactly as it was', async () => {
    const module = registration.factory((specifier) => {
        if (specifier === 'react') return stubReact();
        throw new Error(`unexpected require("${specifier}")`);
    });
    const fold = { expose: ['commandcode/*'], modelIds: { 'alpha/a': 'flash' } };
    // Only the touched field is written: a wildcard exposure list keeps its
    // "publish models added later" meaning through an unrelated keystroke.
    assert.deepEqual(module.editedFields({ customId: 'flash' }, fold), {
        modelIds: { 'alpha/a': 'flash' },
    });
    assert.deepEqual(module.editedFields({ checked: false }, fold), {
        expose: ['commandcode/*'],
    });
});
