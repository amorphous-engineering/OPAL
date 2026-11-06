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
const streamWatchers = new Set<(up: boolean) => void>();
let source: EventSource | undefined;
// A refused connection is not retried by the browser, so it is retried here.
const RETRY_MS = 5_000;

function open() {
	if (source || typeof EventSource === 'undefined') return;
	const es = new EventSource('/api/events/stream');
	source = es;
	es.onopen = () => streamWatchers.forEach((fn) => fn(true));
	es.onerror = () => {
		streamWatchers.forEach((fn) => fn(false));
		if (es.readyState !== EventSource.CLOSED || source !== es) return;
		source = undefined;
		setTimeout(() => {
			if (handlers.size) open();
		}, RETRY_MS);
	};
	es.onmessage = (m) => {
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

/** Told each time the event stream opens or drops; returns the unsubscribe function. */
export function onStreamChange(fn: (up: boolean) => void): () => void {
	streamWatchers.add(fn);
	return () => {
		streamWatchers.delete(fn);
	};
}
