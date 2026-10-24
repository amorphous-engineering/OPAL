export type { Notification } from '@opal/shared';

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
