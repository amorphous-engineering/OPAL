/**
 * Importance sets contrast (STYLE.md). Stopped and waiting are filled in a badge; the rest are words:
 * info is in flight, ok reached a good state, default at rest, draft not started, muted over.
 */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'draft' | 'muted' | 'default';

export const toneText: Record<Tone, string> = {
	ok: 'text-ok',
	warn: 'text-warn',
	error: 'text-error',
	info: 'font-bold text-foreground',
	draft: 'text-tan',
	muted: 'font-normal text-quiet',
	default: 'text-foreground'
};

export const toneBox: Record<Tone, string> = {
	ok: 'border-dotted border-ok text-ok',
	warn: 'border-warn-fill bg-warn-fill text-warn-on',
	error: 'border-error-fill bg-error-fill text-error-on',
	info: 'border-transparent px-0 font-bold text-foreground',
	draft: 'border-transparent px-0 text-tan',
	muted: 'border-dotted border-quiet font-normal text-quiet',
	default: 'border-dotted border-foreground text-foreground'
};

/** Common domain states → tone. Unknown states stay neutral. */
const STATE_TONES: Record<string, Tone> = {
	// reached a good state
	completed: 'ok',
	signed_off: 'ok',
	received: 'ok',
	passed: 'ok',
	pass: 'ok',
	done: 'ok',
	verified: 'ok',
	baselined: 'ok',
	accepted: 'ok',
	// in flight
	in_progress: 'info',
	in_work: 'info',
	in_review: 'info',
	partial: 'info',
	// not started, still pencil
	draft: 'draft',
	cut: 'draft',
	pending: 'draft',
	preliminary: 'draft',
	// waiting on a person
	awaiting_signoff: 'warn',
	// over
	closed: 'muted',
	skipped: 'muted',
	deprecated: 'muted',
	obsolete: 'muted',
	superseded: 'muted',
	cancelled: 'muted',
	void: 'muted',
	closed_short: 'muted',
	// stopped
	on_hold: 'error',
	blocked: 'error',
	failed: 'error',
	fail: 'error',
	critical: 'error',
	// priority and severity below stopped
	high: 'info',
	low: 'muted'
};

export function toneFor(state: string | null | undefined): Tone {
	return (state && STATE_TONES[state.toLowerCase()]) || 'default';
}
