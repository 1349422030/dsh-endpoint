/**
 * dsh-endpoint — model routing and capability projection.
 *
 * Owns every question about *which model* answers a request and *what that
 * model can do*: route resolution (request id → provider/model), the reasoning
 * effort vocabulary, and the capability object `/v1/models` publishes.
 * Owns no I/O of its own beyond reading the LLM registry.
 */

/* eslint-disable no-unused-vars */

/**
 * Resolve the route one request should be served by.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - this generation's settings snapshot.
 * @param {object|undefined} selection - the profile's current model selection.
 * @param {string|undefined} requested - the request's `model` field.
 * @param {AbortSignal} [signal] - request lifetime.
 * @returns {Promise<{provider: string, model: string}>} the resolved route.
 */
export async function resolveRoute(ctx, settings, selection, requested, signal) {
    throw new Error('capabilities.resolveRoute is implemented in P2');
}

/**
 * Project a resolved model into the capability object clients read.
 * @param {object} info - `ctx.llm.resolveModelInfo` result.
 * @returns {object} capabilities in the shape `/v1/models` publishes.
 */
export function capabilitiesOf(info) {
    throw new Error('capabilities.capabilitiesOf is implemented in P2');
}

/**
 * Pick the reasoning effort to send, honouring only efforts the model declares.
 * @param {object|undefined} info - resolved model info.
 * @param {unknown} requested - the request's reasoning fields, if any.
 * @returns {{effort: string|undefined, warning: string|undefined}} the decision.
 */
export function resolveEffort(info, requested) {
    throw new Error('capabilities.resolveEffort is implemented in P2');
}
