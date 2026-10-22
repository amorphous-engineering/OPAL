export interface Notification {
	id: number;
	kind: string;
	category: string;
	priority: string;
	title: string;
	body: string | null;
	href: string;
	created_at: string;
	read_at: string | null;
	actor_name: string | null;
}

/** The bell and the notifications page share one inbox; this keeps the bell's count live. */
const EVENT = 'opal:notifications-changed';

/** Tell the bell the inbox changed (read, dismissed, read-all). */
export function notifyChanged(): void {
	window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to inbox changes; returns the unsubscribe function. */
export function onNotificationsChanged(fn: () => void): () => void {
	window.addEventListener(EVENT, fn);
	return () => window.removeEventListener(EVENT, fn);
}
