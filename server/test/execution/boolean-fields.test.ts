import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { renameCheckboxFields } from '../../src/db/boolean-fields.ts';
import { appSetting, procedureStep, procedureVersion } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function withBoolean(t: Awaited<ReturnType<typeof setup>>, type: string, required = false) {
	const p = await t.proc('Checks');
	await t.step(p.id, 'Inspect', {
		dataSchema: { fields: [{ name: 'ok', label: 'O-ring seated', type, ...(required ? { required } : {}) }] }
	});
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return p.id as number;
}

describe('boolean data fields', () => {
	test('the old type name checkbox is accepted and comes back as boolean', async () => {
		const t = await setup();
		const pid = await withBoolean(t, 'checkbox');
		const draft = await t.ok('GET', `/procedures/${pid}/draft`);
		expect(draft.steps[0].dataSchema.fields[0].type).toBe('boolean');
		const [row] = t.db.select().from(procedureStep).where(eq(procedureStep.procedureId, pid)).all();
		expect(row!.dataSchema!.fields[0]!.type).toBe('boolean');
	});

	test('a boolean value is true or false; any other value is refused', async () => {
		const t = await setup();
		const e = await t.cut(await withBoolean(t, 'boolean'));
		const bad = await t.complete(e.id, '1', { dataCaptured: { ok: 'yes' } });
		expect(bad.status).toBe(422);
		expect(JSON.stringify(bad.json)).toContain('answer TRUE or FALSE');
		expect((await t.complete(e.id, '1', { dataCaptured: { ok: true } })).status).toBe(200);
	});

	test('false answers a required boolean; no answer does not', async () => {
		const t = await setup();
		const e = await t.cut(await withBoolean(t, 'boolean', true));
		expect((await t.complete(e.id, '1', { dataCaptured: { ok: null } })).status).toBe(422);
		expect((await t.complete(e.id, '1', { dataCaptured: { ok: false } })).status).toBe(200);
	});

	test('stored checkbox fields are renamed once, in drafts and published snapshots', async () => {
		const t = await setup();
		const pid = await withBoolean(t, 'boolean');
		// Put the old spelling back, as a database from before the rename holds it.
		const [row] = t.db.select().from(procedureStep).where(eq(procedureStep.procedureId, pid)).all();
		t.db.update(procedureStep)
			.set({ dataSchema: { fields: [{ name: 'ok', type: 'checkbox' as 'boolean' }] } })
			.where(eq(procedureStep.id, row!.id))
			.run();
		const [ver] = t.db.select().from(procedureVersion).where(eq(procedureVersion.procedureId, pid)).all();
		const old = JSON.parse(JSON.stringify(ver!.content).replaceAll('"boolean"', '"checkbox"'));
		t.db.update(procedureVersion).set({ content: old }).where(eq(procedureVersion.id, ver!.id)).run();

		renameCheckboxFields(t.db, true);
		const after = t.db.select().from(procedureStep).where(eq(procedureStep.id, row!.id)).get()!;
		expect(after.dataSchema!.fields[0]!.type).toBe('boolean');
		const content = t.db.select().from(procedureVersion).where(eq(procedureVersion.id, ver!.id)).get()!.content;
		expect(JSON.stringify(content)).not.toContain('"checkbox"');
		expect(JSON.stringify(content)).toContain('"boolean"');
		expect(t.db.select().from(appSetting).where(eq(appSetting.key, 'fields_boolean_type')).get()).toBeTruthy();
	});
});
