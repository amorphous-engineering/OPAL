/**
 * The first administrator needs a code the server printed where it started. Only someone who can see
 * the machine's console or log can take over an instance nobody has claimed yet.
 *
 * `opal serve` arms this. The code lives in memory and changes on every start. Each address gets a
 * few wrong tries, and a long run of wrong guesses replaces the code, at most once a minute, so nobody
 * can keep it changing under the admin or fill the log. Tests that do not arm it call setup directly.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { throttleAddress } from '../../auth/client-ip.ts';
import { LoginThrottle } from '../../auth/tokens.ts';

/** No letters or digits that read alike. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const MAX_WRONG = 1000;
const MIN_REISSUE_MS = 60_000;

let armed = false;
let code: string | null = null;
let wrong = 0;
let openAt = '';
let issuedAt = 0;
let wrongByAddress = new LoginThrottle(10, 300_000);

function issue(): string {
	const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
	const next = `${pick()}-${pick()}`;
	code = next;
	wrong = 0;
	issuedAt = Date.now();
	console.log(
		[
			'',
			'  ==============================================================',
			'  OPAL has no administrator yet.',
			`  Open ${openAt}/setup and enter this setup code:`,
			'',
			`      ${next}`,
			'',
			'  The code changes each time OPAL starts.',
			'  ==============================================================',
			''
		].join('\n')
	);
	return next;
}

/** Called by `serve`. `unclaimed` prints a code now; otherwise the first need for one prints it. */
export function armSetupCode(unclaimed: boolean, url: string): void {
	armed = true;
	openAt = url;
	if (unclaimed) issue();
}

/** The instance went back to first run while running (factory reset). */
export function reissueSetupCode(): void {
	if (armed) issue();
}

export const setupCodeRequired = (): boolean => armed;

const normalize = (v: string) => v.trim().toUpperCase().replaceAll(' ', '');

export type SetupCodeCheck = 'ok' | 'wrong' | 'throttled';

export function checkSetupCode(given: string | undefined, ip: string | null | undefined): SetupCodeCheck {
	const key = throttleAddress(ip);
	if (wrongByAddress.blocked(key)) return 'throttled';
	const current = code ?? issue();
	const a = Buffer.from(normalize(given ?? ''));
	const b = Buffer.from(current);
	if (a.length === b.length && timingSafeEqual(a, b)) return 'ok';
	wrongByAddress.fail(key);
	if (++wrong >= MAX_WRONG && Date.now() - issuedAt >= MIN_REISSUE_MS) issue();
	return 'wrong';
}

export function clearSetupCode(): void {
	code = null;
	wrong = 0;
}

/** For tests. */
export function disarmSetupCode(): void {
	armed = false;
	clearSetupCode();
	wrongByAddress = new LoginThrottle(10, 300_000);
}
