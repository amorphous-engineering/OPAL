/** Workcenters: where steps are performed. Deactivated, never deleted. */
import { OpalError, type Workcenter, type WorkcenterWork, notFound } from '@opal/shared';
import { and, eq, like, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { workcenter } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

/**
 * Procedures and executions own the data behind "steps that default here" and "work queued
 * here". Their areas register a provider; until then both are empty.
 */
export interface WorkcenterWorkProvider {
	defaultStepCounts(db: Db): Map<number, number>;
	queuedCounts(db: Db): Map<number, number>;
	work(db: Db, workcenterId: number): Partial<WorkcenterWork>;
}
const providers: WorkcenterWorkProvider[] = [];
export const registerWorkcenterWork = (p: WorkcenterWorkProvider) => void providers.push(p);

type Row = typeof workcenter.$inferSelect;

function withCounts(db: Db, rows: Row[]): Workcenter[] {
	const defaults = providers.map((p) => p.defaultStepCounts(db));
	const queued = providers.map((p) => p.queuedCounts(db));
	return rows.map((w) => ({
		id: w.id,
		name: w.name,
		code: w.code,
		description: w.description,
		location: w.location,
		isActive: w.isActive,
		defaultStepCount: defaults.reduce((n, m) => n + (m.get(w.id) ?? 0), 0),
		queuedStepCount: queued.reduce((n, m) => n + (m.get(w.id) ?? 0), 0)
	}));
}

function row(db: Db, id: number): Row {
	const r = db.select().from(workcenter).where(eq(workcenter.id, id)).get();
	if (!r) throw notFound('Workcenter');
	return r;
}

export function listWorkcenters(ctx: Ctx, input: { activeOnly?: boolean; search?: string }): Workcenter[] {
	const term = input.search ? `%${input.search}%` : null;
	const rows = ctx.db
		.select()
		.from(workcenter)
		.where(
			and(
				input.activeOnly === false ? undefined : eq(workcenter.isActive, true),
				term ? or(like(workcenter.name, term), like(workcenter.code, term)) : undefined
			)
		)
		.orderBy(workcenter.code)
		.all();
	return withCounts(ctx.db, rows);
}

export const getWorkcenter = (ctx: Ctx, id: number): Workcenter => withCounts(ctx.db, [row(ctx.db, id)])[0]!;

export function workcenterWork(ctx: Ctx, id: number): WorkcenterWork {
	row(ctx.db, id);
	const out: WorkcenterWork = { defaultSteps: [], queue: [] };
	for (const p of providers) {
		const w = p.work(ctx.db, id);
		out.defaultSteps.push(...(w.defaultSteps ?? []));
		out.queue.push(...(w.queue ?? []));
	}
	return out;
}

function checkCodeFree(db: Db, code: string, exceptId?: number) {
	const clash = db
		.select({ id: workcenter.id })
		.from(workcenter)
		.where(and(sql`lower(${workcenter.code}) = ${code.toLowerCase()}`, exceptId ? ne(workcenter.id, exceptId) : undefined))
		.get();
	if (clash) throw new OpalError(400, 'duplicate', `Workcenter code '${code}' already exists`);
}

export function createWorkcenter(
	ctx: Ctx,
	input: { name: string; code: string; description?: string | null; location?: string | null; isActive: boolean }
): Workcenter {
	checkCodeFree(ctx.db, input.code);
	const r = insert(ctx, workcenter, {
		name: input.name,
		code: input.code.toUpperCase(),
		description: input.description ?? null,
		location: input.location ?? null,
		isActive: input.isActive
	});
	return getWorkcenter(ctx, r.id);
}

export function updateWorkcenter(
	ctx: Ctx,
	input: { id: number; name?: string; code?: string; description?: string | null; location?: string | null; isActive?: boolean }
): Workcenter {
	const cur = row(ctx.db, input.id);
	const patch: Partial<typeof workcenter.$inferInsert> = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.code !== undefined && input.code.toUpperCase() !== cur.code) {
		checkCodeFree(ctx.db, input.code, input.id);
		patch.code = input.code.toUpperCase();
	}
	if (input.description !== undefined) patch.description = input.description;
	if (input.location !== undefined) patch.location = input.location;
	if (input.isActive !== undefined) patch.isActive = input.isActive;
	if (Object.keys(patch).length) update(ctx, workcenter, input.id, patch);
	return getWorkcenter(ctx, input.id);
}

export function deactivateWorkcenter(ctx: Ctx, id: number): void {
	row(ctx.db, id);
	update(ctx, workcenter, id, { isActive: false });
}
