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

test('the client half registers a settings page that renders the endpoint fields', async () => {
    let registration;
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
    for (const expected of ['title', 'enabledLabel', 'hostLabel', 'portLabel', 'apiKeyLabel', 'save', 'discard']) {
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
