/**
 * Token and password primitives. The hashing scheme is the legacy one so
 * imported `token_hash` values keep working: SHA-256, lowercase hex, of the
 * raw token string. Raw tokens are 32 random bytes as unpadded base64url
 * (Python's secrets.token_urlsafe(32)); API tokens add the `opal_` prefix.
 */
import { OpalError } from '@opal/shared';
import { createHash, randomBytes } from 'node:crypto';
import commonPasswordsText from './common-passwords.txt' with { type: 'text' };

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

let commonPasswords: Set<string> | undefined;
function isCommonPassword(password: string): boolean {
	commonPasswords ??= new Set(commonPasswordsText.split('\n').filter((line) => line && !line.startsWith('#')));
	return commonPasswords.has(password.toLowerCase());
}

/** Length alone lets through what an attacker tries first, however few guesses the sign-in limit leaves them. */
export function validatePasswordStrength(password: string): string | null {
	if (password.length < 10) return 'Password must be at least 10 characters.';
	if (password.length > 256) return 'Password must be at most 256 characters.';
	if (isCommonPassword(password)) return 'That password is too common. Choose another.';
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
	private swept = Date.now();
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
		this.sweep();
		this.failures.set(key, [...this.prune(key), Date.now()]);
	}
	/** Recent failures for a key, without changing anything. */
	count(key: string): number {
		return this.prune(key).length;
	}
	/** Drop keys whose failures have all aged out, at most once a minute, so names never seen again do not pile up. */
	private sweep(): void {
		const t = Date.now();
		if (t - this.swept < 60_000) return;
		this.swept = t;
		for (const key of [...this.failures.keys()]) this.prune(key);
	}
	/** Keys held in memory. */
	get size(): number {
		return this.failures.size;
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
 * Failures per username from any address. Past the cap, addresses this person has not signed in from
 * take turns at one guess per name every `lockedGuess.intervalMs`, however many addresses ask, so a
 * stranger with many addresses gets no more tries than the line allows. The person still gets in from
 * an address they have used, and a new address gets its turn however hard others ask.
 */
export const usernameThrottle = new LoginThrottle(50, 900_000);
export const lockedGuess = { intervalMs: 5000, askerTtlMs: 60_000 };

/** A person is told to come back within this, so they are back before their place lapses. */
const MAX_WAIT_MS = 30_000;
const MAX_ASKERS = 512;
const MAX_LINES = 1000;

type Asker = { firstAsked: number; lastAsked: number; served: number };
type Line = { nextAt: number; askers: Map<string, Asker> };
const lockedLines = new Map<string, Line>();

/** Never served goes first, then whoever was served longest ago; among equals, whoever asked first. */
const goesBefore = (a: Asker, b: Asker) => a.served < b.served || (a.served === b.served && a.firstAsked < b.firstAsked);

function lineFor(nameKey: string, t: number): Line {
	const found = lockedLines.get(nameKey);
	if (found) return found;
	if (lockedLines.size >= MAX_LINES) {
		for (const [key, l] of lockedLines) {
			if (l.nextAt <= t && [...l.askers.values()].every((a) => t - a.lastAsked > lockedGuess.askerTtlMs)) lockedLines.delete(key);
		}
		if (lockedLines.size >= MAX_LINES) lockedLines.delete(lockedLines.keys().next().value!);
	}
	const line: Line = { nextAt: 0, askers: new Map() };
	lockedLines.set(nameKey, line);
	return line;
}

/**
 * Asks for this address's turn at a name over its cap. 0 means the turn is taken and the guess may go
 * ahead. Otherwise it is how long to wait before asking again. Asking again does not lose the place,
 * and an address that stops asking drops out of the line. Synchronous, so requests sent at once still
 * get one check between them.
 */
export function takeLockedGuess(nameKey: string, address: string): number {
	const t = Date.now();
	const line = lineFor(nameKey, t);
	for (const [a, asker] of line.askers) if (t - asker.lastAsked > lockedGuess.askerTtlMs) line.askers.delete(a);
	let me = line.askers.get(address);
	if (me) me.lastAsked = t;
	else {
		if (line.askers.size >= MAX_ASKERS) {
			// Make room by dropping whoever just had a turn, so someone still waiting for a first one can join.
			let last: [string, Asker] | undefined;
			for (const entry of line.askers) if (entry[1].served && (!last || entry[1].served > last[1].served)) last = entry;
			if (!last) return MAX_WAIT_MS;
			line.askers.delete(last[0]);
		}
		me = { firstAsked: t, lastAsked: t, served: 0 };
		line.askers.set(address, me);
	}
	let ahead = 0;
	for (const other of line.askers.values()) if (other !== me && goesBefore(other, me)) ahead++;
	if (ahead === 0 && t >= line.nextAt) {
		me.served = t;
		line.nextAt = t + lockedGuess.intervalMs;
		return 0;
	}
	return Math.max(1, Math.min(MAX_WAIT_MS, Math.max(line.nextAt - t, 0) + ahead * lockedGuess.intervalMs));
}

/**
 * Caps the argon2id work that anonymous requests start at the same time. Each hash takes
 * memory and a thread; a flood of logins must not starve the rest of the server.
 */
const HASH_SLOTS = 4;
/** Past this many waiting, a sign-in is told to try again: a long queue only delays everyone. */
const HASH_QUEUE = 64;
let hashActive = 0;
const hashWaiting: Array<() => void> = [];
export async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (hashActive >= HASH_SLOTS) {
		if (hashWaiting.length >= HASH_QUEUE) throw new OpalError(429, 'too_many_attempts', 'The server is busy signing people in. Try again shortly.');
		await new Promise<void>((resolve) => hashWaiting.push(resolve));
	} else hashActive++;
	try {
		return await fn();
	} finally {
		const next = hashWaiting.shift();
		if (next) next(); // the slot passes to the next waiter
		else hashActive--;
	}
}
