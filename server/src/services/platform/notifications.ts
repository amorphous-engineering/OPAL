/**
 * Notifications: one row per recipient per event.
 *
 * Other areas decide WHEN to notify (issues, executions) and call `notify`.
 * This module decides WHO receives it: the actor never does, and neither does
 * anyone unknown or inactive. Rows are written directly, without audit rows:
 * they are inbox bookkeeping, and an audit row per recipient would drown the log.
 */
import {
	categoryForKind,
	type Notification,
	type NotificationCategory,
	type NotificationKind,
	type NotificationPriority,
	NOTIFICATION_KINDS,
	notFound,
	now
} from '@opal/shared';
import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { notification, user } from '../../db/schema/index.ts';
import { publish } from './events.ts';

type Row = typeof notification.$inferSelect;

export interface NotifyInput {
	/** User ids. Duplicates, the actor, unknown and inactive users are dropped. */
	recipients: Iterable<number | null | undefined>;
	kind: NotificationKind;
	title: string;
	/** Where the reader goes to see the live record. */
	href: string;
	subjectType: string;
	subjectId: number;
	body?: string | null;
	priority?: NotificationPriority;
}

/**
 * Write one notification per recipient. The caller is the actor (`ctx.actor`).
 * Returns the rows created: empty when the only candidate was the actor.
 */
export function notify(ctx: Ctx, input: NotifyInput): Row[] {
	const actorId = actorUserId(ctx.actor);
	const wanted = new Set<number>();
	for (const id of input.recipients) if (id != null && id !== actorId) wanted.add(id);
	if (wanted.size === 0) return [];
	const active = ctx.db
		.select({ id: user.id })
		.from(user)
		.where(and(inArray(user.id, [...wanted]), eq(user.isActive, true)))
		.all()
		.map((u) => u.id)
		.sort((a, b) => a - b);
	if (active.length === 0) return [];
	const at = now();
	const rows = ctx.db
		.insert(notification)
		.values(
			active.map((userId) => ({
				userId,
				actorId,
				kind: input.kind,
				priority: input.priority ?? 'normal',
				title: input.title,
				body: input.body ?? null,
				href: input.href,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
				createdAt: at
			}))
		)
		.returning()
		.all();
	publish({ type: 'notification', data: { kind: input.kind }, userIds: active });
	return rows;
}

/** Issue priority → notification priority: an issue's urgency is the reader's urgency. */
export function priorityFromIssue(p: string | null | undefined): NotificationPriority {
	return p === 'critical' ? 'critical' : p === 'high' ? 'high' : p === 'low' ? 'low' : 'normal';
}

const PRIORITY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1, low: 0 };

function kindsIn(category: NotificationCategory): NotificationKind[] {
	return NOTIFICATION_KINDS.filter((k) => categoryForKind(k) === category);
}

function toNotification(r: Row, actorName: string | null): Notification {
	return {
		id: r.id,
		kind: r.kind,
		category: categoryForKind(r.kind),
		priority: r.priority,
		title: r.title,
		body: r.body,
		href: r.href,
		subjectType: r.subjectType,
		subjectId: r.subjectId,
		createdAt: r.createdAt,
		readAt: r.readAt,
		actorName
	};
}

function actorNames(ctx: Ctx, rows: Row[]): Map<number, string> {
	const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is number => x != null))];
	if (ids.length === 0) return new Map();
	return new Map(
		ctx.db
			.select({ id: user.id, name: user.name })
			.from(user)
			.where(inArray(user.id, ids))
			.all()
			.map((u) => [u.id, u.name])
	);
}

export function unreadCount(ctx: Ctx, userId: number): number {
	return (
		ctx.db
			.select({ n: count() })
			.from(notification)
			.where(
				and(
					eq(notification.userId, userId),
					isNull(notification.readAt),
					isNull(notification.dismissedAt)
				)
			)
			.get()?.n ?? 0
	);
}

export interface ListInput {
	cursor?: string;
	limit: number;
	state?: 'unread' | 'read';
	category?: NotificationCategory;
	sort: 'recent' | 'priority' | 'unread';
}

/** The reader's undismissed notifications. The cursor is a position in the sorted list. */
export function list(ctx: Ctx, userId: number, input: ListInput) {
	const rows = ctx.db
		.select()
		.from(notification)
		.where(
			and(
				eq(notification.userId, userId),
				isNull(notification.dismissedAt),
				input.state === 'unread' ? isNull(notification.readAt) : undefined,
				input.state === 'read' ? isNotNull(notification.readAt) : undefined,
				// Category is derived from kind, so it filters on the kinds in it.
				input.category ? inArray(notification.kind, kindsIn(input.category)) : undefined
			)
		)
		.orderBy(desc(notification.createdAt), desc(notification.id))
		.all();
	if (input.sort === 'priority') {
		rows.sort(
			(a, b) =>
				(PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1) ||
				b.createdAt.localeCompare(a.createdAt) ||
				b.id - a.id
		);
	} else if (input.sort === 'unread') {
		rows.sort(
			(a, b) =>
				Number(b.readAt === null) - Number(a.readAt === null) ||
				b.createdAt.localeCompare(a.createdAt) ||
				b.id - a.id
		);
	}
	const start = Math.max(0, Number(input.cursor) || 0);
	const page = rows.slice(start, start + input.limit);
	const names = actorNames(ctx, page);
	return {
		items: page.map((r) => toNotification(r, r.actorId == null ? null : (names.get(r.actorId) ?? null))),
		next: start + input.limit < rows.length ? String(start + input.limit) : null,
		total: rows.length,
		unreadCount: unreadCount(ctx, userId)
	};
}

function owned(ctx: Ctx, userId: number, id: number): Row {
	const row = ctx.db
		.select()
		.from(notification)
		.where(and(eq(notification.id, id), eq(notification.userId, userId)))
		.get();
	if (!row) throw notFound('Notification');
	return row;
}

function present(ctx: Ctx, row: Row): Notification {
	return toNotification(row, actorNames(ctx, [row]).get(row.actorId ?? -1) ?? null);
}

/** Scoped to the owner: someone else's notification is a 404. */
export function markRead(ctx: Ctx, userId: number, id: number): Notification {
	const row = owned(ctx, userId, id);
	if (row.readAt) return present(ctx, row);
	const updated = ctx.db
		.update(notification)
		.set({ readAt: now() })
		.where(eq(notification.id, id))
		.returning()
		.get();
	return present(ctx, updated);
}

export function markAllRead(ctx: Ctx, userId: number): number {
	return ctx.db
		.update(notification)
		.set({ readAt: now() })
		.where(and(eq(notification.userId, userId), isNull(notification.readAt)))
		.returning({ id: notification.id })
		.all().length;
}

/** Remove from the inbox. Counts as read. */
export function dismiss(ctx: Ctx, userId: number, id: number): Notification {
	const row = owned(ctx, userId, id);
	const at = now();
	const updated = ctx.db
		.update(notification)
		.set({ dismissedAt: at, readAt: row.readAt ?? at })
		.where(eq(notification.id, id))
		.returning()
		.get();
	return present(ctx, updated);
}
