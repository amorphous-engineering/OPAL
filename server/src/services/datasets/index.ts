/** Datasets and their data points. */
import {
	MAX_IMPORT_POINTS,
	OpalError,
	conflict,
	notFound,
	now,
	type DataPoint,
	type Dataset,
	type DatasetSchema,
	type DatasetState,
	type PointValues,
	type SchemaField
} from '@opal/shared';
import { and, asc, count, desc, eq, gte, like, lte } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { dataPoint, dataset } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { projectRefs, requireActiveProject } from '../org/projects.ts'; // added by projects
import { parseCsv } from '../parts/csv.ts';
import { stepExists, stepSources, type StepSource } from '../execution/sources.ts'; // added by execution
import { checkPoint, pointProblems } from './validate.ts';

type DatasetRow = typeof dataset.$inferSelect;
type PointRow = typeof dataPoint.$inferSelect;

const pointCount = (ctx: Ctx, id: number) =>
	ctx.db.select({ n: count() }).from(dataPoint).where(eq(dataPoint.datasetId, id)).get()?.n ?? 0;

function present(ctx: Ctx, r: DatasetRow): Dataset {
	const project = projectRefs(ctx.db, [r.projectId]).get(r.projectId); // added by projects
	return {
		id: r.id,
		projectId: r.projectId, // added by projects
		projectCode: project?.code ?? '', // added by projects
		projectName: project?.name ?? '', // added by projects
		name: r.name,
		description: r.description,
		schema: r.schema,
		procedureId: r.procedureId,
		state: r.state,
		archivedAt: r.archivedAt,
		pointCount: pointCount(ctx, r.id),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

const presentPoint = (r: PointRow, source: StepSource | null = null): DataPoint => ({
	id: r.id,
	datasetId: r.datasetId,
	recordedAt: r.recordedAt,
	values: r.values,
	stepExecutionId: r.stepExecutionId,
	source, // added by execution
	createdAt: r.createdAt
});

function row(ctx: Ctx, id: number): DatasetRow {
	const r = ctx.db.select().from(dataset).where(eq(dataset.id, id)).get();
	if (!r) throw notFound('Dataset');
	return r;
}

/** A row that may still change. */
function openRow(ctx: Ctx, id: number): DatasetRow {
	const r = row(ctx, id);
	if (r.state === 'archived') throw conflict('archived', 'The dataset is archived and read-only');
	return r;
}

const iso = (v: string) => new Date(v).toISOString();

export function list(
	ctx: Ctx,
	i: { cursor?: string; limit: number; q?: string; projectId?: number; procedureId?: number; state?: DatasetState }
) {
	const q = i.q?.trim();
	const where = and(
		q ? like(dataset.name, `%${q}%`) : undefined,
		i.projectId !== undefined ? eq(dataset.projectId, i.projectId) : undefined, // added by projects
		i.procedureId !== undefined ? eq(dataset.procedureId, i.procedureId) : undefined,
		i.state ? eq(dataset.state, i.state) : undefined
	);
	const offset = Math.max(0, Number(i.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(dataset)
		.where(where)
		.orderBy(desc(dataset.id))
		.limit(i.limit + 1)
		.offset(offset)
		.all();
	return {
		items: rows.slice(0, i.limit).map((r) => present(ctx, r)),
		next: rows.length > i.limit ? String(offset + i.limit) : null
	};
}

export const get = (ctx: Ctx, id: number): Dataset => present(ctx, row(ctx, id));

export function create(
	ctx: Ctx,
	i: { projectId: number; name: string; description?: string | null; schema: DatasetSchema; procedureId?: number | null }
): Dataset {
	requireActiveProject(ctx.db, i.projectId); // added by projects
	const r = insert(ctx, dataset, {
		projectId: i.projectId, // added by projects
		name: i.name,
		description: i.description || null,
		schema: i.schema,
		procedureId: i.procedureId ?? null
	});
	return present(ctx, r);
}

export function updateDataset(
	ctx: Ctx,
	i: { id: number; projectId?: number; name?: string; description?: string | null; schema?: DatasetSchema; procedureId?: number | null }
): Dataset {
	const cur = openRow(ctx, i.id);
	const patch: Partial<typeof dataset.$inferInsert> = {};
	if (i.projectId !== undefined && i.projectId !== cur.projectId) { // added by projects
		requireActiveProject(ctx.db, i.projectId);
		patch.projectId = i.projectId;
	}
	if (i.name !== undefined) patch.name = i.name;
	if (i.description !== undefined) patch.description = i.description || null;
	if (i.schema !== undefined) patch.schema = i.schema;
	if (i.procedureId !== undefined) patch.procedureId = i.procedureId;
	return present(ctx, update(ctx, dataset, i.id, patch));
}

export function archive(ctx: Ctx, id: number): Dataset {
	openRow(ctx, id);
	return present(
		ctx,
		update(ctx, dataset, id, { state: 'archived', archivedAt: now(), archivedById: actorUserId(ctx.actor) })
	);
}

/** Only a dataset nothing recorded into can go; the rest are archived. */
export function deleteDataset(ctx: Ctx, id: number): void {
	row(ctx, id);
	if (pointCount(ctx, id) > 0) {
		throw conflict('has_points', 'The dataset has data points; archive it instead');
	}
	remove(ctx, dataset, id);
}

// ---- points ----

export function addPoint(
	ctx: Ctx,
	i: { id: number; recordedAt?: string; values: PointValues; stepExecutionId?: number | null }
): DataPoint {
	const ds = openRow(ctx, i.id);
	checkPoint(ds.schema, i.values);
	// added by execution: the step execution must exist
	if (i.stepExecutionId != null && !stepExists(ctx.db, i.stepExecutionId)) {
		throw new OpalError(422, 'invalid_input', `Step execution ${i.stepExecutionId} not found`, { stepExecutionId: 'Not found' });
	}
	const r = insert(ctx, dataPoint, {
		datasetId: i.id,
		recordedAt: i.recordedAt ? iso(i.recordedAt) : now(),
		values: i.values,
		stepExecutionId: i.stepExecutionId ?? null
	});
	return presentPoint(r, r.stepExecutionId === null ? null : (stepSources(ctx.db, [r.stepExecutionId]).get(r.stepExecutionId) ?? null)); // added by execution
}

export function listPoints(
	ctx: Ctx,
	i: { id: number; cursor?: string; limit: number; start?: string; end?: string; order: 'asc' | 'desc' }
) {
	row(ctx, i.id);
	const where = and(
		eq(dataPoint.datasetId, i.id),
		i.start ? gte(dataPoint.recordedAt, iso(i.start)) : undefined,
		i.end ? lte(dataPoint.recordedAt, iso(i.end)) : undefined
	);
	const dir = i.order === 'asc' ? asc : desc;
	const offset = Math.max(0, Number(i.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(dataPoint)
		.where(where)
		.orderBy(dir(dataPoint.recordedAt), dir(dataPoint.id))
		.limit(i.limit + 1)
		.offset(offset)
		.all();
	return {
		items: (() => {
			// added by execution: where each point came from
			const page = rows.slice(0, i.limit);
			const src = stepSources(ctx.db, page.map((p) => p.stepExecutionId).filter((x): x is number => x !== null));
			return page.map((p) => presentPoint(p, p.stepExecutionId === null ? null : (src.get(p.stepExecutionId) ?? null)));
		})(),
		next: rows.length > i.limit ? String(offset + i.limit) : null
	};
}

export function removePoint(ctx: Ctx, id: number, pointId: number): void {
	openRow(ctx, id);
	const p = ctx.db
		.select()
		.from(dataPoint)
		.where(and(eq(dataPoint.id, pointId), eq(dataPoint.datasetId, id)))
		.get();
	if (!p) throw notFound('Data point');
	remove(ctx, dataPoint, pointId);
}

// ---- chart ----

export function chart(
	ctx: Ctx,
	i: { id: number; field: string; start?: string; end?: string; limit: number }
) {
	const ds = row(ctx, i.id);
	const f = ds.schema.fields.find((x) => x.name === i.field);
	if (ds.schema.fields.length > 0 && !f) {
		throw new OpalError(422, 'invalid_input', `Unknown field '${i.field}'`, { field: `Unknown field '${i.field}'` });
	}
	const where = and(
		eq(dataPoint.datasetId, i.id),
		i.start ? gte(dataPoint.recordedAt, iso(i.start)) : undefined,
		i.end ? lte(dataPoint.recordedAt, iso(i.end)) : undefined
	);
	// The latest `limit` points, shown oldest first.
	const rows = ctx.db
		.select()
		.from(dataPoint)
		.where(where)
		.orderBy(desc(dataPoint.recordedAt), desc(dataPoint.id))
		.limit(i.limit)
		.all()
		.reverse();
	const num = (v: unknown): number | null => {
		if (typeof v === 'number' && Number.isFinite(v)) return v;
		if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
		return null;
	};
	return {
		field: i.field,
		unit: f?.unit ?? null,
		series: rows.map((r) => ({ recordedAt: r.recordedAt, value: num(r.values[i.field]) }))
	};
}

// ---- CSV ----

/** A cell that starts with one of these runs as a formula in a spreadsheet (OWASP). */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

function cell(v: unknown, isText: boolean): string {
	if (v === null || v === undefined) return '';
	const s = String(v);
	// Numbers and booleans are never formulas: "-5" stays "-5".
	const unsafe = typeof v === 'string' && isText && s !== '' && FORMULA_LEADERS.includes(s[0]!);
	const out = unsafe ? `'${s}` : s;
	return /[",\r\n]/.test(out) ? `"${out.replaceAll('"', '""')}"` : out;
}

const csvTime = (t: string) => t.replace(/\.000Z$/, 'Z');

export function exportCsv(ctx: Ctx, id: number): string {
	const ds = row(ctx, id);
	const names = ds.schema.fields.map((f) => f.name);
	const points = ctx.db
		.select()
		.from(dataPoint)
		.where(eq(dataPoint.datasetId, id))
		.orderBy(asc(dataPoint.recordedAt), asc(dataPoint.id))
		.all();
	const lines = [['recorded_at', ...names].map((c) => cell(c, true)).join(',')];
	for (const p of points) {
		lines.push(
			[csvTime(p.recordedAt), ...ds.schema.fields.map((f) => p.values[f.name])]
				.map((v, i) => cell(v, i === 0 || ds.schema.fields[i - 1]!.type !== 'number'))
				.join(',')
		);
	}
	return lines.join('\r\n') + '\r\n';
}

const TRUE = new Set(['true', 'yes', '1']);
const FALSE = new Set(['false', 'no', '0']);

function parseCell(f: SchemaField, raw: string): string | number | boolean {
	const s = raw.trim();
	if (f.type === 'number') return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
	if (f.type === 'boolean') return TRUE.has(s.toLowerCase()) ? true : FALSE.has(s.toLowerCase()) ? false : s;
	// Undo the export's formula guard.
	return f.type === 'text' && /^'[=+\-@\t\r]/.test(raw) ? raw.slice(1) : f.type === 'text' ? raw : s;
}

/** Import points from CSV: the header names the fields, `recorded_at` is optional. All or nothing. */
export function importPoints(ctx: Ctx, id: number, text: string) {
	const ds = openRow(ctx, id);
	const rows = parseCsv(text);
	const header = rows[0]?.map((h) => h.trim()) ?? [];
	if (header.length === 0) throw new OpalError(422, 'invalid_input', 'The CSV is empty', { csv: 'The CSV is empty' });
	if (rows.length - 1 > MAX_IMPORT_POINTS) {
		throw new OpalError(422, 'invalid_input', `At most ${MAX_IMPORT_POINTS} rows per import`, {
			csv: `At most ${MAX_IMPORT_POINTS} rows per import`
		});
	}
	const byName = new Map(ds.schema.fields.map((f) => [f.name.toLowerCase(), f]));
	let timeCol = -1;
	const cols: (SchemaField | null)[] = [];
	const problems: Record<string, string> = {};
	header.forEach((h, c) => {
		const key = h.toLowerCase();
		if (key === 'recorded_at' || key === 'recordedat') {
			timeCol = c;
			cols.push(null);
		} else if (byName.has(key)) cols.push(byName.get(key)!);
		else {
			cols.push(null);
			problems[`column ${c + 1}`] = `Unknown column '${h}'`;
		}
	});
	if (Object.keys(problems).length) {
		throw new OpalError(422, 'invalid_input', Object.values(problems)[0]!, problems);
	}

	const parsed: { recordedAt: string; values: PointValues }[] = [];
	rows.slice(1).forEach((r, n) => {
		const line = n + 2;
		const values: PointValues = {};
		cols.forEach((f, c) => {
			const raw = r[c] ?? '';
			if (f && raw.trim() !== '') values[f.name] = parseCell(f, raw);
		});
		let recordedAt = now();
		const rawTime = timeCol >= 0 ? (r[timeCol] ?? '').trim() : '';
		if (rawTime) {
			const t = Date.parse(rawTime);
			if (Number.isNaN(t)) problems[`row ${line}`] = `recorded_at '${rawTime}' is not an ISO 8601 time`;
			else recordedAt = new Date(t).toISOString();
		}
		const bad = pointProblems(ds.schema, values);
		const first = Object.values(bad)[0];
		if (first) problems[`row ${line}`] = first;
		parsed.push({ recordedAt, values });
	});
	if (Object.keys(problems).length) {
		throw new OpalError(422, 'invalid_input', Object.values(problems)[0]!, problems);
	}
	if (parsed.length === 0) throw new OpalError(422, 'invalid_input', 'The CSV has no data rows', { csv: 'No data rows' });

	const pointIds = parsed.map(
		(p) => insert(ctx, dataPoint, { datasetId: id, recordedAt: p.recordedAt, values: p.values, stepExecutionId: null }).id
	);
	return { imported: pointIds.length, pointIds };
}

