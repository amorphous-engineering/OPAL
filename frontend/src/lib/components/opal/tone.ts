/** Functional state colour. Only exceptional or actionable states get a tone. */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted' | 'default';

export const toneText: Record<Tone, string> = {
	ok: 'text-ok',
	warn: 'text-warn',
	error: 'text-error',
	info: 'text-foreground',
	muted: 'text-muted-foreground',
	default: 'text-foreground'
};

export const toneBox: Record<Tone, string> = {
	ok: 'border-dotted border-ok text-ok',
	warn: 'border-warn-fill bg-warn-fill text-warn-on',
	error: 'border-error-fill bg-error-fill text-error-on',
	info: 'border-transparent px-0 text-foreground',
	muted: 'border-dotted border-foreground text-foreground',
	default: 'border-dotted border-foreground text-foreground'
};

/** Common domain states → tone. Unknown states stay neutral. */
const STATE_TONES: Record<string, Tone> = {
	// lifecycle / completion
	completed: 'ok',
	signed_off: 'ok',
	closed: 'muted',
	active: 'ok',
	received: 'ok',
	passed: 'ok',
	pass: 'ok',
	// in flight
	in_progress: 'info',
	in_work: 'info',
	cut: 'info',
	submitted: 'info',
	ordered: 'info',
	awaiting_signoff: 'warn',
	partial: 'warn',
	draft: 'muted',
	pending: 'muted',
	skipped: 'muted',
	deprecated: 'muted',
	cancelled: 'muted',
	void: 'muted',
	closed_short: 'muted',
	// trouble
	on_hold: 'warn',
	blocked: 'warn',
	open: 'warn',
	failed: 'error',
	fail: 'error',
	critical: 'error',
	high: 'error',
	medium: 'warn',
	low: 'muted'
};

export function toneFor(state: string | null | undefined): Tone {
	return (state && STATE_TONES[state.toLowerCase()]) || 'default';
}
