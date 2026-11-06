/**
 * Size and time limits on what a client sends.
 *
 * Bun applies one `maxRequestBodySize` to the whole server, so it must allow an upload. JSON
 * operations, the OAuth endpoints and /mcp never need that much: they get a lower limit here,
 * checked from content-length and, for chunked bodies, while the body is read.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { maxUploadBytes } from '../services/platform/attachments.ts';

/**
 * Largest JSON request body. The biggest real bodies are an avatar (up to 2 MB as base64, about
 * 2.7 MB) and a 5,000-row parts import. Procedure saves and bulk operations stay well under 1 MB.
 */
export const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const maxJsonBytes = () => Number(process.env.OPAL_MAX_JSON_BYTES) || DEFAULT_MAX_JSON_BYTES;

/** What Bun accepts before the app sees the request: an upload plus its form fields. */
export const maxRequestBytes = () => Math.max(maxUploadBytes() + 1024 * 1024, maxJsonBytes());

/** The two multipart routes keep the upload limit they set themselves. */
const UPLOAD = [/^\/api\/attachments$/, /^\/api\/procedures\/[^/]+\/steps\/[^/]+\/images$/];
const LIMITED = [/^\/api\//, /^\/oauth\//, /^\/mcp$/];

const tooLarge = (c: Context) =>
	c.json({ error: 'payload_too_large', message: `Request body is larger than ${maxJsonBytes()} bytes` }, 413);

export const jsonBodyLimit: MiddlewareHandler = (c, next) => {
	const path = new URL(c.req.url).pathname;
	if (!LIMITED.some((re) => re.test(path)) || UPLOAD.some((re) => re.test(path))) return next();
	return bodyLimit({ maxSize: maxJsonBytes(), onError: tooLarge })(c, next);
};
