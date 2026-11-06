import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../../src/app.ts';
import { DEFAULT_MAX_JSON_BYTES, maxJsonBytes, maxRequestBytes } from '../../src/http/limits.ts';
import { maxUploadBytes } from '../../src/services/platform/attachments.ts';
import { openTestDb } from '../helpers/db.ts';

const LIMIT = 10_000;
const saved = { json: process.env.OPAL_MAX_JSON_BYTES, upload: process.env.OPAL_MAX_UPLOAD_BYTES };
afterEach(() => {
	for (const [k, v] of [['OPAL_MAX_JSON_BYTES', saved.json], ['OPAL_MAX_UPLOAD_BYTES', saved.upload]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const big = (n: number) => JSON.stringify({ username: 'a'.repeat(n), password: 'x' });
const post = (app: { request: (r: Request) => Response | Promise<Response> }, path: string, body: BodyInit, type = 'application/json') =>
	app.request(new Request(`http://opal.test${path}`, { method: 'POST', headers: { 'content-type': type }, body }));

/** A body sent in pieces with no content-length, as a chunked request arrives. */
function chunked(total: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= total) return controller.close();
			const n = Math.min(1_000, total - sent);
			controller.enqueue(new TextEncoder().encode('a'.repeat(n)));
			sent += n;
		}
	});
}
const post_chunked = (app: { request: (r: Request) => Response | Promise<Response> }, path: string, total: number, type = 'application/json') =>
	app.request(
		new Request(`http://opal.test${path}`, {
			method: 'POST',
			headers: { 'content-type': type },
			body: chunked(total),
			// @ts-expect-error Bun and Node need `duplex` to send a stream
			duplex: 'half'
		})
	);

describe('request body limits', () => {
	beforeEach(() => {
		process.env.OPAL_MAX_JSON_BYTES = String(LIMIT);
	});
	test('a JSON operation refuses a body over the limit with a 413 in the normal error shape', async () => {
		const app = createApp({ db: await openTestDb() });
		const res = await post(app, '/api/auth/login', big(LIMIT * 2));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'payload_too_large', message: `Request body is larger than ${LIMIT} bytes` });
	});

	test('a JSON operation still takes a body under the limit', async () => {
		const app = createApp({ db: await openTestDb() });
		const res = await post(app, '/api/auth/login', big(100));
		expect(res.status).not.toBe(413);
	});

	test('the OAuth endpoints and /mcp refuse a body over the limit', async () => {
		const app = createApp({ db: await openTestDb() });
		for (const [path, type] of [
			['/oauth/register', 'application/json'],
			['/oauth/token', 'application/x-www-form-urlencoded'],
			['/mcp', 'application/json']
		] as const) {
			const res = await post(app, path, 'a'.repeat(LIMIT * 2), type);
			expect(res.status, path).toBe(413);
			expect((await res.json()).error, path).toBe('payload_too_large');
		}
	});

	test('a chunked body with no content-length is refused once it passes the limit', async () => {
		const app = createApp({ db: await openTestDb() });
		for (const [path, type] of [
			['/api/auth/login', 'application/json'],
			['/oauth/register', 'application/json'],
			['/oauth/token', 'application/x-www-form-urlencoded']
		] as const) {
			const res = await post_chunked(app, path, LIMIT * 5, type);
			expect(res.status, path).toBe(413);
			expect((await res.json()).error, path).toBe('payload_too_large');
		}
		const small = await post_chunked(app, '/oauth/register', 500);
		expect(small.status).not.toBe(413);
	});

	test('the two upload routes keep the upload limit, not the JSON limit', async () => {
		const app = createApp({ db: await openTestDb() });
		const form = () => {
			const f = new FormData();
			f.set('file', new File(['a'.repeat(LIMIT * 3)], 'a.txt', { type: 'text/plain' }));
			return f;
		};
		// Signed out, so the request gets past the body check and is refused for who is asking.
		const attach = await app.request(new Request('http://opal.test/api/attachments', { method: 'POST', body: form() }));
		expect(attach.status).toBe(401);
		const image = await app.request(new Request('http://opal.test/api/procedures/1/steps/1/images', { method: 'POST', body: form() }));
		expect(image.status).toBe(401);
	});

	test('Bun is told to accept an upload plus its form fields, and never less than a JSON body', () => {
		delete process.env.OPAL_MAX_JSON_BYTES;
		expect(maxJsonBytes()).toBe(DEFAULT_MAX_JSON_BYTES);
		// An avatar is up to 2 MB as base64 (about 2.7 MB) and must fit.
		expect(DEFAULT_MAX_JSON_BYTES).toBeGreaterThanOrEqual(3 * 1024 * 1024);
		expect(maxRequestBytes()).toBe(maxUploadBytes() + 1024 * 1024);
		process.env.OPAL_MAX_UPLOAD_BYTES = String(50 * 1024 * 1024);
		expect(maxRequestBytes()).toBe(51 * 1024 * 1024);
		process.env.OPAL_MAX_UPLOAD_BYTES = '1000';
		expect(maxRequestBytes()).toBe(DEFAULT_MAX_JSON_BYTES);
	});
});
