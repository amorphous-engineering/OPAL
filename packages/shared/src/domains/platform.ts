/**
 * Contracts for the platform area: attachments, events, presence,
 * notifications, audit log, undo and global search.
 *
 * Two kinds of traffic are not JSON operations and live in plain Hono routes
 * (server/src/services/platform/files.ts, `mountFiles`):
 *   POST /api/attachments               multipart upload
 *   GET  /api/attachments/:id/download  binary download
 *   GET  /api/blobs/:sha256             binary download by content hash
 *   GET  /api/events/stream             server-sent events
 */
import { z } from 'zod';
import { op, zEmpty, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zTimestamp } from '../time.ts';

// ---------------------------------------------------------------- attachments

/** What a file is for. Null on the row means unscoped. */
export const ATTACHMENT_KINDS = [
	'inline',
	'reference',
	'closeout',
	'capture',
	'step_image',
	'quote',
	'invoice',
	'packing_slip'
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const zAttachment = z.object({
	id: z.number().int(),
	sha256: z.string(),
	filename: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().int(),
	/** Table name of the owning record: `issue`, `purchase`, `step_execution`, ... */
	ownerType: z.string(),
	ownerId: z.number().int(),
	kind: z.enum(ATTACHMENT_KINDS).nullable(),
	note: z.string().nullable(),
	uploadedById: z.number().int().nullable(),
	uploadedByName: z.string().nullable(),
	createdAt: zTimestamp,
	/** `/api/attachments/:id/download` */
	href: z.string()
});
export type Attachment = z.infer<typeof zAttachment>;

// -------------------------------------------------------------------- events

/** Event types the server publishes. `publish()` takes any string; these are the known ones. */
export const EVENT_TYPES = [
	'heartbeat',
	'cursor_moved',
	'step_completed',
	'instance_started',
	'instance_completed',
	'issue_dispositioned',
	'user_joined',
	'user_left',
	'user_activity',
	'notification',
	'presence'
] as const;

/** One SSE frame: `data: <json>`. */
export const zEvent = z.object({
	type: z.string(),
	data: z.record(z.string(), z.unknown()),
	timestamp: zTimestamp
});
export type OpalEvent = z.infer<typeof zEvent>;

// ------------------------------------------------------------------ presence

export const zPresence = z.object({
	userId: z.number().int(),
	name: z.string(),
	/** Free text the client sends with its heartbeat: the page or task the person is on. */
	activity: z.string().nullable(),
	lastSeenAt: zTimestamp
});
export type Presence = z.infer<typeof zPresence>;

// ------------------------------------------------------------- notifications

export const NOTIFICATION_KINDS = [
	'issue_assigned',
	'issue_dispositioned',
	'issue_commented',
	'issue_closed',
	'execution_blocked',
	'execution_unblocked'
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CATEGORIES = ['issues', 'executions'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_SORTS = ['recent', 'priority', 'unread'] as const;
export const NOTIFICATION_STATES = ['unread', 'read'] as const;

/** The inbox filters on category; it is derived from the kind, never stored. */
export function categoryForKind(kind: string): NotificationCategory {
	return kind.startsWith('execution_') ? 'executions' : 'issues';
}

export const zNotification = z.object({
	id: z.number().int(),
	kind: z.enum(NOTIFICATION_KINDS),
	category: z.enum(NOTIFICATION_CATEGORIES),
	priority: z.enum(NOTIFICATION_PRIORITIES),
	title: z.string(),
	body: z.string().nullable(),
	href: z.string(),
	subjectType: z.string(),
	subjectId: z.number().int(),
	createdAt: zTimestamp,
	readAt: zTimestamp.nullable(),
	actorName: z.string().nullable()
});
export type Notification = z.infer<typeof zNotification>;

// --------------------------------------------------------------------- audit

export const AUDIT_ACTIONS = ['create', 'update', 'delete'] as const;

export const zFieldChange = z.object({
	field: z.string(),
	old: z.unknown().nullable(),
	new: z.unknown().nullable(),
	/** Readable stand-in for a foreign key (user, part), when one resolves. */
	oldLabel: z.string().nullable(),
	newLabel: z.string().nullable()
});
export type FieldChange = z.infer<typeof zFieldChange>;

export const zAuditEntry = z.object({
	id: z.number().int(),
	at: zTimestamp,
	action: z.enum(AUDIT_ACTIONS),
	/** Table name of the changed record. */
	entity: z.string(),
	entityLabel: z.string(),
	entityId: z.number().int(),
	/** The record's own name (part number, issue number, ...). Null when it has none or is gone. */
	recordLabel: z.string().nullable(),
	href: z.string().nullable(),
	op: z.string(),
	userId: z.number().int().nullable(),
	userName: z.string().nullable(),
	changes: z.array(zFieldChange)
});
export type AuditEntry = z.infer<typeof zAuditEntry>;

export const zAuditFacets = z.object({
	entities: z.array(z.object({ value: z.string(), label: z.string() })),
	users: z.array(z.object({ id: z.number().int(), name: z.string() }))
});
export type AuditFacets = z.infer<typeof zAuditFacets>;

// ---------------------------------------------------------------------- undo

export const zUndoPreview = z.object({
	auditId: z.number().int(),
	op: z.string(),
	summary: z.string(),
	at: zTimestamp,
	canUndo: z.boolean(),
	reason: z.string().nullable()
});
export type UndoPreview = z.infer<typeof zUndoPreview>;

// -------------------------------------------------------------------- search

export const zSearchHit = z.object({
	entityType: z.string(),
	id: z.number().int(),
	label: z.string(),
	sublabel: z.string().nullable(),
	href: z.string(),
	status: z.string().nullable()
});
export type SearchHit = z.infer<typeof zSearchHit>;

// --------------------------------------------------------------------- about

export const zAbout = z.object({
	version: z.string(),
	/** A development build (not a release). */
	isDev: z.boolean(),
	/** The live database file (the demo file while the demo is active). Shown in the status bar. */
	dbPath: z.string(),
	/**
	 * Every operation this server implements. The shell reads it to call
	 * another area's endpoint only when that area exists.
	 */
	operations: z.array(z.object({ name: z.string(), method: z.string(), path: z.string() }))
});
export type About = z.infer<typeof zAbout>;

export const HEALTH_STATES = ['ok', 'degraded', 'down'] as const;
export const zHealth = z.object({
	/** ok: every check passed. degraded: the server answers but a check failed. down: the database failed. */
	status: z.enum(HEALTH_STATES),
	version: z.string(),
	checks: z.array(
		z.object({
			name: z.enum(['database', 'storage', 'disk']),
			ok: z.boolean(),
			/** Why the check failed, or a reading (free space). Never a file path: the route is public. */
			detail: z.string().nullable()
		})
	)
});
export type Health = z.infer<typeof zHealth>;

// ----------------------------------------------------------------- contracts

export const platform = {
	health: op({
		name: 'platform.health',
		method: 'GET',
		path: '/health',
		summary:
			'Server health: database readable and writable, file storage writable, free disk space. Always 200; `status` carries the state.',
		input: zEmpty,
		output: zHealth,
		access: 'public',
		mcp: false
	}),
	about: op({
		name: 'platform.about',
		method: 'GET',
		path: '/about',
		summary: 'Server version and the list of implemented operations.',
		input: zEmpty,
		output: zAbout,
		access: 'signed-in',
		mcp: false
	}),
	attachments: {
		list: op({
			name: 'attachments.list',
			method: 'GET',
			path: '/attachments',
			summary: 'List the files attached to one record, newest first.',
			input: z.object({
				ownerType: z.string(),
				ownerId: zId,
				kind: z.enum(ATTACHMENT_KINDS).optional()
			}),
			output: z.array(zAttachment),
			access: 'signed-in',
			mcp: true
		}),
		update: op({
			name: 'attachments.update',
			method: 'PATCH',
			path: '/attachments/:id',
			summary: 'Change the kind or the note of an attachment.',
			input: z.object({
				id: zId,
				kind: z.enum(ATTACHMENT_KINDS).nullable().optional(),
				note: z.string().max(2000).nullable().optional()
			}),
			output: zAttachment,
			access: 'signed-in',
			mcp: true
		}),
		delete: op({
			name: 'attachments.delete',
			method: 'DELETE',
			path: '/attachments/:id',
			summary: 'Remove an attachment link. The stored file stays while anything references it.',
			input: z.object({ id: zId }),
			output: zOk,
			access: 'signed-in',
			mcp: true
		})
	},
	events: {
		stats: op({
			name: 'events.stats',
			method: 'GET',
			path: '/events/stats',
			summary: 'Number of connected event-stream clients.',
			input: zEmpty,
			output: z.object({ connectedClients: z.number().int() }),
			access: 'signed-in',
			mcp: false
		})
	},
	presence: {
		heartbeat: op({
			name: 'presence.heartbeat',
			method: 'POST',
			path: '/presence/heartbeat',
			summary: 'Record that the caller is online, with what they are doing. Returns who is online.',
			input: z.object({ activity: z.string().max(200).nullable().optional() }),
			output: z.object({ online: z.array(zPresence) }),
			access: 'signed-in',
			mcp: false
		}),
		list: op({
			name: 'presence.list',
			method: 'GET',
			path: '/presence',
			summary: 'Who is online now and what each person is doing.',
			input: zEmpty,
			output: z.object({ online: z.array(zPresence) }),
			access: 'signed-in',
			mcp: true
		})
	},
	notifications: {
		list: op({
			name: 'notifications.list',
			method: 'GET',
			path: '/notifications',
			summary: "The caller's undismissed notifications. Newest first unless sorted otherwise.",
			input: zPageInput.extend({
				state: z.enum(NOTIFICATION_STATES).optional(),
				category: z.enum(NOTIFICATION_CATEGORIES).optional(),
				sort: z.enum(NOTIFICATION_SORTS).default('recent')
			}),
			output: zPage(zNotification).extend({ total: z.number().int(), unreadCount: z.number().int() }),
			access: 'signed-in',
			mcp: true
		}),
		unreadCount: op({
			name: 'notifications.unreadCount',
			method: 'GET',
			path: '/notifications/unread-count',
			summary: 'Number of unread notifications. What the bell shows.',
			input: zEmpty,
			output: z.object({ unreadCount: z.number().int() }),
			access: 'signed-in',
			mcp: true
		}),
		readAll: op({
			name: 'notifications.readAll',
			method: 'POST',
			path: '/notifications/read-all',
			summary: 'Mark every unread notification read.',
			input: zEmpty,
			output: z.object({ markedRead: z.number().int() }),
			access: 'signed-in',
			mcp: true
		}),
		read: op({
			name: 'notifications.read',
			method: 'POST',
			path: '/notifications/:id/read',
			summary: 'Mark one notification read.',
			input: z.object({ id: zId }),
			output: zNotification,
			access: 'signed-in',
			mcp: true
		}),
		dismiss: op({
			name: 'notifications.dismiss',
			method: 'POST',
			path: '/notifications/:id/dismiss',
			summary: 'Remove a notification from the inbox. It counts as read.',
			input: z.object({ id: zId }),
			output: zNotification,
			access: 'signed-in',
			mcp: true
		})
	},
	audit: {
		list: op({
			name: 'audit.list',
			method: 'GET',
			path: '/audit',
			summary: 'Audit entries, newest first. Filter by record, action, user and date.',
			input: zPageInput.extend({
				entity: z.string().optional(),
				entityId: zId.optional(),
				action: z.enum(AUDIT_ACTIONS).optional(),
				userId: zId.optional(),
				/** YYYY-MM-DD or an ISO 8601 instant, inclusive. */
				from: z.string().optional(),
				/** YYYY-MM-DD (the whole day) or an ISO 8601 instant, exclusive. */
				to: z.string().optional(),
				/** Page by position instead of by cursor (page-number UIs). */
				offset: z.coerce.number().int().min(0).optional()
			}),
			output: zPage(zAuditEntry).extend({ total: z.number().int() }),
			access: 'signed-in',
			mcp: true
		}),
		facets: op({
			name: 'audit.facets',
			method: 'GET',
			path: '/audit/facets',
			summary: 'Filter options: entity types present in the log and users who made entries.',
			input: zEmpty,
			output: zAuditFacets,
			access: 'signed-in',
			mcp: false
		}),
		history: op({
			name: 'audit.history',
			method: 'GET',
			path: '/audit/history/:entity/:entityId',
			summary: 'Every change to one record, newest first.',
			input: zPageInput.extend({ entity: z.string(), entityId: zId }),
			output: zPage(zAuditEntry),
			access: 'signed-in',
			mcp: true
		})
	},
	undo: {
		preview: op({
			name: 'undo.preview',
			method: 'GET',
			path: '/undo/last',
			summary: "What 'undo last action' would reverse for the caller. 404 when nothing is recent.",
			input: zEmpty,
			output: zUndoPreview,
			access: 'signed-in',
			mcp: true
		}),
		last: op({
			name: 'undo.last',
			method: 'POST',
			path: '/undo/last',
			summary: "Reverse the caller's most recent action, if its operation is reversible.",
			input: zEmpty,
			output: z.object({ summary: z.string() }),
			access: 'signed-in',
			mcp: true
		})
	},
	search: {
		query: op({
			name: 'search.query',
			method: 'GET',
			path: '/search',
			summary: 'Search every area at once. Up to `limit` hits per entity type.',
			input: z.object({
				q: z.string().min(1),
				limit: z.coerce.number().int().min(1).max(20).default(5)
			}),
			output: z.array(zSearchHit),
			access: 'signed-in',
			mcp: true
		})
	}
};
