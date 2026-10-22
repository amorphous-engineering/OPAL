/** Functional state colour. Only exceptional or actionable states get a tone. */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted' | 'default';

export const toneText: Record<Tone, string> = {
	ok: 'text-ok',
	warn: 'text-warn',
	error: 'text-error',
	info: 'text-info',
	muted: 'text-muted-foreground',
	default: 'text-foreground'
};

export const toneBox: Record<Tone, string> = {
	ok: 'border-ok/40 bg-ok-muted text-ok',
	warn: 'border-warn/50 bg-warn-muted text-warn',
	error: 'border-error/40 bg-error-muted text-error',
	info: 'border-info/40 bg-info-muted text-info',
	muted: 'border-border bg-muted text-muted-foreground',
	default: 'border-border bg-background text-foreground'
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
	// trouble
	on_hold: 'warn',
	blocked: 'warn',
	open: 'warn',
	aborted: 'error',
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
