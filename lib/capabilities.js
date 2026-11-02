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
 * The `provider/model` label a client sees for one routable model.
 * @param {{provider: string, id: string}} row - one catalog row.
 * @returns {string} the label.
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
    const rows = await catalog(ctx);
    if (rows.length === 0) {
        throw new ApiFailure(
            503,
            'no_models',
            'This profile has no routable models configured, so there is nothing to serve.',
            'server_error',
        );
    }
    const pick = (row) => ({ provider: row.provider, model: row.id });
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

    const exact = rows.find((row) => routeLabel(row) === raw) ?? rows.find((row) => row.id === raw);
    if (exact !== undefined) return pick(exact);

    // A client that prefixes anything onto the id ("openai/deepseek/...") still
    // names exactly one row when the suffix is a real model id.
    const suffixed = rows.filter((row) => raw.endsWith(`/${row.id}`));
    if (suffixed.length === 1) return pick(suffixed[0]);
    if (suffixed.length > 1) {
        const preferred = rows.find((row) => row.provider === selection?.provider && suffixed.includes(row));
        if (preferred !== undefined) return pick(preferred);
        throw new ApiFailure(
            400,
            'ambiguous_model',
            `Model "${raw}" matches ${suffixed.length} routes (${suffixed.map(routeLabel).join(', ')}). Send the "provider/model" form from GET /v1/models.`,
            'invalid_request_error',
            'model',
        );
    }

    throw new ApiFailure(
        404,
        'model_not_found',
        `Model "${raw}" is not configured in this profile. GET /v1/models lists ${rows.length} routable model(s): ${rows.map(routeLabel).join(', ')}.`,
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
