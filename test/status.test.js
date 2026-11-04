/**
 * The Host half's status route: the settings page's directory source.
 *
 * The test mounts the real plugin once, with a stub Harness web server that
 * captures the registered handler, and a real listener on a throwaway port so
 * /health can be read too. It proves the models list travels on the same-origin
 * status route only — the listener's own port stays directory-free.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/plugin.js';
import { fakeCtx, fakeInfo } from './helpers.js';

const ROWS = [
    { provider: 'p', id: 'm', name: 'Model M' },
    { provider: 'p', id: 'other', name: 'Other' },
];

/**
 * A response object just rich enough for sendJson: the document it ended with.
 * @returns {object} the fake response.
 */
function fakeResponse() {
    return {
        headers: {},
        status: 0,
        body: '',
        headersSent: false,
        writableEnded: false,
        writeHead(status, head) {
            this.status = status;
            this.headersSent = true;
            for (const [name, value] of Object.entries(head ?? {})) {
                this.headers[String(name).toLowerCase()] = value;
            }
        },
        end(payload) {
            this.body = String(payload ?? '');
            this.writableEnded = true;
        },
    };
}

/**
 * Mount the real plugin with a stub web server, and return what the routes say.
 * @param {object} overrides - plain Config fields over the safe defaults.
 * @returns {Promise<{statusDocument: object, healthDocument: object, close: () => Promise<void>}>}
 */
async function mounted(overrides = {}) {
    let statusHandler = null;
    const disposals = [];
    const port = 44000 + ((Date.now() + process.pid) % 20000);
    const config = { enabled: true, host: '127.0.0.1', port, apiKey: '', ...overrides };
    const ctx = {
        ...fakeCtx(fakeInfo(), () => [], ROWS),
        effect: (fn) => {
            const dispose = fn();
            disposals.push(() => dispose?.());
            return dispose;
        },
        on: () => undefined,
        inject: (_names, run) =>
            run({
                effect: (fn) => {
                    const dispose = fn();
                    return () => dispose?.();
                },
                webServer: {
                    register: (spec) => {
                        statusHandler = spec.handler;
                        return () => undefined;
                    },
                },
            }),
    };
    apply(ctx, config);

    // The listener comes up asynchronously; poll until /health answers.
    let health = null;
    for (let attempt = 0; attempt < 60 && health === null; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
            health = await response.json();
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    if (health === null) {
        for (const dispose of disposals.reverse()) await dispose();
        assert.fail('the listener never came up');
    }

    const response = fakeResponse();
    await statusHandler(undefined, response);
    const statusDocument = JSON.parse(response.body);
    return {
        healthDocument: health,
        statusDocument,
        close: async () => {
            for (const dispose of disposals.reverse()) await dispose();
        },
    };
}

test('the same-origin status route lists the models; the listener health does not', async () => {
    // An alias names one model, and the empty exposure list publishes both.
    const mounted_ = await mounted({ modelIds: { 'p/m': 'mind' } });
    try {
        const { healthDocument, statusDocument } = mounted_;
        assert.equal(statusDocument.ok, true);
        assert.deepEqual(statusDocument.models, [
            { route: 'p/m', name: 'Model M', publicId: 'mind', exposed: true },
            { route: 'p/other', name: 'Other', publicId: 'p/other', exposed: true },
        ]);
        // The listener port can be reached from a LAN or a proxy; it must not
        // hand the profile's model directory to whoever can reach it.
        assert.equal(healthDocument.status, 'ok');
        assert.equal('models' in healthDocument, false);
    } finally {
        await mounted_.close();
    }
});

test('the models list marks precisely the models the exposure list publishes', async () => {
    const mounted_ = await mounted({ expose: ['p/other'] });
    try {
        const { statusDocument } = mounted_;
        const byRoute = new Map(statusDocument.models.map((model) => [model.route, model]));
        assert.equal(byRoute.size, 2);
        // Unexposed: listed for the settings page's checkbox, with the id it
        // would publish if it were, not a routable one made up on the spot.
        assert.deepEqual(byRoute.get('p/m'), {
            route: 'p/m',
            name: 'Model M',
            publicId: 'p/m',
            exposed: false,
        });
        assert.deepEqual(byRoute.get('p/other'), {
            route: 'p/other',
            name: 'Other',
            publicId: 'p/other',
            exposed: true,
        });
    } finally {
        await mounted_.close();
    }
});
