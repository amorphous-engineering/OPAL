/**
 * The first administrator needs a code the server printed where it started. Only someone who can see
 * the machine's console or log can take over an instance nobody has claimed yet.
 *
 * `opal serve` arms this. The code lives in memory and changes on every start. A run of wrong
 * guesses replaces it. Tests that do not arm it call setup directly.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';

/** No letters or digits that read alike. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const MAX_WRONG = 20;

let armed = false;
let code: string | null = null;
let wrong = 0;
let openAt = '';

function issue(): string {
	const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
	const next = `${pick()}-${pick()}`;
	code = next;
	wrong = 0;
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

export function setupCodeMatches(given: string | undefined): boolean {
	const current = code ?? issue();
	const a = Buffer.from(normalize(given ?? ''));
	const b = Buffer.from(current);
	if (a.length === b.length && timingSafeEqual(a, b)) return true;
	if (++wrong >= MAX_WRONG) issue();
	return false;
}

export function clearSetupCode(): void {
	code = null;
	wrong = 0;
}

/** For tests. */
export function disarmSetupCode(): void {
	armed = false;
	clearSetupCode();
}
