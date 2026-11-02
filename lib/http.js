/**
 * dsh-endpoint — HTTP plumbing.
 *
 * Everything here is transport: reading a body, writing a body, and turning a
 * thrown value into the error envelope an OpenAI client understands. Nothing in
 * this file knows what a model is.
 */
import { timingSafeEqual } from 'node:crypto';

/** Largest accepted request body. Long conversations are big; this still bounds memory. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A request failure that already knows its HTTP shape.
 *
 * Thrown anywhere below the transport layer; `failRequest` turns it into the
 * OpenAI error envelope. Anything that is *not* an ApiFailure is a bug and
 * becomes a 500 without leaking internals.
 */
export class ApiFailure extends Error {
    /**
     * @param {number} status - HTTP status to answer with.
     * @param {string} code - stable machine-readable code, e.g. `context_length_exceeded`.
     * @param {string} message - human-readable explanation, safe to show a client.
     * @param {string} [type] - OpenAI error `type` bucket.
     * @param {string} [param] - offending request field, when one is to blame.
     */
    constructor(status, code, message, type = 'invalid_request_error', param) {
        super(message);
        this.name = 'ApiFailure';
        this.status = status;
        this.code = code;
        this.type = type;
        this.param = param;
    }
}

/**
 * Project any thrown value into the OpenAI error envelope.
 * @param {unknown} error - whatever was caught.
 * @returns {{status: number, body: object}} status and envelope to write.
 */
export function errorEnvelope(error) {
    if (error instanceof ApiFailure) {
        return {
            status: error.status,
            body: {
                error: {
                    message: error.message,
                    type: error.type,
                    code: error.code,
                    ...(error.param === undefined ? {} : { param: error.param }),
                },
            },
        };
    }
    // An unexpected throw is our bug: never echo the stack or the message.
    return {
        status: 500,
        body: { error: { message: 'The endpoint failed to answer this request.', type: 'server_error', code: 'internal_error' } },
    };
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response to write.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serialisable payload.
 * @param {Record<string, string>} [headers] - extra response headers.
 * @returns {void}
 */
export function sendJson(response, status, body, headers = {}) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.length),
        'cache-control': 'no-store',
        ...headers,
    });
    response.end(payload);
}

/**
 * Answer a failed request. Safe to call after headers went out: it then only
 * terminates the response instead of corrupting a half-written stream.
 * @param {import('node:http').ServerResponse} response - the response to write.
 * @param {unknown} error - the value that was thrown.
 * @returns {void}
 */
export function failRequest(response, error) {
    if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
    }
    const { status, body } = errorEnvelope(error);
    sendJson(response, status, body);
}

/**
 * Read one JSON request body with a hard byte ceiling.
 * @param {import('node:http').IncomingMessage} request - the request to read.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<unknown>} the parsed JSON value.
 * @throws {ApiFailure} 413 when oversized, 400 when absent or unparsable.
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > limit) {
            throw new ApiFailure(413, 'request_too_large', `Request body exceeds ${limit} bytes.`);
        }
        chunks.push(chunk);
    }
    if (total === 0) {
        throw new ApiFailure(400, 'invalid_request_error', 'Request body is empty; a JSON object is required.');
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new ApiFailure(400, 'invalid_json', 'Request body is not valid JSON.');
    }
}

/**
 * Read the bearer token a client presented.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {string} the token, or an empty string when none was sent.
 */
export function presentedKey(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match === null ? '' : match[1].trim();
}

/**
 * Compare a presented token against the configured one without leaking its
 * length through timing.
 * @param {string} expected - configured key; empty means authentication is off.
 * @param {string} presented - token the client sent.
 * @returns {boolean} whether the request may proceed.
 */
export function keyMatches(expected, presented) {
    if (expected === '') return true;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
