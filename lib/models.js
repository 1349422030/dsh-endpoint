/**
 * dsh-endpoint — the model catalogue.
 *
 * Projects the models this profile is configured for into a model card.
 *
 * OpenAI's own `model` object is deliberately minimal: id, object, created,
 * owned_by. Nothing in it says how large the context window is, what the output
 * ceiling is, which modalities the model takes, or which reasoning efforts it
 * declares — so every client ends up hard-coding guesses. OpenRouter's model
 * schema is the widely implemented answer to exactly that gap, and it is what
 * this endpoint serves: `context_length`, `architecture`,
 * `top_provider.max_completion_tokens`, `supported_parameters` and
 * `reasoning`. Clients that already speak that schema need no new code.
 *
 * A model whose metadata cannot be resolved is still listed (it is routed,
 * after all) but with those fields left `null`, so a client degrades instead
 * of failing.
 */
import { capabilitiesOf, catalog, modelInfo } from './capabilities.js';

/** Stable creation stamp: this endpoint publishes configuration, not dated builds. */
const MODEL_CREATED = 1_704_067_200;

/**
 * Give every row a public id that is unique across providers.
 *
 * A bare model id is what clients expect, so it is used whenever only one
 * provider exposes it; a collision is disambiguated as `provider/model`, which
 * is also what `/v1/chat/completions` accepts as a `model` value.
 * @param {{provider: string, id: string, name?: string}[]} rows - routed models.
 * @returns {{provider: string, id: string, name?: string, publicId: string}[]} rows with public ids.
 */
function withPublicIds(rows) {
    const counts = new Map();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return rows.map((row) => ({
        ...row,
        publicId: counts.get(row.id) === 1 ? row.id : `${row.provider}/${row.id}`,
    }));
}

/**
 * The parameters this endpoint honours for one model.
 *
 * Only what the endpoint actually does: `max_tokens` is enforced, `stop` and
 * `temperature` are accepted, and the two reasoning spellings exist only where
 * the model declares efforts at all. `tools` is always listed: function
 * declarations are passed through to the model and tool calls are returned to
 * the caller, which executes them — the endpoint itself runs nothing.
 * @param {object} capabilities - the projected capabilities.
 * @returns {string[]} the supported parameter names.
 */
function supportedParameters(capabilities) {
    const names = ['max_tokens', 'stop', 'temperature', 'tools'];
    if (capabilities.reasoning.supported) names.push('reasoning', 'reasoning_effort');
    return names;
}

/**
 * Describe one model as an OpenRouter-shaped model card.
 * @param {object} ctx - the plugin context.
 * @param {{provider: string, id: string, name?: string, publicId: string}} row - the routed model.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<object>} the model object.
 */
async function describe(ctx, row, signal) {
    const info = await modelInfo(ctx, { provider: row.provider, model: row.id }, signal);
    const capabilities = capabilitiesOf(info);
    const efforts = capabilities.reasoning.efforts.map((effort) => effort.id);
    const inputs = capabilities.input_modalities;
    return {
        id: row.publicId,
        object: 'model',
        created: MODEL_CREATED,
        owned_by: row.provider,
        name: row.name ?? info?.name ?? row.id,
        context_length: capabilities.context_length,
        architecture: inputs === null
            ? null
            : {
                modality: `${inputs.join('+')}->${capabilities.output_modalities.join('+')}`,
                input_modalities: inputs,
                output_modalities: capabilities.output_modalities,
            },
        top_provider: capabilities.max_output_tokens === null
            ? null
            : { context_length: capabilities.context_length, max_completion_tokens: capabilities.max_output_tokens },
        supported_parameters: supportedParameters(capabilities),
        reasoning: capabilities.reasoning.supported
            ? {
                mandatory: false,
                default_enabled: true,
                supported_efforts: efforts,
                default_effort: capabilities.reasoning.default_effort,
            }
            : null,
    };
}

/**
 * Build `GET /v1/models`.
 * @param {object} ctx - the plugin context.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<object>} the OpenAI list object.
 */
export async function listModels(ctx, signal) {
    const rows = withPublicIds(await catalog(ctx));
    const data = [];
    for (const row of rows) data.push(await describe(ctx, row, signal));
    return { object: 'list', data };
}

/**
 * Build `GET /v1/models/{id}`.
 * @param {object} ctx - the plugin context.
 * @param {string} id - the model id from the path, already URL-decoded.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<object|undefined>} the model object, or undefined when no such model is routable.
 */
export async function modelById(ctx, id, signal) {
    const rows = withPublicIds(await catalog(ctx));
    const row = rows.find((candidate) => candidate.publicId === id
        || candidate.id === id
        || `${candidate.provider}/${candidate.id}` === id);
    if (row === undefined) return undefined;
    return describe(ctx, row, signal);
}
