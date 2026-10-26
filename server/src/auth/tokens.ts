/**
 * Token and password primitives. The hashing scheme is the legacy one so
 * imported `token_hash` values keep working: SHA-256, lowercase hex, of the
 * raw token string. Raw tokens are 32 random bytes as unpadded base64url
 * (Python's secrets.token_urlsafe(32)); API tokens add the `opal_` prefix.
 */
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'opal_session';
export const API_TOKEN_PREFIX = 'opal_';
export const SESSION_LIFETIME_MS = 30 * 24 * 3600 * 1000;
/** Bookkeeping writes happen at most this often per row. */
export const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashToken(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

export function newToken(prefix = ''): string {
	return prefix + randomBytes(32).toString('base64url');
}

export function expired(at: string | null, nowMs = Date.now()): boolean {
	if (!at) return false;
	// Imported legacy values may lack the Z suffix; they are UTC.
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`);
	return Number.isNaN(ms) || ms <= nowMs;
}

export function addMs(ms: number): string {
	return new Date(Date.now() + ms).toISOString();
}

/** argon2id via Bun. Reads legacy argon2-cffi PHC strings too. */
export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
	if (!hash) return false;
	try {
		return await Bun.password.verify(password, hash);
	} catch {
		return false; // malformed hash
	}
}

let dummy: Promise<string> | undefined;
/** Verified against when the user is unknown, so timing does not reveal usernames. */
export function burnVerify(password: string): Promise<boolean> {
	dummy ??= hashPassword(newToken());
	return dummy.then((h) => verifyPassword(h, password));
}

export function validatePasswordStrength(password: string): string | null {
	if (password.length < 10) return 'Password must be at least 10 characters.';
	if (password.length > 256) return 'Password must be at most 256 characters.';
	return null;
}

export function normalizeUsername(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '.')
		.replace(/^\.+|\.+$/g, '')
		.slice(0, 64);
}

/** Plugin identities are named `plugin.<id>`. Humans never get this prefix, so a person cannot hold a plugin's name. */
export const PLUGIN_USERNAME_PREFIX = 'plugin.';
export const isPluginUsername = (username: string): boolean => username.startsWith(PLUGIN_USERNAME_PREFIX);

/** A derived username seed that does not start with the reserved plugin prefix. */
export function humanUsernameBase(raw: string): string {
	const base = normalizeUsername(raw) || 'user';
	return isPluginUsername(base) ? normalizeUsername(`user.${base}`) : base;
}

/** In-process failure counter keyed by ip:username. OPAL runs as one process. */
export class LoginThrottle {
	private failures = new Map<string, number[]>();
	constructor(
		private max = 10,
		private windowMs = 300_000
	) {}
	private prune(key: string): number[] {
		const t = Date.now();
		const kept = (this.failures.get(key) ?? []).filter((x) => t - x < this.windowMs);
		if (kept.length) this.failures.set(key, kept);
		else this.failures.delete(key);
		return kept;
	}
	blocked(key: string): boolean {
		return this.prune(key).length >= this.max;
	}
	fail(key: string): void {
		this.failures.set(key, [...this.prune(key), Date.now()]);
	}
	reset(key: string): void {
		this.failures.delete(key);
	}
	/** Take back the newest failure: an attempt counted before its check ended well. */
	release(key: string): void {
		const kept = this.prune(key);
		if (kept.length) this.failures.set(key, kept.slice(0, -1));
	}
}
export const loginThrottle = new LoginThrottle();
/**
 * Failures per username from any address. Generous, so a stranger who guesses a name cannot
 * lock a person out for long, yet it caps guessing from many addresses.
 */
export const usernameThrottle = new LoginThrottle(50, 900_000);

/**
 * Caps the argon2id work that anonymous requests start at the same time. Each hash takes
 * memory and a thread; a flood of logins must not starve the rest of the server.
 */
const HASH_SLOTS = 4;
let hashActive = 0;
const hashWaiting: Array<() => void> = [];
export async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (hashActive >= HASH_SLOTS) await new Promise<void>((resolve) => hashWaiting.push(resolve));
	else hashActive++;
	try {
		return await fn();
	} finally {
		const next = hashWaiting.shift();
		if (next) next(); // the slot passes to the next waiter
		else hashActive--;
	}
}
