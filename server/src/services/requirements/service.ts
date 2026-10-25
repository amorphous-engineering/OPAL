/** Requirement business rules. Handlers in ops/requirements.ts only call these. */
import {
	OpalError,
	type Requirement,
	type RequirementCatalogResult,
	type RequirementPartRequirement as PartLink,
	type RequirementRedline,
	conflict,
	notFound,
	now,
	type zRequirementCreate,
	type zRequirementLintInput,
	type zRequirementUpdate
} from '@opal/shared';
import { and, asc, count, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { actorUserId, type Ctx } from '../../context.ts';
import {
	baselineEvent,
	baselineEventItem,
	part,
	partRequirement,
	requirement,
	user
} from '../../db/schema/index.ts';
import { insert, remove, update as writeUpdate } from '../../write.ts';
import { nextDesignator } from '../designators.ts';
import { getOrgSettings, numbersFor } from '../org/project.ts';
import { projectRefs, requireActiveProject } from '../org/projects.ts'; // added by projects
import {
	baselineRow,
	cancelRow,
	ensureMutable,
	isMutable,
	type RequirementRow,
	reviseRow
} from './lifecycle.ts';
import { lintRequirement } from './lint.ts';
import { readiness, readyRows } from './readiness.ts';
import { eventDetail, eventSummaries, queueItems, redline, summary, tree, dossier } from './views.ts';

const invalid = (field: string, message: string) =>
	new OpalError(422, 'invalid_input', message, { [field]: message });

// ---- loading and output ----

export function load(ctx: Pick<Ctx, 'db'>, id: number): RequirementRow {
	const row = ctx.db.select().from(requirement).where(eq(requirement.id, id)).get();
	if (!row) throw notFound('Requirement');
	return row;
}

function hydrate(ctx: Pick<Ctx, 'db'>, rows: RequirementRow[]): Requirement[] {
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const kids = new Map(
		ctx.db
			.select({ id: requirement.parentId, n: count() })
			.from(requirement)
			.where(inArray(requirement.parentId, ids))
			.groupBy(requirement.parentId)
			.all()
			.map((x) => [x.id, x.n])
	);
	const links = new Map(
		ctx.db
			.select({ id: partRequirement.requirementId, n: count() })
			.from(partRequirement)
			.where(inArray(partRequirement.requirementId, ids))
			.groupBy(partRequirement.requirementId)
			.all()
			.map((x) => [x.id, x.n])
	);
	const projects = projectRefs(ctx.db, rows.map((r) => r.projectId)); // added by projects
	return rows.map((r) => ({
		...r,
		projectCode: projects.get(r.projectId)?.code ?? '', // added by projects
		projectName: projects.get(r.projectId)?.name ?? '', // added by projects
		childrenCount: kids.get(r.id) ?? 0,
		allocationCount: links.get(r.id) ?? 0
	}));
}

const one = (ctx: Pick<Ctx, 'db'>, r: RequirementRow) => hydrate(ctx, [r])[0]!;

// ---- reads ----

export function list(
	ctx: Ctx,
	input: {
		cursor?: string;
		limit: number;
		projectId?: number; // added by projects
		state?: RequirementRow['lifecycleState'];
		category?: string;
		level?: number;
		parentId?: number;
		q?: string;
		includeSuperseded?: boolean;
	}
) {
	const term = input.q ? `%${input.q}%` : undefined;
	const where = and(
		input.includeSuperseded || input.state === 'superseded'
			? undefined
			: ne(requirement.lifecycleState, 'superseded'),
		input.projectId !== undefined ? eq(requirement.projectId, input.projectId) : undefined, // added by projects
		input.state ? eq(requirement.lifecycleState, input.state) : undefined,
		input.category ? eq(requirement.category, input.category) : undefined,
		input.level !== undefined ? eq(requirement.level, input.level) : undefined,
		input.parentId ? eq(requirement.parentId, input.parentId) : undefined,
		term
			? or(
					like(requirement.reqNumber, term),
					like(requirement.title, term),
					like(requirement.statement, term)
				)
			: undefined
	);
	const total = ctx.db.select({ n: count() }).from(requirement).where(where).get()!.n;
	// The cursor is the offset: the order is number then revision.
	const offset = Math.max(0, Number(input.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(requirement)
		.where(where)
		.orderBy(asc(requirement.reqNumber), asc(requirement.revision))
		.limit(input.limit + 1)
		.offset(offset)
		.all();
	return {
		items: hydrate(ctx, rows.slice(0, input.limit)),
		next: rows.length > input.limit ? String(offset + input.limit) : null,
		total
	};
}

export function get(ctx: Ctx, id: number): Requirement {
	return one(ctx, load(ctx, id));
}

/** The current revision of a number: the highest one that is not superseded. */
export function currentByNumber(ctx: Pick<Ctx, 'db'>, reqNumber: string): RequirementRow | undefined {
	return ctx.db
		.select()
		.from(requirement)
		.where(and(eq(requirement.reqNumber, reqNumber), ne(requirement.lifecycleState, 'superseded')))
		.orderBy(desc(requirement.revision))
		.get();
}

export function byNumber(ctx: Ctx, reqNumber: string): Requirement {
	const r = currentByNumber(ctx, numbersFor(ctx.db).canonical(reqNumber.trim().toUpperCase()));
	if (!r) throw notFound('Requirement');
	return one(ctx, r);
}

export const treeView = tree;
export const summaryView = summary;
export const dossierView = (ctx: Ctx, id: number) => dossier(ctx, load(ctx, id));
export const readinessView = (ctx: Ctx, id: number) => readiness(ctx, load(ctx, id));

export function queue(ctx: Ctx, projectId?: number) {
	const items = queueItems(ctx, projectId);
	return { count: items.length, ids: items.map((i) => i.id), items };
}

export function revisions(ctx: Ctx, id: number): Requirement[] {
	const r = load(ctx, id);
	return hydrate(
		ctx,
		ctx.db
			.select()
			.from(requirement)
			.where(eq(requirement.reqNumber, r.reqNumber))
			.orderBy(asc(requirement.revision))
			.all()
	);
}

export function redlineView(
	ctx: Ctx,
	id: number,
	revA: number | undefined,
	revB: number | undefined
): RequirementRedline {
	const r = load(ctx, id);
	const all = new Map(
		ctx.db
			.select()
			.from(requirement)
			.where(eq(requirement.reqNumber, r.reqNumber))
			.all()
			.map((x) => [x.revision, x])
	);
	const b = revB ?? r.revision;
	const a = revA ?? (r.supersedesId !== null ? load(ctx, r.supersedesId).revision : b);
	const old = all.get(a);
	const next = all.get(b);
	if (!old || !next) throw notFound('Revision');
	return redline(old, next);
}

export function lint(ctx: Ctx, input: z.output<typeof zRequirementLintInput>) {
	const findings = lintRequirement(input.statement, input);
	return {
		findings,
		wouldBlockBaseline: findings.some((f) => f.severity === 'block_baseline')
	};
}

// ---- writes ----

function checkUser(ctx: Pick<Ctx, 'db'>, field: string, id: number | null | undefined) {
	if (id != null && !ctx.db.select({ id: user.id }).from(user).where(eq(user.id, id)).get()) {
		throw invalid(field, `User ${id} not found`);
	}
}

function checkParent(ctx: Pick<Ctx, 'db'>, parentId: number, selfId?: number): RequirementRow {
	const parent = ctx.db.select().from(requirement).where(eq(requirement.id, parentId)).get();
	if (!parent) throw invalid('parentId', `Parent requirement ${parentId} not found`);
	if (selfId !== undefined) {
		if (parentId === selfId) throw invalid('parentId', 'A requirement cannot be its own parent');
		// Walk up from the proposed parent; meeting this row means a cycle.
		const seen = new Set<number>();
		let cursor: RequirementRow | undefined = parent;
		while (cursor && !seen.has(cursor.id)) {
			if (cursor.id === selfId) {
				throw invalid('parentId', 'A requirement cannot be parented under its own descendant');
			}
			seen.add(cursor.id);
			cursor =
				cursor.parentId !== null
					? ctx.db.select().from(requirement).where(eq(requirement.id, cursor.parentId)).get()
					: undefined;
		}
	}
	return parent;
}

/** Next REQ number that no row holds yet (an import can claim numbers the counter has not reached). */
function freeNumber(ctx: Ctx): string {
	for (;;) {
		const n = nextDesignator(ctx, 'REQ');
		if (!ctx.db.select({ id: requirement.id }).from(requirement).where(eq(requirement.reqNumber, n)).get()) {
			return n;
		}
	}
}

// added by projects: flow-down stays inside one project.
function checkSameProject(parent: RequirementRow, projectId: number) {
	if (parent.projectId !== projectId) {
		throw invalid('parentId', `Parent ${parent.reqNumber} belongs to another project`);
	}
}

/** Move a requirement, with its revisions, to another active project. Needs no flow-down links. */
function moveProject(ctx: Ctx, r: RequirementRow, projectId: number) {
	requireActiveProject(ctx.db, projectId);
	if (r.parentId !== null) {
		throw conflict('requirement_in_use', `${r.reqNumber} has a parent; detach it before changing the project`);
	}
	const sameNumber = ctx.db.select().from(requirement).where(eq(requirement.reqNumber, r.reqNumber)).all();
	const ids = sameNumber.map((x) => x.id);
	const kids = ctx.db
		.select({ n: count() })
		.from(requirement)
		.where(inArray(requirement.parentId, ids))
		.get()!.n;
	if (kids) {
		throw conflict('requirement_in_use', `${r.reqNumber} has child requirements; re-parent them before changing the project`);
	}
	for (const x of sameNumber) if (x.id !== r.id) writeUpdate(ctx, requirement, x.id, { projectId });
	writeUpdate(ctx, requirement, r.id, { projectId });
}

export function create(ctx: Ctx, input: z.output<typeof zRequirementCreate>): Requirement {
	requireActiveProject(ctx.db, input.projectId); // added by projects
	const parent = input.parentId ? checkParent(ctx, input.parentId) : null;
	if (parent) checkSameProject(parent, input.projectId); // added by projects
	checkUser(ctx, 'tbrOwnerId', input.tbrOwnerId);
	const row = insert(ctx, requirement, {
		reqNumber: freeNumber(ctx),
		projectId: input.projectId, // added by projects
		title: input.title,
		statement: input.statement,
		rationale: input.rationale ?? null,
		category: input.category ?? null,
		parentId: input.parentId ?? null,
		level: input.level ?? (parent ? parent.level + 1 : 0),
		verificationMethod: input.verificationMethod ?? null,
		tbd: input.tbd,
		tbr: input.tbr,
		tbrOwnerId: input.tbrOwnerId ?? null,
		tbrDue: input.tbrDue ?? null
	});
	return one(ctx, row);
}

const EDIT_KEYS = [
	'title',
	'statement',
	'rationale',
	'category',
	'parentId',
	'level',
	'verificationMethod',
	'tbd',
	'tbr',
	'tbrOwnerId',
	'tbrDue',
	'lifecycleState'
] as const;

export function updateRequirement(ctx: Ctx, input: z.output<typeof zRequirementUpdate>): Requirement {
	const r = load(ctx, input.id);
	ensureMutable(r);
	const moving = input.projectId !== undefined && input.projectId !== r.projectId; // added by projects
	if (moving) moveProject(ctx, r, input.projectId!); // added by projects
	const project = moving ? input.projectId! : r.projectId; // added by projects
	if (input.parentId) checkSameProject(checkParent(ctx, input.parentId, r.id), project); // added by projects
	checkUser(ctx, 'tbrOwnerId', input.tbrOwnerId);
	// Absent keys stay. An explicit null clears the nullable fields.
	const patch: Record<string, unknown> = {};
	for (const k of EDIT_KEYS) {
		if (k in input && input[k] !== undefined) patch[k] = input[k];
	}
	if (Object.keys(patch).length) patch.stale = false; // any edit is a fresh look
	const row = Object.keys(patch).length ? writeUpdate(ctx, requirement, r.id, patch) : load(ctx, r.id);
	return one(ctx, row);
}

/** Delete a stillborn draft: no children, no part links. Everything else is cancelled or revised. */
export function deleteRequirement(ctx: Ctx, id: number): { ok: true } {
	const r = load(ctx, id);
	if (!isMutable(r)) {
		throw conflict(
			'requirement_state',
			`${r.reqNumber} is ${r.lifecycleState}: cancel or revise it instead of deleting`
		);
	}
	const children = ctx.db.select({ n: count() }).from(requirement).where(eq(requirement.parentId, id)).get()!.n;
	if (children) {
		throw conflict('requirement_in_use', `Requirement has ${children} child requirement(s); re-parent them first`);
	}
	const links = ctx.db
		.select({ n: count() })
		.from(partRequirement)
		.where(eq(partRequirement.requirementId, id))
		.get()!.n;
	if (links) {
		throw conflict('requirement_in_use', `Requirement is allocated to ${links} part(s); unassign them first or cancel instead`);
	}
	remove(ctx, requirement, id);
	return { ok: true };
}

export function writeBaselineEvent(
	ctx: Ctx,
	rows: RequirementRow[],
	label?: string | null,
	note?: string | null
) {
	const projectIds = new Set(rows.map((r) => r.projectId)); // added by projects
	if (projectIds.size !== 1) {
		throw new OpalError(422, 'invalid_input', 'A baseline event covers one project', { ids: 'mixed projects' });
	}
	const event = insert(ctx, baselineEvent, {
		projectId: rows[0]!.projectId, // added by projects
		label: label ?? null,
		note: note ?? null,
		signedById: actorUserId(ctx.actor)
	});
	for (const r of rows) insert(ctx, baselineEventItem, { eventId: event.id, requirementId: r.id });
	return event;
}

export function baseline(ctx: Ctx, id: number): Requirement {
	const done = baselineRow(ctx, load(ctx, id));
	writeBaselineEvent(ctx, [done]);
	return one(ctx, done);
}

export function baselineBatch(
	ctx: Ctx,
	input: { ids: number[]; label?: string | null; note?: string | null }
) {
	const rows = [...new Set(input.ids)].map((id) => load(ctx, id));
	const offenders = rows
		.map((r) => ({
			r,
			failing: readiness(ctx, r)
				.checks.filter((c) => c.severity === 'hard' && !c.passed)
				.map((c) => c.key)
		}))
		.filter((o) => o.failing.length || !isMutable(o.r));
	if (offenders.length) {
		// Field keys are not output strings, so runOp does not show them at the display width.
		const codec = numbersFor(ctx.db);
		const fields = Object.fromEntries(
			offenders.map((o) => [
				codec.display(o.r.reqNumber),
				o.failing.length ? o.failing.join(', ') : `is ${o.r.lifecycleState}`
			])
		);
		throw new OpalError(409, 'batch_not_ready', 'Batch aborted: items are no longer ready', fields);
	}
	// All checked before any flip, so nothing half-commits.
	const done = rows.map((r) => baselineRow(ctx, r));
	const event = writeBaselineEvent(ctx, done, input.label, input.note);
	return {
		eventId: event.id,
		label: event.label,
		baselined: done.map((r) => ({ id: r.id, reqNumber: r.reqNumber, revision: r.revision }))
	};
}

export const revise = (ctx: Ctx, id: number) => one(ctx, reviseRow(ctx, load(ctx, id)));
export const cancel = (ctx: Ctx, id: number) => one(ctx, cancelRow(ctx, load(ctx, id)));

/** Clear staleness without an edit. Works on baselined rows: staleness is metadata. */
export function reaffirm(ctx: Ctx, id: number): Requirement {
	const r = load(ctx, id);
	if (!r.stale) throw conflict('not_stale', 'Requirement is not stale');
	return one(ctx, writeUpdate(ctx, requirement, id, { stale: false }));
}

export function baselines(ctx: Ctx, projectId?: number) {
	return eventSummaries(ctx, undefined, projectId);
}

export function baselineEventGet(ctx: Ctx, id: number) {
	const [s] = eventSummaries(ctx, id);
	if (!s) throw notFound('Baseline event');
	return eventDetail(ctx, s);
}

// ---- catalog import ----

/** Import the project's requirement catalog as level-0 drafts. Idempotent by number. */
export function importCatalog(ctx: Ctx, projectId: number): RequirementCatalogResult {
	requireActiveProject(ctx.db, projectId); // added by projects
	const catalog = getOrgSettings(ctx.db)?.requirements ?? [];
	if (!catalog.length) throw notFound('Requirement catalog');
	const result: RequirementCatalogResult = { created: [], skipped: [] };
	const codec = numbersFor(ctx.db);
	for (const entry of catalog) {
		// The catalog is typed by hand at any width; rows hold the stored form.
		const reqNumber = codec.canonical(entry.id.trim().toUpperCase());
		const exists = ctx.db
			.select({ id: requirement.id })
			.from(requirement)
			.where(eq(requirement.reqNumber, reqNumber))
			.get();
		if (exists) {
			result.skipped.push(reqNumber);
			continue;
		}
		insert(ctx, requirement, {
			reqNumber,
			projectId, // added by projects
			title: entry.title,
			statement: entry.description || entry.title,
			category: entry.category || null,
			level: 0
		});
		result.created.push(reqNumber);
	}
	return result;
}

/** Catalog entries (number and title) that no requirement row holds yet. */
export function catalogPending(ctx: Ctx) {
	const catalog = getOrgSettings(ctx.db)?.requirements ?? [];
	const codec = numbersFor(ctx.db);
	const held = new Set(
		ctx.db.select({ n: requirement.reqNumber }).from(requirement).all().map((x) => x.n)
	);
	return catalog
		.map((e) => ({ ...e, id: codec.canonical(e.id.trim().toUpperCase()) }))
		.filter((e) => !held.has(e.id))
		.map((e) => ({ id: 0, reqNumber: e.id, title: e.title }));
}

// ---- part links ----

function linkOut(ctx: Pick<Ctx, 'db'>, ids: number[]): PartLink[] {
	if (!ids.length) return [];
	const rows = ctx.db
		.select({ pr: partRequirement, req: requirement, vid: user.id, vname: user.name })
		.from(partRequirement)
		.innerJoin(requirement, eq(requirement.id, partRequirement.requirementId))
		.leftJoin(user, eq(user.id, partRequirement.verifiedById))
		.where(inArray(partRequirement.id, ids))
		.orderBy(asc(requirement.reqNumber), asc(partRequirement.id))
		.all();
	return rows.map(({ pr, req, vid, vname }) => ({
		id: pr.id,
		partId: pr.partId,
		requirementId: req.id,
		reqNumber: req.reqNumber,
		revision: req.revision,
		title: req.title,
		statement: req.statement,
		category: req.category,
		lifecycleState: req.lifecycleState,
		tbd: req.tbd,
		tbr: req.tbr,
		stale: req.stale,
		status: pr.status,
		notes: pr.notes,
		verifiedAt: pr.verifiedAt,
		verifiedBy: vid !== null && vname !== null ? { id: vid, name: vname } : null,
		createdAt: pr.createdAt,
		updatedAt: pr.updatedAt
	}));
}

function loadLink(ctx: Pick<Ctx, 'db'>, id: number) {
	const row = ctx.db.select().from(partRequirement).where(eq(partRequirement.id, id)).get();
	if (!row) throw notFound('Part requirement');
	return row;
}

function requirePart(ctx: Pick<Ctx, 'db'>, partId: number) {
	if (!ctx.db.select({ id: part.id }).from(part).where(eq(part.id, partId)).get()) {
		throw notFound('Part');
	}
}

export function forPart(ctx: Ctx, partId: number): PartLink[] {
	requirePart(ctx, partId);
	const ids = ctx.db
		.select({ id: partRequirement.id })
		.from(partRequirement)
		.where(eq(partRequirement.partId, partId))
		.all()
		.map((x) => x.id);
	return linkOut(ctx, ids);
}

export function assign(ctx: Ctx, input: { partId: number; reqNumber: string; notes?: string | null }): PartLink {
	requirePart(ctx, input.partId);
	const number = input.reqNumber.trim().toUpperCase();
	const req = currentByNumber(ctx, number);
	if (!req) throw invalid('reqNumber', `Requirement ${number} not found`);
	// One link per part and requirement number, whichever revision it was made against.
	const dup = ctx.db
		.select({ id: partRequirement.id })
		.from(partRequirement)
		.innerJoin(requirement, eq(requirement.id, partRequirement.requirementId))
		.where(and(eq(partRequirement.partId, input.partId), eq(requirement.reqNumber, number)))
		.get();
	if (dup) throw conflict('duplicate', `Requirement ${number} is already assigned to this part`);
	const row = insert(ctx, partRequirement, {
		partId: input.partId,
		requirementId: req.id,
		notes: input.notes ?? null
	});
	return linkOut(ctx, [row.id])[0]!;
}

export function updateLink(
	ctx: Ctx,
	input: { id: number; status?: PartLink['status']; notes?: string | null }
): PartLink {
	const row = loadLink(ctx, input.id);
	const patch: Record<string, unknown> = {};
	if (input.status !== undefined) patch.status = input.status;
	if (input.notes !== undefined) patch.notes = input.notes;
	if (Object.keys(patch).length) writeUpdate(ctx, partRequirement, row.id, patch);
	return linkOut(ctx, [row.id])[0]!;
}

export function verifyLink(ctx: Ctx, input: { id: number; notes?: string | null }): PartLink {
	const row = loadLink(ctx, input.id);
	writeUpdate(ctx, partRequirement, row.id, {
		status: 'verified',
		verifiedAt: now(),
		verifiedById: actorUserId(ctx.actor),
		...(input.notes ? { notes: input.notes } : {})
	});
	return linkOut(ctx, [row.id])[0]!;
}

export function unassign(ctx: Ctx, id: number): { ok: true } {
	loadLink(ctx, id);
	remove(ctx, partRequirement, id);
	return { ok: true };
}

/** How many requirement links a part has (the parts area lists it under what references a part). */
export function linkCount(ctx: Pick<Ctx, 'db'>, partId: number): number {
	return (
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(partRequirement)
			.where(eq(partRequirement.partId, partId))
			.get()?.n ?? 0
	);
}

export { readyRows };
