/**
 * dsh-endpoint — model routing and capability projection.
 *
 * Owns every question about *which model* answers a request and *what that
 * model can do*: route resolution (request id → provider/model), the reasoning
 * effort vocabulary, and the capability object `/v1/models` publishes.
 * Owns no I/O of its own beyond reading the LLM registry.
 */
import { ApiFailure } from './http.js';

/**
 * Familiar effort names mapped onto the one axis selectable efforts actually
 * share: relative depth. Clients say `medium` because OpenAI does; a model that
 * declares `low, high, max` still has to be given one of *its* ids, so the
 * requested name is translated by rank rather than rejected.
 */
const EFFORT_RANKS = new Map([
    ['none', 0], ['off', 0], ['disabled', 0], ['false', 0], ['no', 0],
    ['minimal', 1], ['min', 1], ['low', 1], ['lowest', 1], ['light', 1], ['fast', 1],
    ['medium', 2], ['med', 2], ['mid', 2], ['standard', 2], ['normal', 2],
    ['high', 3], ['deep', 3], ['thorough', 3],
    ['max', 4], ['maximum', 4], ['xhigh', 4], ['highest', 4], ['ultra', 4],
]);

/** Effort names that ask for thinking to be switched off. */
const OFF_WORDS = new Set(['none', 'off', 'disabled', 'false', '0', 'no']);

/** Effort names that ask for the model's own default. */
const DEFAULT_WORDS = new Set(['auto', 'default', 'on', 'true', '1', '']);

/**
 * Rank one effort vocabulary word on the shared depth axis.
 * @param {string} value - an effort id or a familiar synonym.
 * @returns {number|undefined} the rank, or undefined for vocabulary we do not know.
 */
function rankOf(value) {
    return EFFORT_RANKS.get(String(value).trim().toLowerCase());
}

/**
 * The `provider/model` key that identifies one route, in requests and in
 * configuration alike.
 * @param {{provider: string, id: string}} row - one catalog row.
 * @returns {string} the key.
 */
export function routeLabel(row) {
    return `${row.provider}/${row.id}`;
}

/**
 * Enumerate every routable model in this profile.
 *
 * `listModels` is per provider and may fail for a provider whose adapter is
 * misconfigured; a provider that cannot enumerate is simply absent rather than
 * failing the whole catalog.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<{provider: string, id: string, name: string}[]>} catalog rows in provider order.
 */
export async function catalog(ctx) {
    const rows = [];
    for (const provider of ctx.llm.listProviders()) {
        const providerId = typeof provider?.id === 'string' ? provider.id : '';
        if (providerId === '') continue;
        let models;
        try {
            models = await ctx.llm.listModels(providerId);
        } catch {
            continue;
        }
        for (const model of models ?? []) {
            const id = typeof model?.id === 'string' ? model.id : '';
            if (id === '') continue;
            rows.push({
                provider: providerId,
                id,
                name: typeof model?.name === 'string' && model.name !== '' ? model.name : id,
            });
        }
    }
    return rows;
}

/**
 * Whether the endpoint publishes one catalog row.
 *
 * An empty exposure list means "everything this profile routes"; otherwise a row
 * is published when a pattern names it. Patterns are `provider/model`, a whole
 * provider as `provider/*`, or `*`. A model that is left out is not merely
 * hidden from `/v1/models` — it cannot be routed at all, so the list a client
 * reads is exactly the list it can use.
 * @param {{provider: string, id: string}} row - one catalog row.
 * @param {string[]} expose - the configured patterns.
 * @returns {boolean} true when the row is published.
 */
function exposed(row, expose) {
    if (!Array.isArray(expose) || expose.length === 0) return true;
    return expose.some((pattern) => {
        if (typeof pattern !== 'string') return false;
        const wanted = pattern.trim();
        if (wanted === '') return false;
        if (wanted === '*') return true;
        if (wanted.endsWith('/*')) return row.provider === wanted.slice(0, -2);
        return wanted === routeLabel(row);
    });
}

/**
 * The name configuration gives one row, keyed by `provider/model`.
 * @param {{provider: string, id: string}} row - one catalog row.
 * @param {Record<string, string>|undefined} modelIds - the configured aliases.
 * @returns {string|undefined} the alias, when one is configured.
 */
function aliasFor(row, modelIds) {
    if (modelIds === null || typeof modelIds !== 'object') return undefined;
    const value = modelIds[routeLabel(row)];
    if (typeof value !== 'string') return undefined;
    const alias = value.trim();
    return alias === '' ? undefined : alias;
}

/**
 * Give every published row a unique public id.
 *
 * A configured alias wins outright; an unaliased row keeps its bare id whenever
 * no other row claims it, and is qualified as `provider/model` (then
 * `provider/model#2`) when it would otherwise collide. A duplicate alias is
 * dropped for the later row rather than silently displacing a model: both keep
 * a routable name.
 * @param {{provider: string, id: string, name: string, alias?: string}[]} rows - published rows.
 * @returns {{provider: string, id: string, name: string, publicId: string}[]} rows with public ids.
 */
function withPublicIds(rows) {
    const taken = new Set();
    const published = rows.map((row) => ({ ...row }));
    for (const row of published) {
        if (row.alias === undefined) continue;
        if (taken.has(row.alias)) {
            delete row.alias;
            continue;
        }
        row.publicId = row.alias;
        taken.add(row.alias);
    }
    // A bare id is only usable when no other row still wants it; counting up
    // front keeps the first of two twins from claiming the name the second needs.
    const wanted = new Map();
    for (const row of published) {
        if (row.publicId !== undefined) continue;
        wanted.set(row.id, (wanted.get(row.id) ?? 0) + 1);
    }
    for (const row of published) {
        if (row.publicId !== undefined) continue;
        if ((wanted.get(row.id) ?? 0) !== 1 || taken.has(row.id)) continue;
        row.publicId = row.id;
        taken.add(row.id);
    }
    for (const row of published) {
        if (row.publicId !== undefined) continue;
        const qualified = routeLabel(row);
        let candidate = qualified;
        let suffix = 2;
        while (taken.has(candidate)) candidate = `${qualified}#${suffix++}`;
        row.publicId = candidate;
        taken.add(candidate);
    }
    return published.map((row) => {
        delete row.alias;
        return row;
    });
}

/**
 * Enumerate the models this endpoint publishes, with the names it publishes them
 * under.
 *
 * This is the only list routing and `/v1/models` share, so a configured alias
 * and a configured exposure list take effect everywhere at once.
 * @param {object} ctx - the plugin context.
 * @param {object} [settings] - settings snapshot carrying `modelIds` and `expose`.
 * @returns {Promise<{provider: string, id: string, name: string, publicId: string}[]>} published rows.
 */
export async function publishedRows(ctx, settings) {
    const rows = (await catalog(ctx)).filter((row) => exposed(row, settings?.expose));
    return withPublicIds(rows.map((row) => ({ ...row, alias: aliasFor(row, settings?.modelIds) })));
}

/**
 * Resolve the full metadata for one exact route.
 *
 * Absence is a normal answer: an adapter that cannot describe a model still
 * serves it, and the capabilities object then says "unknown" instead of
 * inventing a number.
 * @param {object} ctx - the plugin context.
 * @param {{provider: string, model: string}} route - the route to describe.
 * @param {AbortSignal} [signal] - request lifetime.
 * @returns {Promise<object|undefined>} resolved model info, or undefined when undescribable.
 */
export async function modelInfo(ctx, route, signal) {
    try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
        return info ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolve the route one request should be served by.
 *
 * An empty `model`, or `auto`/`default`, means "whatever this profile is
 * currently using" — the same selection the chat picker writes. An explicit id
 * is matched against `model`, `provider/model`, and `provider/<model id>`, so a
 * client that copies the id from `/v1/models` and one that prefixes the vendor
 * both land on the same route.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - this generation's settings snapshot.
 * @param {object|undefined} selection - the profile's current model selection.
 * @param {string|undefined} requested - the request's `model` field.
 * @param {AbortSignal} [signal] - request lifetime.
 * @returns {Promise<{provider: string, model: string}>} the resolved route.
 * @throws {ApiFailure} 404 `model_not_found` for an id this profile cannot route.
 */
export async function resolveRoute(ctx, settings, selection, requested, signal) {
    void signal;
    const rows = await publishedRows(ctx, settings);
    if (rows.length === 0) {
        throw new ApiFailure(
            503,
            'no_models',
            'This profile publishes no models, so there is nothing to serve. Check its "expose" and provider configuration.',
            'server_error',
        );
    }
    // The id a client asked for is the id it gets back: a caller that matches a
    // request against its answer must not have to know the profile's aliases.
    const pick = (row, echo) => ({ provider: row.provider, model: row.id, publicId: echo ?? row.publicId });
    const find = (provider, model) => rows.find((row) => row.provider === provider && row.id === model);
    const raw = typeof requested === 'string' ? requested.trim() : '';

    if (raw === '' || DEFAULT_WORDS.has(raw.toLowerCase())) {
        const chosen = (selection === undefined ? undefined : find(selection.provider, selection.model))
            ?? (typeof settings?.provider === 'string' && settings.provider !== ''
                ? find(settings.provider, typeof settings.model === 'string' ? settings.model : '')
                : undefined)
            ?? rows[0];
        return pick(chosen);
    }

    // Only names this endpoint publishes are accepted: the published id or the
    // `provider/model` route. A model that was renamed by an alias is not
    // reachable under its old id, which is what makes `/v1/models` authoritative.
    const matches = rows.filter((row) => row.publicId === raw || routeLabel(row) === raw);
    if (matches.length === 1) return pick(matches[0], raw);
    if (matches.length > 1) {
        const preferred = matches.find((row) => row.provider === selection?.provider);
        if (preferred !== undefined) return pick(preferred, raw);
        throw new ApiFailure(
            400,
            'ambiguous_model',
            `Model "${raw}" matches ${matches.length} routes (${matches.map((row) => row.publicId).join(', ')}). Send the id from GET /v1/models.`,
            'invalid_request_error',
            'model',
        );
    }

    throw new ApiFailure(
        404,
        'model_not_found',
        `Model "${raw}" is not served here. GET /v1/models lists ${rows.length} published model(s): ${rows.map((row) => row.publicId).join(', ')}.`,
        'invalid_request_error',
        'model',
    );
}

/**
 * Project a resolved model into the capability object clients read.
 *
 * Every field states what the profile itself declares. `null` means "the
 * profile does not declare it", which is not the same as zero: a client should
 * fall back to its own default rather than assume a limit.
 * @param {object|undefined} info - `ctx.llm.resolveModelInfo` result.
 * @returns {object} the capability object `/v1/models` publishes.
 */
export function capabilitiesOf(info) {
    const efforts = (info?.reasoning?.efforts ?? [])
        .filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
        .map((effort) => ({
            id: effort.id,
            name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
            ...(typeof effort.description === 'string' && effort.description !== '' ? { description: effort.description } : {}),
        }));
    const modalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : [];
    const defaultEffort = info?.reasoning?.defaultEffort;
    return {
        context_length: typeof info?.context?.contextWindow === 'number' ? info.context.contextWindow : null,
        max_output_tokens: typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null,
        input_modalities: modalities.length === 0 ? null : modalities,
        output_modalities: ['text'],
        reasoning: {
            supported: efforts.length > 0,
            efforts,
            default_effort: typeof defaultEffort === 'string' && defaultEffort !== '' ? defaultEffort : null,
        },
        tool_calls: false,
        streaming: true,
    };
}

/**
 * Pick the reasoning effort to send, honouring only efforts the model declares.
 *
 * Three request styles are accepted because three ecosystems use them:
 * OpenAI's `reasoning_effort`, DeepSeek's `enable_thinking`, and OpenRouter's
 * `reasoning: { enabled }`. Whatever arrives is reduced to one of the model's
 * own effort ids — an id the model never declared is never put on the wire.
 * @param {object|undefined} info - resolved model info.
 * @param {object} request - the request's reasoning-related fields.
 * @returns {{effort: string|undefined, thinking: boolean, warning: string|undefined}} the decision.
 */
export function resolveEffort(info, request) {
    const efforts = (info?.reasoning?.efforts ?? []).filter((effort) => typeof effort?.id === 'string' && effort.id !== '');
    const ids = efforts.map((effort) => effort.id);
    const reasoning = request?.reasoning !== null && typeof request?.reasoning === 'object' && !Array.isArray(request.reasoning)
        ? request.reasoning
        : undefined;
    const rawEffort = typeof request?.reasoning_effort === 'string'
        ? request.reasoning_effort.trim()
        : typeof reasoning?.effort === 'string'
            ? reasoning.effort.trim()
            : '';
    const enable = typeof request?.enable_thinking === 'boolean'
        ? request.enable_thinking
        : typeof reasoning?.enabled === 'boolean'
            ? reasoning.enabled
            : undefined;
    const asked = rawEffort !== '' || enable !== undefined;

    if (ids.length === 0) {
        if (!asked) return { effort: undefined, thinking: false, warning: undefined };
        return {
            effort: undefined,
            thinking: false,
            warning: 'This model advertises no reasoning efforts, so the requested thinking setting was ignored.',
        };
    }

    const declared = ids.map((id, index) => ({ id, rank: rankOf(id) ?? ids.length + index }));
    const ascending = [...declared].sort((left, right) => left.rank - right.rank);
    const lowest = ascending[0];
    const offEffort = lowest.rank === 0 ? lowest.id : undefined;
    const configuredDefault = info?.reasoning?.defaultEffort;
    const fallback = typeof configuredDefault === 'string' && ids.includes(configuredDefault) ? configuredDefault : lowest.id;

    if (!asked) {
        // Saying nothing leaves the provider's own default in place, and that
        // default thinks: the profile configured reasoning, not silence.
        return { effort: undefined, thinking: true, warning: undefined };
    }

    const lower = rawEffort.toLowerCase();
    if (rawEffort === '' && enable === false) {
        if (offEffort !== undefined) return { effort: offEffort, thinking: false, warning: undefined };
        return {
            effort: lowest.id,
            thinking: true,
            warning: `This model has no off switch, so its lowest effort ("${lowest.id}") was used instead of disabling thinking.`,
        };
    }
    if (rawEffort === '' && enable === true) {
        return { effort: fallback, thinking: rankOf(fallback) !== 0, warning: undefined };
    }
    if (OFF_WORDS.has(lower)) {
        if (offEffort !== undefined) return { effort: offEffort, thinking: false, warning: undefined };
        return {
            effort: lowest.id,
            thinking: true,
            warning: `This model has no off switch, so its lowest effort ("${lowest.id}") was used instead of disabling thinking.`,
        };
    }
    if (DEFAULT_WORDS.has(lower)) return { effort: fallback, thinking: rankOf(fallback) !== 0, warning: undefined };
    if (ids.includes(rawEffort)) return { effort: rawEffort, thinking: rankOf(rawEffort) !== 0, warning: undefined };

    const wanted = rankOf(lower);
    if (wanted === undefined) {
        const chosen = fallback;
        return {
            effort: chosen,
            thinking: rankOf(chosen) !== 0,
            warning: `"${rawEffort}" is not one of this model's reasoning efforts (${ids.join(', ')}); "${chosen}" was used instead.`,
        };
    }
    const nearest = [...declared].sort((left, right) => {
        const distance = Math.abs(left.rank - wanted) - Math.abs(right.rank - wanted);
        return distance !== 0 ? distance : left.rank - right.rank;
    })[0];
    return {
        effort: nearest.id,
        thinking: nearest.rank !== 0,
        warning: nearest.id === lower
            ? undefined
            : `Reasoning effort "${rawEffort}" was mapped onto this model's nearest effort, "${nearest.id}" (declared: ${ids.join(', ')}).`,
    };
}
