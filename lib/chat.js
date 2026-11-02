/**
 * dsh-endpoint — one completion, start to finish.
 *
 * Assembles the `ctx.llm.stream` options for one request, consumes the chunk
 * stream, and writes either one JSON body or one SSE body. Also owns usage
 * normalisation. Owns no request parsing and no route selection.
 */
import { ApiFailure } from './http.js';

/**
 * Answer one `POST /v1/chat/completions`.
 * @param {object} deps - {ctx, settings, bound, request, response}.
 * @returns {Promise<void>} resolves once the response is finished.
 * @throws {ApiFailure} 501 until the completion path lands.
 */
export async function handleChat(deps) {
    throw new ApiFailure(501, 'not_implemented', 'Completions land in P1.');
}
