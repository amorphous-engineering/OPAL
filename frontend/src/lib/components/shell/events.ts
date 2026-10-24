/**
 * One server-sent event connection for the signed-in shell. Components
 * subscribe by event type; the connection opens with the first subscriber and
 * closes with the last. The browser reconnects by itself after a drop.
 *
 *   const off = onServerEvent('notification', () => refresh());
 */
import type { OpalEvent } from '@opal/shared';

type Handler = (event: OpalEvent) => void;

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | undefined;

function open() {
	if (source || typeof EventSource === 'undefined') return;
	source = new EventSource('/api/events/stream');
	source.onmessage = (m) => {
		let event: OpalEvent;
		try {
			event = JSON.parse(m.data);
		} catch {
			return;
		}
		for (const fn of handlers.get(event.type) ?? []) fn(event);
	};
}

/** Subscribe to one event type; returns the unsubscribe function. */
export function onServerEvent(type: string, fn: Handler): () => void {
	let set = handlers.get(type);
	if (!set) handlers.set(type, (set = new Set()));
	set.add(fn);
	open();
	return () => {
		set.delete(fn);
		if (set.size === 0) handlers.delete(type);
		if (handlers.size === 0) {
			source?.close();
			source = undefined;
		}
	};
}
