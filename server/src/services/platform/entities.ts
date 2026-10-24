/**
 * Entity registry: how a table is named for people and where its page is.
 *
 * An audit row points at a record by table name and id. Database ids never
 * render, so each area registers its tables once:
 *
 *   registerEntity(issue, { label: 'Issue', ref: (r) => ({ label: r.issueNumber, href: `/issues/${r.id}` }) });
 *   registerEntity(issueComment, { label: 'Issue comment', parent: { table: issue, fk: 'issueId' } });
 *
 * A child with `parent` resolves to the parent's reference. A table with
 * neither renders as its label alone. Unregistered tables fall back to a
 * title-cased table name.
 */
import { getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';

type AnyTable = SQLiteTable & { id: any; $inferSelect: any };

export interface EntityRef {
	label: string | null;
	href: string | null;
}
export const NO_REF: EntityRef = { label: null, href: null };

export interface EntityInfo<T extends AnyTable = AnyTable> {
	/** Display name of the entity type: "Part", "PO line". */
	label: string;
	table?: T;
	/** The record's own name and page, from its row (or, once deleted, its last snapshot). */
	ref?: (row: T['$inferSelect']) => EntityRef | null;
	/** A child row resolves to the parent record it lives on. */
	parent?: { table: AnyTable; fk: string };
}

const registry = new Map<string, EntityInfo>();

export function registerEntity<T extends AnyTable>(table: T, info: EntityInfo<T>): void {
	registry.set(getTableName(table), { ...info, table } as unknown as EntityInfo);
}

/** Register a label for a table name when the table object is not at hand. */
export function registerEntityLabel(tableName: string, label: string): void {
	if (!registry.has(tableName)) registry.set(tableName, { label });
}

export function entityLabel(tableName: string): string {
	const known = registry.get(tableName)?.label;
	if (known) return known;
	const words = tableName.replace(/_/g, ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function row(db: Db, table: AnyTable, id: number): unknown {
	return db.select().from(table).where(eq(table.id, id)).get();
}

/**
 * Resolve one record to its name and page. `snapshot` stands in for a row
 * that no longer exists (a deleted draft): its last values live in the audit log.
 */
export function resolveRef(db: Db, tableName: string, id: number, snapshot?: unknown): EntityRef {
	const info = registry.get(tableName);
	if (!info?.table) return NO_REF;
	const data = row(db, info.table, id) ?? snapshot;
	if (!data) return NO_REF;
	if (info.ref) return info.ref(data) ?? NO_REF;
	if (info.parent) {
		const pid = (data as Record<string, unknown>)[info.parent.fk];
		return typeof pid === 'number'
			? resolveRef(db, getTableName(info.parent.table), pid)
			: NO_REF;
	}
	return NO_REF;
}
