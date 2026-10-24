/**
 * Projects: the scope of requirements, risks, issues, procedures, executions and datasets.
 * Archived is terminal. A project that records reference is never deleted (there is no delete).
 */
import { OpalError, type Project, type ProjectRef, notFound, now } from '@opal/shared';
import { and, asc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { project } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

type Row = typeof project.$inferSelect;

const out = (r: Row): Project => ({
	id: r.id,
	code: r.code,
	name: r.name,
	description: r.description,
	state: r.state,
	archivedAt: r.archivedAt,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt
});

export function projectRow(db: Db, id: number): Row {
	const r = db.select().from(project).where(eq(project.id, id)).get();
	if (!r) throw notFound('Project');
	return r;
}

export const getProject = (ctx: Pick<Ctx, 'db'>, id: number): Project => out(projectRow(ctx.db, id));

/**
 * The project a new scoped record may join: it must exist and be active.
 * Every create operation of a scoped area calls this.
 */
export function requireActiveProject(db: Db, id: number): Row {
	const r = projectRow(db, id);
	if (r.state === 'archived') {
		throw new OpalError(409, 'project_archived', `Project ${r.code} is archived and takes no new records`);
	}
	return r;
}

export function listProjects(
	ctx: Ctx,
	input: { cursor?: string; limit: number; state?: 'active' | 'archived'; search?: string }
) {
	const after = input.cursor ? Number(input.cursor) : 0;
	const term = input.search ? `%${input.search}%` : null;
	const rows = ctx.db
		.select()
		.from(project)
		.where(
			and(
				input.state ? eq(project.state, input.state) : undefined,
				term ? or(like(project.name, term), like(project.code, term)) : undefined
			)
		)
		.orderBy(asc(project.code))
		.limit(input.limit + 1)
		.offset(after)
		.all();
	const more = rows.length > input.limit;
	const items = rows.slice(0, input.limit).map(out);
	return { items, next: more ? String(after + input.limit) : null };
}

function checkCodeFree(db: Db, code: string, exceptId?: number) {
	const clash = db
		.select({ id: project.id })
		.from(project)
		.where(and(sql`lower(${project.code}) = ${code.toLowerCase()}`, exceptId ? ne(project.id, exceptId) : undefined))
		.get();
	if (clash) throw new OpalError(400, 'duplicate', `Project code '${code}' already exists`);
}

export function createProject(
	ctx: Ctx,
	input: { code: string; name: string; description?: string | null }
): Project {
	checkCodeFree(ctx.db, input.code);
	const r = insert(ctx, project, {
		code: input.code.toUpperCase(),
		name: input.name,
		description: input.description || null,
		state: 'active'
	});
	return getProject(ctx, r.id);
}

export function updateProject(
	ctx: Ctx,
	input: { id: number; code?: string; name?: string; description?: string | null }
): Project {
	const cur = projectRow(ctx.db, input.id);
	if (cur.state === 'archived') {
		throw new OpalError(409, 'project_archived', `Project ${cur.code} is archived and cannot change`);
	}
	const patch: Partial<typeof project.$inferInsert> = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.code !== undefined && input.code.toUpperCase() !== cur.code) {
		checkCodeFree(ctx.db, input.code, input.id);
		patch.code = input.code.toUpperCase();
	}
	if (input.description !== undefined) patch.description = input.description || null;
	if (Object.keys(patch).length) update(ctx, project, input.id, patch);
	return getProject(ctx, input.id);
}

export function archiveProject(ctx: Ctx, id: number): Project {
	const cur = projectRow(ctx.db, id);
	if (cur.state === 'archived') throw new OpalError(409, 'project_archived', `Project ${cur.code} is already archived`);
	update(ctx, project, id, { state: 'archived', archivedAt: now() });
	return getProject(ctx, id);
}

/** Code and name of many projects at once, for the lists and details of scoped records. */
export function projectRefs(db: Db, ids: number[]): Map<number, ProjectRef> {
	const want = [...new Set(ids)];
	if (!want.length) return new Map();
	return new Map(
		db
			.select({ id: project.id, code: project.code, name: project.name })
			.from(project)
			.where(inArray(project.id, want))
			.all()
			.map((p) => [p.id, p] as const)
	);
}
