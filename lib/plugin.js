/**
 * dsh-endpoint — Host half.
 *
 * Publishes the models this DeepSeek Harness profile is already configured for
 * as an OpenAI-compatible HTTP endpoint. The listener is created here with
 * `node:http`, so the bind address is fully configurable; nothing in the
 * request path depends on where that listener lives.
 *
 * Completions are answered with `ctx.llm.stream()` — the same provider- and
 * model-neutral entry point the agent loop uses — so every model this profile
 * can talk to is served without a second credential store, and with the
 * profile's own compat layer, retries, and image budget already applied.
 *
 * This file owns the plugin lifecycle and routing only. Protocol conversion
 * lives in protocol.js, model semantics in capabilities.js, and one completion
 * in chat.js.
 */
import { createServer } from 'node:http';
import z from '@deepseek-ai/schemastery';
import { ApiFailure, corsHeaders, failRequest, keyMatches, presentedKey, sendJson } from './http.js';
import { listModels, modelById } from './models.js';
import { handleChat } from './chat.js';

/** Default TCP port. Clear of the Harness web UI and of dsh-model-endpoint's 8787. */
const DEFAULT_PORT = 8788;

/**
 * Persisted settings. Every field is `.volatile()` so the settings page can
 * write it live and the listener can rebind without a reload.
 */
export const Config = z.object({
    /** Whether the HTTP listener runs at all. */
    enabled: z.boolean().default(true).volatile(),
    /** Bind address. `127.0.0.1` = this machine only, `0.0.0.0` = every interface. */
    host: z.string().default('127.0.0.1').volatile(),
    /** TCP port to listen on. */
    port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT).volatile(),
    /**
     * Bearer token clients must present. Empty means "no authentication".
     * No TLS is served here: put a reverse proxy in front if the endpoint must
     * leave the machine.
     */
    apiKey: z.string().default('').volatile(),
    /** Hard ceiling for one completion, including time spent streaming. */
    requestTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(600_000).volatile(),
    /**
     * Provider used when a request names no model and the profile's own chat
     * selection is unusable. Empty means "whatever the profile is using".
     */
    provider: z.string().default('').volatile(),
    /** Model for that same fallback. */
    model: z.string().default('').volatile(),
    /** `Access-Control-Allow-Origin` for browser-based clients. */
    corsOrigin: z.string().default('*').volatile(),
    /**
     * Names this endpoint publishes instead of the automatic ones.
     *
     * Keyed by the route the request is served by — `provider/model` — and
     * valued with the id clients should use. An alias makes the provider layout
     * invisible and keeps two providers that ship the same model id apart.
     * Example: `{ "commandcode/deepseek/deepseek-v4.1-flash": "flash" }`.
     */
    modelIds: z.dict(z.string()).default({}),
    /**
     * Which models are served at all, as `provider/model`, `provider/*`, or `*`.
     * Empty means every model this profile routes. A model left out is neither
     * listed nor routable.
     */
    expose: z.array(z.string()).default([]),
});

/** Services this plugin needs before it can answer a request. */
export const inject = ['llm'];

/**
 * Read a config value that may be wrapped in a cosmokit volatile reference.
 * @param {unknown} value - raw field, possibly a `{ get() }` reference.
 * @returns {unknown} the current value.
 */
function unwrap(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}

/**
 * Project the volatile Config into a plain, detached snapshot.
 * @param {object} config - the plugin Config.
 * @returns {object} plain settings, safe to capture for one request generation.
 */
export function snapshot(config) {
    const read = (key, fallback) => {
        const value = unwrap(config?.[key]);
        return value === undefined || value === null ? fallback : value;
    };
    const port = Math.floor(Number(read('port', DEFAULT_PORT)));
    const timeoutMs = Math.floor(Number(read('requestTimeoutMs', 600_000)));
    return {
        enabled: read('enabled', true) !== false,
        host: String(read('host', '127.0.0.1')).trim() || '127.0.0.1',
        port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
        apiKey: String(read('apiKey', '')).trim(),
        requestTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 600_000,
        provider: String(read('provider', '')).trim(),
        model: String(read('model', '')).trim(),
        corsOrigin: String(read('corsOrigin', '*')).trim() || '*',
        modelIds: normaliseAliases(read('modelIds', {})),
        expose: normaliseExpose(read('expose', [])),
    };
}

/**
 * Keep only the usable entries of a configured alias map.
 * @param {unknown} raw - the configured `modelIds` value.
 * @returns {Record<string, string>} `provider/model` → published name.
 */
function normaliseAliases(raw) {
    const aliases = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return aliases;
    for (const [key, value] of Object.entries(raw)) {
        const route = key.trim();
        const alias = typeof value === 'string' ? value.trim() : '';
        if (route !== '' && alias !== '') aliases[route] = alias;
    }
    return aliases;
}

/**
 * Keep only the non-empty patterns of a configured exposure list.
 * @param {unknown} raw - the configured `expose` value.
 * @returns {string[]} the patterns, or an empty list meaning "publish everything".
 */
function normaliseExpose(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((pattern) => pattern !== '');
}

/**
 * Whether a bind address keeps the listener on this machine.
 * @param {string} host - bind address.
 * @returns {boolean} true for loopback binds.
 */
function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * The status document both `/` and `/health` serve.
 * @param {object} settings - settings snapshot.
 * @param {number|undefined} boundPort - the port actually bound, when live.
 * @param {object} ctx - plugin context, for the logger and version reporting.
 * @returns {object} the document.
 */
function healthDocument(settings, boundPort, ctx) {
    const live = boundPort !== undefined;
    return {
        status: live ? 'ok' : 'down',
        plugin: 'dsh-endpoint',
        listening: live,
        bind: { host: settings.host, port: boundPort ?? settings.port },
        loopbackOnly: isLoopbackHost(settings.host),
        auth: settings.apiKey === '' ? 'none' : 'bearer',
        tls: false,
        routes: ['GET /v1/models', 'GET /v1/models/{id}', 'POST /v1/chat/completions', 'GET /health'],
        warnings: [
            ...(settings.apiKey === '' && !isLoopbackHost(settings.host)
                ? ['bound to a non-loopback address with no API key: anyone who can reach this port may use it']
                : []),
            ...(!live ? ['listener is stopped; enable the endpoint in its settings'] : []),
        ],
    };
}

/**
 * Route one already-authenticated request.
 * @param {object} deps - {ctx, settings, bound, request, response}.
 * @returns {Promise<void>} resolves once the response is finished.
 */
async function handleRequest(deps) {
    const { ctx, settings, bound, request, response } = deps;
    const pathname = new URL(request.url ?? '/', 'http://endpoint.invalid').pathname.replace(/\/+$/, '') || '/';

    // A preflight carries no credentials by design, so it is answered before
    // the key check; it reveals nothing beyond which methods exist.
    if (request.method === 'OPTIONS') {
        response.writeHead(204, { ...corsHeaders(settings), 'content-length': '0' });
        response.end();
        return;
    }

    if (pathname === '/' || pathname === '/health') {
        const document = healthDocument(settings, bound.port, ctx);
        sendJson(response, document.status === 'ok' ? 200 : 503, document);
        return;
    }

    const known = pathname === '/v1/models'
        || pathname === '/v1/chat/completions'
        || pathname.startsWith('/v1/models/');
    if (!known) {
        throw new ApiFailure(
            404,
            'not_found',
            `No route for ${request.method} ${pathname}. This endpoint serves /v1/models and /v1/chat/completions.`,
        );
    }

    if (!keyMatches(settings.apiKey, presentedKey(request))) {
        throw new ApiFailure(401, 'invalid_api_key', 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".');
    }

    if (pathname === '/v1/models' || pathname.startsWith('/v1/models/')) {
        if (request.method !== 'GET') throw new ApiFailure(405, 'method_not_allowed', 'Use GET /v1/models.');
        if (pathname === '/v1/models') {
            sendJson(response, 200, await listModels(ctx, settings));
            return;
        }
        const requestedId = decodeURIComponent(pathname.slice('/v1/models/'.length));
        const document = await modelById(ctx, settings, requestedId);
        if (document === undefined) {
            // Same two names a completion accepts, so a card answers under the
            // alias or route and nowhere else.
            throw new ApiFailure(404, 'model_not_found', `Model "${requestedId}" is not served here. GET /v1/models lists the published models and the names they answer to.`);
        }
        sendJson(response, 200, document);
        return;
    }

    if (request.method !== 'POST') throw new ApiFailure(405, 'method_not_allowed', 'Use POST /v1/chat/completions.');
    await handleChat(deps);
}

/**
 * Mount the endpoint, rebinding it whenever a setting changes.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the plugin Config.
 * @returns {void}
 */
export function apply(ctx, config) {
    const bound = { port: undefined };
    let live;
    let queue = Promise.resolve();
    let generation = 0;

    const settingsNow = () => snapshot(config);

    const stop = async () => {
        const current = live;
        live = undefined;
        bound.port = undefined;
        if (current === undefined) return;
        try {
            await current.close();
        } catch (error) {
            ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
        }
    };

    const start = async (mine) => {
        const settings = settingsNow();
        await stop();
        if (!settings.enabled) {
            ctx.logger?.info?.('dsh-endpoint: disabled, no listener started.');
            return;
        }
        const server = createServer((request, response) => {
            const settings = settingsNow();
            for (const [name, value] of Object.entries(corsHeaders(settings))) {
                response.setHeader(name, value);
            }
            const deps = { ctx, settings, bound, request, response };
            handleRequest(deps).catch((error) => {
                if (process.env.DSH_ENDPOINT_DEBUG === '1') console.error('[dsh-endpoint]', error);
                if (error instanceof ApiFailure && error.status >= 500) {
                    ctx.logger?.warn?.(error);
                }
                failRequest(response, error);
            });
        });
        server.on('clientError', (_error, socket) => {
            if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        });
        try {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(settings.port, settings.host);
            });
        } catch (error) {
            ctx.logger?.warn?.(new Error(
                `dsh-endpoint: cannot bind ${settings.host}:${settings.port} — ${error instanceof Error ? error.message : String(error)}`,
            ));
            return;
        }
        if (mine !== generation) {
            await new Promise((resolve) => server.close(() => resolve()));
            return;
        }
        live = { close: () => new Promise((resolve) => server.close(() => resolve())) };
        const address = server.address();
        bound.port = typeof address === 'object' && address !== null ? address.port : settings.port;
        const unsafe = settings.apiKey === '' && !isLoopbackHost(settings.host);
        ctx.logger?.info?.(
            `dsh-endpoint: listening on http://${settings.host}:${bound.port}/v1`
            + (unsafe ? ' — WARNING: reachable off this machine with no API key set.' : ''),
        );
    };

    const restart = () => {
        generation += 1;
        const mine = generation;
        queue = queue.then(() => start(mine), () => start(mine));
        return queue;
    };

    ctx.effect(() => {
        void restart();
        return () => {
            generation += 1;
            void stop();
        };
    }, 'dsh-endpoint: http listener');

    // Volatile settings change at any time; rebind so the listener follows them.
    ctx.on('loader/volatile-update', () => {
        void restart();
    });

    // A same-origin status route on the Harness web server. The settings page
    // reads live state from here rather than from the listener's own port,
    // which may be bound to a different interface — or not be up at all.
    ctx.inject(['webServer'], (child) => {
        child.effect(() => {
            const dispose = child.webServer.register({
                kind: 'prefix',
                path: '/plugins/dsh-endpoint',
                handler: async (_request, response) => {
                    sendJson(response, 200, { ok: true, ...healthDocument(settingsNow(), bound.port, ctx) });
                },
            });
            return () => {
                dispose();
            };
        }, 'dsh-endpoint: status route');
    });
}