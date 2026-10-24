/**
 * Short-lived signed payloads (OIDC handshake state, account-claim links). Same wire format as
 * legacy `sign_payload`: base64url(JSON) "." hex(HMAC-SHA256(JSON, secret)), with the expiry in
 * the JSON as `__exp` (epoch seconds). Links issued by the Python release keep working.
 *
 * The secret is OPAL_AUTH_SECRET, else a file next to the database (`.opal_auth_secret`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.ts';

let cached: { dir: string; secret: string } | undefined;

export function authSecret(): string {
	const configured = process.env.OPAL_AUTH_SECRET;
	if (configured) return configured;
	const dir = dataDir();
	if (cached?.dir === dir) return cached.secret;
	const file = join(dir, '.opal_auth_secret');
	let secret = '';
	try {
		if (existsSync(file)) secret = readFileSync(file, 'utf8').trim();
		if (!secret) {
			secret = randomBytes(32).toString('hex');
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, secret, 'utf8');
			chmodSync(file, 0o600);
		}
	} catch (e) {
		console.warn(`Could not persist the auth secret (${(e as Error).message}); using a process secret`);
		secret ||= randomBytes(32).toString('hex');
	}
	cached = { dir, secret };
	return secret;
}

const mac = (raw: Buffer | string) => createHmac('sha256', authSecret()).update(raw).digest('hex');

export function signPayload(payload: Record<string, unknown>, maxAgeMs = 300_000): string {
	const raw = JSON.stringify({ ...payload, __exp: (Date.now() + maxAgeMs) / 1000 });
	return `${Buffer.from(raw).toString('base64url')}.${mac(raw)}`;
}

export function verifyPayload(value: string | null | undefined): Record<string, unknown> | null {
	if (!value || !value.includes('.')) return null;
	const cut = value.lastIndexOf('.');
	const raw = Buffer.from(value.slice(0, cut), 'base64url');
	const given = Buffer.from(value.slice(cut + 1));
	const expected = Buffer.from(mac(raw));
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(raw.toString('utf8'));
	} catch {
		return null;
	}
	const exp = Number(body.__exp ?? 0);
	delete body.__exp;
	return Date.now() / 1000 > exp ? null : body;
}
