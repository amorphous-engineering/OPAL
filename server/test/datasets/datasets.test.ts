import { describe, expect, test } from 'bun:test';
import { auditLog } from '../../src/db/schema/index.ts';
import { setup as partsSetup } from '../parts/helpers.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects

/** The parts fixture plus a project; dataset creates carry it unless a test names another. */
async function setup() {
	const s = await partsSetup();
	const project = createTestProject(s.db);
	const api = (method: string, path: string, body?: unknown) =>
		s.api(
			method,
			path,
			method === 'POST' && path === '/datasets' && body && !('projectId' in (body as object))
				? { ...(body as object), projectId: project.id }
				: body
		);
	return { ...s, api, project };
}

const num = (extra = {}) => ({ name: 'value', type: 'number', ...extra });

async function make(fields: unknown[] = [num()], extra: Record<string, unknown> = {}) {
	const s = await setup();
	const r = await s.api('POST', '/datasets', { name: 'Probe', schema: { fields }, ...extra });
	if (r.status !== 201) throw new Error(r.text);
	return { ...s, ds: r.json, pts: (body: unknown) => s.api('POST', `/datasets/${r.json.id}/points`, body) };
}

describe('datasets', () => {
	test('a dataset is created with its schema and no points', async () => {
		const { ds } = await make([num({ name: 'temperature', unit: 'C' })]);
		expect(ds.name).toBe('Probe');
		expect(ds.schema.fields[0].name).toBe('temperature');
		expect(ds.pointCount).toBe(0);
		expect(ds.state).toBe('active');
	});

	test('list returns newest first and filters by name and procedure', async () => {
		const { api } = await setup();
		await api('POST', '/datasets', { name: 'Dataset A', schema: { fields: [] }, procedureId: 7 });
		await api('POST', '/datasets', { name: 'Dataset B', schema: { fields: [] } });
		const all = await api('GET', '/datasets');
		expect(all.json.items.map((d: any) => d.name)).toEqual(['Dataset B', 'Dataset A']);
		expect((await api('GET', '/datasets?q=ataset%20A')).json.items).toHaveLength(1);
		const linked = await api('GET', '/datasets?procedureId=7');
		expect(linked.json.items.map((d: any) => d.name)).toEqual(['Dataset A']);
	});

	test('get returns one dataset and 404 for a missing one', async () => {
		const { api, ds } = await make();
		expect((await api('GET', `/datasets/${ds.id}`)).json.name).toBe('Probe');
		expect((await api('GET', '/datasets/999')).status).toBe(404);
	});

	test('field names must be unique and min cannot exceed max', async () => {
		const { api } = await setup();
		const dup = await api('POST', '/datasets', { name: 'X', schema: { fields: [num(), num()] } });
		expect(dup.status).toBe(422);
		const bad = await api('POST', '/datasets', { name: 'X', schema: { fields: [num({ min: 5, max: 1 })] } });
		expect(bad.status).toBe(422);
	});

	test('update changes the name and an explicit null clears description and procedure', async () => {
		const { api, ds } = await make([num()], { description: 'd', procedureId: 3 });
		const r = await api('PATCH', `/datasets/${ds.id}`, { description: null, procedureId: null });
		expect(r.json.description).toBeNull();
		expect(r.json.procedureId).toBeNull();
		expect(r.json.name).toBe('Probe');
		const r2 = await api('PATCH', `/datasets/${ds.id}`, { name: 'Renamed' });
		expect(r2.json.name).toBe('Renamed');
	});

	test('a dataset without points is deleted', async () => {
		const { api, ds } = await make();
		expect((await api('DELETE', `/datasets/${ds.id}`)).status).toBe(200);
		expect((await api('GET', `/datasets/${ds.id}`)).status).toBe(404);
	});

	test('a dataset with points is not deleted: it is archived, read-only and terminal', async () => {
		const { api, ds, pts } = await make();
		await pts({ values: { value: 1 } });
		const del = await api('DELETE', `/datasets/${ds.id}`);
		expect(del.status).toBe(409);
		expect(del.json.error).toBe('has_points');
		const arch = await api('POST', `/datasets/${ds.id}/archive`);
		expect(arch.json.state).toBe('archived');
		expect(arch.json.archivedAt).not.toBeNull();
		expect((await pts({ values: { value: 2 } })).status).toBe(409);
		expect((await api('PATCH', `/datasets/${ds.id}`, { name: 'n' })).status).toBe(409);
		expect((await api('POST', `/datasets/${ds.id}/archive`)).status).toBe(409);
		expect((await api('GET', `/datasets?state=archived`)).json.items).toHaveLength(1);
		expect((await api('GET', `/datasets/${ds.id}/points`)).json.items).toHaveLength(1);
	});

	test('anonymous callers get 401', async () => {
		const { call } = await setup();
		expect((await call(null, 'GET', '/datasets')).status).toBe(401);
	});
});

describe('data points', () => {
	test('a point is added, listed oldest or newest first, and deleted', async () => {
		const { api, ds, pts } = await make();
		for (const [n, t] of [[1, '2026-01-01T00:00:00Z'], [2, '2026-01-02T00:00:00Z'], [3, '2026-01-03T00:00:00Z']] as const) {
			const r = await pts({ values: { value: n }, recordedAt: t });
			expect(r.status).toBe(200);
			expect(r.json.datasetId).toBe(ds.id);
		}
		const desc = await api('GET', `/datasets/${ds.id}/points`);
		expect(desc.json.items.map((p: any) => p.values.value)).toEqual([3, 2, 1]);
		const asc = await api('GET', `/datasets/${ds.id}/points?order=asc&limit=2`);
		expect(asc.json.items.map((p: any) => p.values.value)).toEqual([1, 2]);
		expect(asc.json.next).toBe('2');
		const ranged = await api('GET', `/datasets/${ds.id}/points?start=2026-01-02T00:00:00Z&end=2026-01-02T12:00:00Z`);
		expect(ranged.json.items).toHaveLength(1);
		const id = desc.json.items[0].id;
		expect((await api('DELETE', `/datasets/${ds.id}/points/${id}`)).status).toBe(200);
		expect((await api('GET', `/datasets/${ds.id}/points`)).json.items).toHaveLength(2);
		expect((await api('DELETE', `/datasets/${ds.id}/points/${id}`)).status).toBe(404);
		expect((await api('GET', `/datasets/${ds.id}`)).json.pointCount).toBe(2);
	});

	test('values are validated against the schema', async () => {
		const { pts } = await make([
			num({ name: 'temp', min: 0, max: 100 }),
			{ name: 'ok', type: 'boolean' },
			{ name: 'note', type: 'text' },
			{ name: 'when', type: 'date' },
			num({ name: 'req', required: true })
		]);
		expect((await pts({ values: { temp: 'hot', req: 1 } })).status).toBe(422);
		expect((await pts({ values: { nope: 1, req: 1 } })).status).toBe(422);
		expect((await pts({ values: { ok: 'yes', req: 1 } })).status).toBe(422);
		expect((await pts({ values: { temp: 101, req: 1 } })).status).toBe(422);
		expect((await pts({ values: { when: 'tomorrow', req: 1 } })).status).toBe(422);
		expect((await pts({ values: { temp: 1.5 } })).status).toBe(422);
		const ok = await pts({ values: { temp: 1.5, ok: true, note: 'a', when: '2026-01-01', req: 2 } });
		expect(ok.status).toBe(200);
	});

	test('a schema with no fields accepts any values', async () => {
		const { pts } = await make([]);
		expect((await pts({ values: { anything: 1 } })).status).toBe(200);
	});

	test('text round-trips as a raw string', async () => {
		const { api, ds, pts } = await make([{ name: 'note', type: 'text' }], { description: '<b>"x"</b> & y' });
		await pts({ values: { note: '<script>alert(1)</script>' } });
		expect((await api('GET', `/datasets/${ds.id}`)).json.description).toBe('<b>"x"</b> & y');
		expect((await api('GET', `/datasets/${ds.id}/points`)).json.items[0].values.note).toBe('<script>alert(1)</script>');
	});

	// changed by execution: the step execution must exist (the link itself is tested in test/execution)
	test('a point that names an unknown step execution is refused', async () => {
		const { pts } = await make();
		const r = await pts({ values: { value: 1 }, stepExecutionId: 42 });
		expect(r.status).toBe(422);
		expect((await pts({ values: { value: 1 } })).json.source).toBeNull();
	});

	test('point and dataset changes are audited', async () => {
		const { api, db, ds, pts } = await make();
		const p = await pts({ values: { value: 1 } });
		await api('DELETE', `/datasets/${ds.id}/points/${p.json.id}`);
		const rows = db.select().from(auditLog).all().filter((r) => r.entity === 'data_point');
		expect(rows.map((r) => r.action)).toEqual(['create', 'delete']);
		expect(db.select().from(auditLog).all().some((r) => r.entity === 'dataset' && r.action === 'create')).toBe(true);
	});
});

describe('chart', () => {
	test('the series holds one field, oldest first, with null where a point has no number', async () => {
		const { api, ds, pts } = await make([num({ name: 'temperature', unit: 'C' }), { name: 'note', type: 'text' }]);
		await pts({ values: { temperature: 22 }, recordedAt: '2026-01-02T00:00:00Z' });
		await pts({ values: { temperature: 20 }, recordedAt: '2026-01-01T00:00:00Z' });
		await pts({ values: { note: 'x' }, recordedAt: '2026-01-03T00:00:00Z' });
		const r = await api('GET', `/datasets/${ds.id}/chart?field=temperature`);
		expect(r.json.field).toBe('temperature');
		expect(r.json.unit).toBe('C');
		expect(r.json.series.map((s: any) => s.value)).toEqual([20, 22, null]);
		expect((await api('GET', `/datasets/${ds.id}/chart?field=nope`)).status).toBe(422);
		const limited = await api('GET', `/datasets/${ds.id}/chart?field=temperature&limit=2`);
		expect(limited.json.series.map((s: any) => s.value)).toEqual([22, null]);
	});
});

describe('csv', () => {
	test('export has ISO UTC timestamps and one column per field', async () => {
		const { api, ds, pts } = await make([num({ name: 'p' })]);
		await pts({ values: { p: 5 }, recordedAt: '2026-10-22T22:38:32Z' });
		const r = await api('GET', `/datasets/${ds.id}/export`);
		expect(r.status).toBe(200);
		expect(r.text.trim().split(/\r?\n/)).toEqual(['recorded_at,p', '2026-10-22T22:38:32Z,5']);
	});

	test('export neutralizes formulas in text but leaves negative numbers alone', async () => {
		const { api, ds, pts } = await make([num({ name: 'p' }), { name: 'note', type: 'text' }]);
		await pts({ values: { p: -5, note: '=HYPERLINK("x")' } });
		const lines = (await api('GET', `/datasets/${ds.id}/export`)).text.trim().split(/\r?\n/);
		expect(lines[1]!.endsWith(`,-5,"'=HYPERLINK(""x"")"`)).toBe(true);
	});

	test('import adds every row, parsing by field type', async () => {
		const { api, ds } = await make([num({ name: 'p' }), { name: 'ok', type: 'boolean' }, { name: 'note', type: 'text' }]);
		const csv = 'recorded_at,p,ok,note\n2026-01-01T00:00:00Z,1.5,yes,"a, b"\n2026-01-02T00:00:00Z,-2,false,\n';
		const r = await api('POST', `/datasets/${ds.id}/points/import`, { csv });
		expect(r.json.imported).toBe(2);
		const pts = (await api('GET', `/datasets/${ds.id}/points?order=asc`)).json.items;
		expect(pts[0].values).toEqual({ p: 1.5, ok: true, note: 'a, b' });
		expect(pts[1].values).toEqual({ p: -2, ok: false });
	});

	test('one bad row imports nothing and names the row', async () => {
		const { api, ds } = await make([num({ name: 'p' })]);
		const r = await api('POST', `/datasets/${ds.id}/points/import`, { csv: 'p\n1\nabc\n3\n' });
		expect(r.status).toBe(422);
		expect(Object.keys(r.json.fields)).toEqual(['row 3']);
		expect((await api('GET', `/datasets/${ds.id}`)).json.pointCount).toBe(0);
		const unknown = await api('POST', `/datasets/${ds.id}/points/import`, { csv: 'zzz\n1\n' });
		expect(unknown.status).toBe(422);
	});

	test('export then import restores the points', async () => {
		const a = await make([num({ name: 'p' })]);
		await a.pts({ values: { p: 3 }, recordedAt: '2026-01-01T00:00:00Z' });
		const csv = (await a.api('GET', `/datasets/${a.ds.id}/export`)).text;
		const b = await a.api('POST', '/datasets', { name: 'Copy', schema: { fields: [num({ name: 'p' })] } });
		await a.api('POST', `/datasets/${b.json.id}/points/import`, { csv });
		const got = await a.api('GET', `/datasets/${b.json.id}/points`);
		expect(got.json.items[0].values.p).toBe(3);
		expect(got.json.items[0].recordedAt).toBe('2026-01-01T00:00:00.000Z');
	});
});

describe('projects', () => {
	test('a dataset needs an active project and shows its code and name', async () => {
		const { api, db, project } = await setup();
		const raw = await partsSetup();
		expect((await raw.api('POST', '/datasets', { name: 'x', schema: { fields: [] } })).status).toBe(422);
		expect((await api('POST', '/datasets', { name: 'x', schema: { fields: [] }, projectId: 999 })).status).toBe(404);
		const dead = createTestProject(db, 'DEAD');
		await api('POST', `/projects/${dead.id}/archive`);
		expect((await api('POST', '/datasets', { name: 'x', schema: { fields: [] }, projectId: dead.id })).status).toBe(409);
		const r = await api('POST', '/datasets', { name: 'x', schema: { fields: [] } });
		expect(r.json).toMatchObject({ projectId: project.id, projectCode: 'TP', projectName: 'Project TP' });
	});

	test('the list filters by project and a dataset moves to another active project', async () => {
		const { api, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const a1 = (await api('POST', '/datasets', { name: 'a', schema: { fields: [] } })).json;
		const b1 = (await api('POST', '/datasets', { name: 'b', schema: { fields: [] }, projectId: b.id })).json;
		const ids = async (q: string) => (await api('GET', `/datasets${q}`)).json.items.map((x: any) => x.id);
		expect(await ids(`?projectId=${project.id}`)).toEqual([a1.id]);
		expect(await ids(`?projectId=${b.id}`)).toEqual([b1.id]);
		const moved = await api('PATCH', `/datasets/${a1.id}`, { projectId: b.id });
		expect(moved.json).toMatchObject({ projectId: b.id, projectCode: 'B' });
		expect(await ids(`?projectId=${b.id}`)).toHaveLength(2);
	});
});
