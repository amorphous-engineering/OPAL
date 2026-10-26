/**
 * Time worked, counted up to now. The server counts finished clock-ins; an open one counts
 * from `since` on this clock. `clock.now` ticks once a second while something reads it.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { DocLabor } from './types.js';

let current = Date.now();
const subscribe = createSubscriber((update) => {
	const t = setInterval(() => {
		current = Date.now();
		update();
	}, 1000);
	return () => clearInterval(t);
});

export const clock = {
	get now() {
		subscribe();
		return current;
	}
};

export const liveSeconds = (l: DocLabor, now: number) =>
	l.seconds + (l.since ? Math.max(0, Math.floor((now - Date.parse(l.since)) / 1000)) : 0);

/** One row per person: OPs worked and the time across them. */
export function byPerson(rows: DocLabor[], now: number) {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not reactive state
	const out = new Map<
		number,
		{
			user_id: number;
			name: string | null;
			avatar_url: string | null;
			ops: number;
			seconds: number;
			clocked_in: boolean;
		}
	>();
	for (const l of rows) {
		const p = out.get(l.user_id) ?? {
			user_id: l.user_id,
			name: l.name,
			avatar_url: l.avatar_url,
			ops: 0,
			seconds: 0,
			clocked_in: false
		};
		p.ops += 1;
		p.seconds += liveSeconds(l, now);
		p.clocked_in ||= l.since !== null;
		out.set(l.user_id, p);
	}
	return [...out.values()].sort((a, b) => b.seconds - a.seconds);
}
