/**
 * dsh-endpoint — OpenAI wire protocol to Harness messages.
 *
 * The only file that knows what an OpenAI `messages` array looks like. Turns it
 * into the request messages `ctx.llm.stream` accepts, including image parts and
 * the tool-history folding rule. Owns no model semantics and no transport.
 */

/* eslint-disable no-unused-vars */

/**
 * Convert one request's `messages` into Harness request messages.
 * @param {object} ctx - the plugin context (attachment admission lives here).
 * @param {unknown[]} messages - the request's `messages` array.
 * @param {AbortSignal} [signal] - request lifetime.
 * @returns {Promise<{messages: object[], system: string|undefined}>} converted history.
 */
export async function toRequestMessages(ctx, messages, signal) {
    throw new Error('protocol.toRequestMessages is implemented in P1/P3');
}

/**
 * Reject a request that asks for tool calling this endpoint does not serve.
 * @param {unknown} tools - the request's `tools` field.
 * @returns {void}
 * @throws {import('./http.js').ApiFailure} 400 `tools_unsupported` when present.
 */
export function assertNoTools(tools) {
    throw new Error('protocol.assertNoTools is implemented in P4');
}
