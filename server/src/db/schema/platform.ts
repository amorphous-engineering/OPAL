/** Tables for the platform area: stored files, attachments and notifications. */
import {
	ATTACHMENT_KINDS,
	NOTIFICATION_KINDS,
	NOTIFICATION_PRIORITIES
} from '@opal/shared';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { auditLog, user } from './core.ts';
import { createdAt, id, oneOf } from './helpers.ts';

/**
 * One row per stored file content. The file is `blobs/<sha256>` in the data
 * folder. Rows are never updated and never deleted by a link delete: a
 * published snapshot may still reference the hash.
 */
export const blob = sqliteTable('blob', {
	sha256: text('sha256').primaryKey(),
	sizeBytes: integer('size_bytes').notNull(),
	mimeType: text('mime_type').notNull(),
	createdAt: createdAt()
});

/**
 * A blob linked to exactly one owner record.
 *
 * Owner = (owner_type, owner_id): the owner's table name and its id. The pair
 * is checked by the service (the owner table must exist and hold the id), not
 * by a foreign key, because the owner tables belong to other areas. To get a
 * real FK later, an area adds a nullable `<owner>_id` column here (an additive
 * change) and a CHECK that exactly one of the owner columns is set.
 * An owner that is hard-deleted calls `detachAll` in the same operation.
 */
export const attachment = sqliteTable(
	'attachment',
	{
		id: id(),
		blobSha256: text('blob_sha256')
			.notNull()
			.references(() => blob.sha256),
		filename: text('filename').notNull(),
		ownerType: text('owner_type').notNull(),
		ownerId: integer('owner_id').notNull(),
		kind: text('kind', { enum: ATTACHMENT_KINDS }),
		note: text('note'),
		uploadedById: integer('uploaded_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [
		index('attachment_owner_idx').on(t.ownerType, t.ownerId),
		index('attachment_blob_idx').on(t.blobSha256),
		oneOf('attachment_kind_check', 'kind', ATTACHMENT_KINDS)
	]
);

/**
 * One event addressed to one person. A pointer, never a copy: `title` and
 * `body` are the wording when it fired, `href` leads to the live record.
 * Written directly (no audit row): it is inbox bookkeeping, not business data.
 */
export const notification = sqliteTable(
	'notification',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		actorId: integer('actor_id').references(() => user.id, { onDelete: 'set null' }),
		kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
		priority: text('priority', { enum: NOTIFICATION_PRIORITIES }).notNull().default('normal'),
		title: text('title').notNull(),
		body: text('body'),
		href: text('href').notNull(),
		subjectType: text('subject_type').notNull(),
		subjectId: integer('subject_id').notNull(),
		createdAt: createdAt(),
		readAt: text('read_at'),
		dismissedAt: text('dismissed_at')
	},
	(t) => [
		index('notification_user_created_idx').on(t.userId, t.createdAt),
		oneOf('notification_kind_check', 'kind', NOTIFICATION_KINDS),
		oneOf('notification_priority_check', 'priority', NOTIFICATION_PRIORITIES)
	]
);

/**
 * Audit rows that an undo reversed. "Undo last action" skips them, so a second
 * undo reaches the action before. Bookkeeping, written directly.
 */
export const undoMark = sqliteTable('undo_mark', {
	auditId: integer('audit_id')
		.primaryKey()
		.references(() => auditLog.id, { onDelete: 'cascade' }),
	createdAt: createdAt()
});
