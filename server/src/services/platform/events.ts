/**
 * In-process event bus behind the server-sent event stream.
 *
 * Services call `publish` while their operation runs. Delivery is deferred to
 * the next macrotask, which is after the operation's COMMIT, so a client that
 * reacts to an event and re-reads always sees the committed data.
 * (An operation that fails after publishing still sends its event: publish as
 * the last step of a handler.)
 */
import { now, type OpalEvent } from '@opal/shared';

export interface PublishInput {
	/** Known types are in `EVENT_TYPES`; any string is accepted. */
	type: string;
	data?: Record<string, unknown>;
	/** Deliver only to these users' streams. Omit to broadcast. */
	userIds?: number[];
	/** `plugins`: plugin streams only. Browsers never see it (record_changed carries every audited write). */
	audience?: 'plugins';
}

type Listener = (event: OpalEvent) => void;
interface Subscriber {
	userId: number | null;
	listener: Listener;
	/** A plugin's stream: gets `audience: 'plugins'` events too. */
	plugin: boolean;
}

const subscribers = new Set<Subscriber>();
let queue: { event: OpalEvent; userIds?: number[]; audience?: 'plugins' }[] = [];
let scheduled = false;

/** Queue an event for every connected client (or the listed users). */
export function publish(input: PublishInput): void {
	queue.push({
		event: { type: input.type, data: input.data ?? {}, timestamp: now() },
		userIds: input.userIds,
		audience: input.audience
	});
	if (scheduled) return;
	scheduled = true;
	setTimeout(drain, 0);
}

function drain(): void {
	scheduled = false;
	const batch = queue;
	queue = [];
	for (const { event, userIds, audience } of batch) {
		for (const sub of [...subscribers]) {
			if (audience === 'plugins' && !sub.plugin) continue;
			if (userIds && (sub.userId === null || !userIds.includes(sub.userId))) continue;
			try {
				sub.listener(event);
			} catch {
				/* a broken client must not stop delivery to the others */
			}
		}
	}
}

/** Add a listener. Returns the function that removes it. */
export function subscribe(userId: number | null, listener: Listener, opts: { plugin?: boolean } = {}): () => void {
	const sub = { userId, listener, plugin: opts.plugin === true };
	subscribers.add(sub);
	return () => void subscribers.delete(sub);
}

export function subscriberCount(): number {
	return subscribers.size;
}

/** For tests: resolves after every queued event has been delivered. */
export function flushEvents(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}
