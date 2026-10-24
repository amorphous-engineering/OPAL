/**
 * Reading the audit log. Rows are written by the audited helpers in write.ts;
 * this module turns them into entries a person can read: names instead of
 * ids, field changes instead of two JSON blobs.
 */
import {
	formatQty,
	type Qty,
	type AuditEntry,
	type FieldChange,
	OpalError,
	type AuditFacets
} from '@opal/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, lt, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { auditLog, part, user } from '../../db/schema/index.ts';
import { entityLabel, registerEntity, resolveRef } from './entities.ts';

type Row = typeof auditLog.$inferSelect;

// Built-in registrations for the tables that belong to no single area.
registerEntity(user, { label: 'User', ref: (r) => ({ label: r.name, href: `/users/${r.id}` }) });
registerEntity(part, {
	label: 'Part',
	ref: (r) => ({ label: r.internalPn || r.name, href: `/parts/${r.id}` })
});

/** Columns that change on every write and say nothing about intent. */
const NOISE = new Set(['updatedAt']);
const isUserField = (f: string) =>
	f === 'userId' || f === 'assignedToId' || f === 'ownerId' || f === 'actorId' || f.endsWith('ById');

/** Columns stored as integers scaled by QTY_SCALE; the log shows them as decimals. */ // added by QA
const SCALED = new Set(['reorderPoint', 'quantity', 'qty', 'qtyOrdered', 'unitCost', 'amount']);
const scaled = (k: string, v: unknown) =>
	SCALED.has(k) && typeof v === 'number' ? formatQty(v as Qty) : v;

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** (field, old, new) triples. Updates keep the fields that changed; creates and deletes list populated fields. */
function rawChanges(r: Row): [string, unknown, unknown][] {
	const before = obj(r.before);
	const after = obj(r.after);
	if (r.action === 'update') {
		return Object.keys(after)
			.filter((k) => !NOISE.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
			.map((k) => [k, scaled(k, before[k] ?? null), scaled(k, after[k] ?? null)]);
	}
	if (r.action === 'create') {
		return Object.entries(after)
			.filter(([k, v]) => v !== null && k !== 'id')
			.map(([k, v]) => [k, null, scaled(k, v)]);
	}
	return Object.entries(before)
		.filter(([k, v]) => v !== null && k !== 'id')
		.map(([k, v]) => [k, scaled(k, v), null]);
}

/** Resolve audit rows to readable entries (also used by the overview activity feed). */
export function auditEntries(db: Db, rows: Row[]): AuditEntry[] {
	const raw = new Map(rows.map((r) => [r.id, rawChanges(r)]));
	const userIds = new Set(rows.map((r) => r.actorUserId).filter((x): x is number => x != null));
	const partIds = new Set<number>();
	for (const triples of raw.values()) {
		for (const [field, a, b] of triples) {
			for (const v of [a, b]) {
				if (typeof v !== 'number') continue;
				if (isUserField(field)) userIds.add(v);
				else if (field === 'partId') partIds.add(v);
			}
		}
	}
	const users = new Map(
		userIds.size
			? db
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(inArray(user.id, [...userIds]))
					.all()
					.map((u) => [u.id, u.name] as const)
			: []
	);
	const parts = new Map(
		partIds.size
			? db
					.select({ id: part.id, pn: part.internalPn })
					.from(part)
					.where(inArray(part.id, [...partIds]))
					.all()
					.map((p) => [p.id, p.pn] as const)
			: []
	);
	const labelFor = (field: string, v: unknown): string | null => {
		if (typeof v !== 'number') return null;
		if (isUserField(field)) return users.get(v) ?? null;
		if (field === 'partId') return parts.get(v) ?? null;
		return null;
	};
	const refs = new Map<string, ReturnType<typeof resolveRef>>();
	return rows.map((r) => {
		const key = `${r.entity}:${r.entityId}`;
		let ref = refs.get(key);
		if (!ref) {
			ref = resolveRef(db, r.entity, r.entityId, r.after ?? r.before);
			refs.set(key, ref);
		}
		const changes: FieldChange[] = raw.get(r.id)!.map(([field, o, n]) => ({
			field,
			old: o ?? null,
			new: n ?? null,
			oldLabel: labelFor(field, o),
			newLabel: labelFor(field, n)
		}));
		return {
			id: r.id,
			at: r.at,
			action: r.action as AuditEntry['action'],
			entity: r.entity,
			entityLabel: entityLabel(r.entity),
			entityId: r.entityId,
			recordLabel: ref.label,
			href: ref.href,
			op: r.op,
			userId: r.actorUserId,
			userName: r.actorUserId == null ? null : (users.get(r.actorUserId) ?? null),
			changes
		};
	});
}

/** A YYYY-MM-DD day or an ISO 8601 instant, as a UTC instant. A bare day as upper bound covers the whole day. */
function bound(value: string | undefined, name: string, end: boolean): string | undefined {
	if (!value) return undefined;
	let ms: number;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) ms = Date.parse(`${value}T00:00:00.000Z`) + (end ? 86_400_000 : 0);
	else ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new OpalError(422, 'invalid_input', 'Invalid input', { [name]: 'must be ISO 8601' });
	}
	return new Date(ms).toISOString();
}

export interface AuditFilter {
	entity?: string;
	entityId?: number;
	action?: 'create' | 'update' | 'delete';
	userId?: number;
	from?: string;
	to?: string;
}

function where(f: AuditFilter): SQL | undefined {
	const from = bound(f.from, 'from', false);
	const to = bound(f.to, 'to', true);
	return and(
		f.entity ? eq(auditLog.entity, f.entity) : undefined,
		f.entityId !== undefined ? eq(auditLog.entityId, f.entityId) : undefined,
		f.action ? eq(auditLog.action, f.action) : undefined,
		f.userId !== undefined ? eq(auditLog.actorUserId, f.userId) : undefined,
		from ? gte(auditLog.at, from) : undefined,
		to ? lt(auditLog.at, to) : undefined
	);
}

/** Newest first. Page by `cursor` (an audit id) or by `offset`. */
export function list(ctx: Ctx, input: AuditFilter & { cursor?: string; limit: number; offset?: number }) {
	const base = where(input);
	const total = ctx.db.select({ n: count() }).from(auditLog).where(base).get()?.n ?? 0;
	const rows = ctx.db
		.select()
		.from(auditLog)
		.where(and(base, input.cursor ? lt(auditLog.id, Number(input.cursor)) : undefined))
		.orderBy(desc(auditLog.id))
		.limit(input.limit + 1)
		.offset(input.offset ?? 0)
		.all();
	const page = rows.slice(0, input.limit);
	return {
		items: auditEntries(ctx.db, page),
		next: rows.length > input.limit ? String(page.at(-1)!.id) : null,
		total
	};
}

/** Every change to one record, newest first. */
export function history(ctx: Ctx, entity: string, entityId: number, input: { cursor?: string; limit: number }) {
	const { items, next } = list(ctx, { ...input, entity, entityId });
	return { items, next };
}

/** Filter options: entity types present in the log, and users who made entries. */
export function facets(ctx: Ctx): AuditFacets {
	const entities = ctx.db.selectDistinct({ e: auditLog.entity }).from(auditLog).all();
	const users = ctx.db
		.selectDistinct({ id: user.id, name: user.name })
		.from(auditLog)
		.innerJoin(user, eq(user.id, auditLog.actorUserId))
		.where(isNotNull(auditLog.actorUserId))
		.orderBy(user.name)
		.all();
	return {
		entities: entities
			.map((r) => ({ value: r.e, label: entityLabel(r.e) }))
			.sort((a, b) => a.label.localeCompare(b.label)),
		users
	};
}
