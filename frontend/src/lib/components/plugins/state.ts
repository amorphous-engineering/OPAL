import { ApiError } from '#lib/api.js';
import type { Tone } from '#lib/components/opal/index.js';

export const PROCESS_TONES: Record<string, Tone> = {
	running: 'ok',
	starting: 'warn',
	crashed: 'error',
	stopped: 'muted'
};

/** An API error as one line. A `missing_settings` refusal names the settings when the body lists them. */
export function pluginError(e: unknown, fallback = 'Action failed'): string {
	if (!(e instanceof ApiError)) return e instanceof Error ? e.message || fallback : fallback;
	const d = e.detail as Record<string, unknown> | null;
	if (d && typeof d === 'object' && d.error === 'missing_settings') {
		const list = [d.missing, d.settings, d.keys, d.fields].find(Array.isArray) as
			unknown[] | undefined;
		const names =
			list?.map(String) ?? (d.fields && typeof d.fields === 'object' ? Object.keys(d.fields) : []);
		if (names.length) return `Missing settings: ${names.join(', ')}`;
	}
	return e.message || fallback;
}

/** `owner/repo@ref` of a summary. */
export const sourceLabel = (p: { source: string; ref: string | null }) =>
	p.ref ? `${p.source}@${p.ref}` : p.source;
