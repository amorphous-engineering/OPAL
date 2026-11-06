import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dataPoint, procedureVersion } from '../../src/db/schema/index.ts';
import { setup } from '../execution/helpers.ts';

const LONG = 'q'.repeat(300);
const VERY_LONG = 'x'.repeat(20_000);

/** Limits arrived after this data did. The server accepted it, so it has to keep opening. */
describe('a stored value over a later input limit', () => {
	test('a published version and a run cut from it still open', async () => {
		const t = await setup();
		const p = await t.proc('Long label');
		await t.step(p.id, 'S', { dataSchema: { fields: [{ name: 'x', label: 'L', type: 'text' }] } });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const client = (t.db as any).$client;
		for (const [table, column] of [['procedure_version', 'content'], ['procedure_step', 'data_schema'], ['step_execution', 'data_schema']] as const) {
			const has = client.query(`pragma table_info(${table})`).all().some((c: any) => c.name === column);
			if (has) client.run(`update ${table} set ${column} = replace(${column}, '"label":"L"', '"label":"${LONG}"')`);
		}
		const version = t.db.select().from(procedureVersion).where(eq(procedureVersion.procedureId, p.id)).get()!;
		expect(JSON.stringify(version.content)).toContain(LONG);
		const doc = await t.call('GET', `/executions/${e.id}/document`);
		expect(doc.status).toBe(200);
		expect(doc.text).toContain(LONG);
		expect((await t.call('GET', `/procedures/${p.id}/draft`)).status).toBe(200);
		const read = await t.call('GET', `/procedures/versions/${version.id}`);
		expect(read.status).toBe(200);
		expect(read.text).toContain(LONG);
	});

	test("a dataset's points still list, and a point can still be struck", async () => {
		const t = await setup();
		const project = (await t.ok('GET', '/projects')).items[0];
		const ds = await t.ok('POST', '/datasets', { projectId: project.id, name: 'D', schema: { fields: [{ name: 'note', type: 'text' }] } });
		const point = await t.ok('POST', `/datasets/${ds.id}/points`, { values: { note: 'short' } });
		t.db.update(dataPoint).set({ values: { note: VERY_LONG } }).where(eq(dataPoint.id, point.id)).run();
		const list = await t.call('GET', `/datasets/${ds.id}/points`);
		expect(list.status).toBe(200);
		expect(list.json.items[0].values.note).toBe(VERY_LONG);
		expect((await t.call('POST', `/datasets/${ds.id}/points/${point.id}/strike`, { reason: 'bad reading' })).status).toBe(200);
	});

	test('sending the same value in again is still refused', async () => {
		const t = await setup();
		const project = (await t.ok('GET', '/projects')).items[0];
		const ds = await t.ok('POST', '/datasets', { projectId: project.id, name: 'D', schema: { fields: [{ name: 'note', type: 'text' }] } });
		expect((await t.call('POST', `/datasets/${ds.id}/points`, { values: { note: VERY_LONG } })).status).toBe(422);
	});
});

describe('a dataset CSV import', () => {
	test('a cell over the limit a single point has is refused, and nothing is stored', async () => {
		const t = await setup();
		const project = (await t.ok('GET', '/projects')).items[0];
		const ds = await t.ok('POST', '/datasets', { projectId: project.id, name: 'D', schema: { fields: [{ name: 'note', type: 'text' }] } });
		const res = await t.call('POST', `/datasets/${ds.id}/points/import`, { csv: `note\nfine\n${VERY_LONG}\n` });
		expect(res.status).toBe(422);
		expect(res.json.fields['row 3']).toContain('too long');
		expect((await t.ok('GET', `/datasets/${ds.id}/points`)).items).toEqual([]);
	});
});
