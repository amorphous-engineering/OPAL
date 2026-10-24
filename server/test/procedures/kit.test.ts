import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { kitItem } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function fx() {
	const s = await setup();
	const p = await s.proc('Kitted');
	return { ...s, pid: p.id as number };
}

describe('procedure kit', () => {
	test('a kit line names the part, its state and the stock on hand', async () => {
		const s = await fx();
		const washer = await s.part('Washer', false);
		const row = (await s.call('POST', `/procedures/${s.pid}/kit`, { partId: washer.id, quantity: '3' })).json;
		expect(row).toMatchObject({ partNumber: washer.internalPn, partName: 'Washer', partState: 'draft', quantity: '3', onHand: '0', usage: 'consume', stepId: null, procedureId: s.pid });
	});

	test('quantities are exact decimals and must be above zero', async () => {
		const s = await fx();
		const w = await s.part('W');
		expect((await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: w.id, quantity: '2.5' })).quantity).toBe('2.5');
		const z = await s.part('Z');
		const r = await s.call('POST', `/procedures/${s.pid}/kit`, { partId: z.id, quantity: '0' });
		expect(r.status).toBe(422);
		expect((await s.call('POST', `/procedures/${s.pid}/kit`, { partId: z.id, quantity: '1.23456' })).status).toBe(422);
	});

	test('update, list and remove a kit line', async () => {
		const s = await fx();
		const a = await s.part('Alpha');
		const b = await s.part('Beta');
		const rowB = await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: b.id, quantity: '1' });
		await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: a.id, quantity: '2' });
		expect((await s.ok('PATCH', `/procedures/${s.pid}/kit/${rowB.id}`, { quantity: '5' })).quantity).toBe('5');
		expect((await s.ok('GET', `/procedures/${s.pid}/kit`)).map((k: any) => k.partName)).toEqual(['Alpha', 'Beta']);
		expect((await s.call('DELETE', `/procedures/${s.pid}/kit/${rowB.id}`)).status).toBe(200);
		expect(await s.ok('GET', `/procedures/${s.pid}/kit`)).toHaveLength(1);
		expect((await s.call('DELETE', `/procedures/${s.pid}/kit/${rowB.id}`)).status).toBe(404);
	});

	test('a part appears once in the kit', async () => {
		const s = await fx();
		const a = await s.part('A');
		await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: a.id, quantity: '1' });
		const r = await s.call('POST', `/procedures/${s.pid}/kit`, { partId: a.id, quantity: '2' });
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('duplicate');
	});

	test('an unknown part is 404', async () => {
		const s = await fx();
		expect((await s.call('POST', `/procedures/${s.pid}/kit`, { partId: 999, quantity: '1' })).status).toBe(404);
	});

	test('procedure kit and step kit share one table and one part may sit in both', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		const screw = await s.part('Screw');
		await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: screw.id, quantity: '8' });
		const stepLine = await s.ok('POST', `/procedures/${s.pid}/steps/${a.id}/kit`, { partId: screw.id, quantity: '4', usage: 'tooling', notes: 'return it' });
		expect(stepLine).toMatchObject({ stepId: a.id, usage: 'tooling', notes: 'return it' });
		const rows = s.db.select().from(kitItem).where(eq(kitItem.partId, screw.id)).all();
		expect(rows.map((r) => [r.procedureId, r.stepId])).toEqual([[s.pid, null], [null, a.id]]);
		expect((await s.call('POST', `/procedures/${s.pid}/steps/${a.id}/kit`, { partId: screw.id, quantity: '1' })).status).toBe(409);
		expect((await s.ok('GET', `/procedures/${s.pid}/kit`))).toHaveLength(1);
		expect((await s.ok('GET', `/procedures/${s.pid}/steps/${a.id}/kit`))).toHaveLength(1);
	});

	test('step kit lines update, validate usage and remove', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		const nut = await s.part('Nut');
		const line = await s.ok('POST', `/procedures/${s.pid}/steps/${a.id}/kit`, { partId: nut.id, quantity: '2' });
		expect((await s.call('PATCH', `/procedures/${s.pid}/steps/${a.id}/kit/${line.id}`, { usage: 'borrow' })).status).toBe(422);
		const up = await s.ok('PATCH', `/procedures/${s.pid}/steps/${a.id}/kit/${line.id}`, { quantity: '3', usage: 'tooling', notes: 'n' });
		expect(up).toMatchObject({ quantity: '3', usage: 'tooling', notes: 'n' });
		await s.ok('DELETE', `/procedures/${s.pid}/steps/${a.id}/kit/${line.id}`);
		expect(await s.ok('GET', `/procedures/${s.pid}/steps/${a.id}/kit`)).toEqual([]);
	});

	test('a step kit line of another step is not found', async () => {
		const s = await fx();
		const { a, b } = await s.tree(s.pid);
		const nut = await s.part('Nut');
		const line = await s.ok('POST', `/procedures/${s.pid}/steps/${a.id}/kit`, { partId: nut.id, quantity: '1' });
		expect((await s.call('DELETE', `/procedures/${s.pid}/steps/${b.id}/kit/${line.id}`)).status).toBe(404);
	});

	test('a part in a kit or output cannot be deleted', async () => {
		const s = await fx();
		const bolt = await s.part('Bolt', false);
		await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: bolt.id, quantity: '1' });
		const r = await s.call('DELETE', `/parts/${bolt.id}`);
		expect(r.status).toBe(409);
		expect(JSON.stringify(r.json)).toContain('procedure_kit_items');
	});

	test('draft parts are fine while authoring', async () => {
		const s = await fx();
		const draftPart = await s.part('Draft part', false);
		expect((await s.call('POST', `/procedures/${s.pid}/kit`, { partId: draftPart.id, quantity: '1' })).status).toBe(200);
	});
});

describe('procedure outputs', () => {
	async function assembly(s: Awaited<ReturnType<typeof setup>>, lines: [string, string][]) {
		const asm = await s.part('Assembly');
		const comps: Record<string, any> = {};
		for (const [name, qty] of lines) {
			comps[name] = await s.part(name);
			await s.ok('POST', `/parts/${asm.id}/bom`, { componentId: comps[name].id, quantity: qty });
		}
		return { asm, comps };
	}

	test('adding an output fills the kit from the first-level BOM times the quantity', async () => {
		const s = await fx();
		const { asm } = await assembly(s, [['Rivet', '2'], ['Plate', '1']]);
		const out = await s.ok('POST', `/procedures/${s.pid}/outputs`, { partId: asm.id, quantity: '3' });
		expect(out).toMatchObject({ partId: asm.id, quantity: '3', partName: 'Assembly' });
		const kit = await s.ok('GET', `/procedures/${s.pid}/kit`);
		expect(kit.map((k: any) => [k.partName, k.quantity])).toEqual([['Plate', '3'], ['Rivet', '6']]);
	});

	test('a component already in the kit gains the quantity', async () => {
		const s = await fx();
		const { asm, comps } = await assembly(s, [['Rivet', '2']]);
		await s.ok('POST', `/procedures/${s.pid}/kit`, { partId: comps['Rivet'].id, quantity: '5' });
		await s.ok('POST', `/procedures/${s.pid}/outputs`, { partId: asm.id, quantity: '1' });
		expect((await s.ok('GET', `/procedures/${s.pid}/kit`))[0].quantity).toBe('7');
	});

	test('an output with no BOM leaves the kit alone and quantity defaults to one', async () => {
		const s = await fx();
		const lone = await s.part('Lone');
		const out = await s.ok('POST', `/procedures/${s.pid}/outputs`, { partId: lone.id });
		expect(out.quantity).toBe('1');
		expect(await s.ok('GET', `/procedures/${s.pid}/kit`)).toEqual([]);
	});

	test('output update, duplicate refusal and removal', async () => {
		const s = await fx();
		const a = await s.part('A');
		const out = await s.ok('POST', `/procedures/${s.pid}/outputs`, { partId: a.id });
		expect((await s.call('POST', `/procedures/${s.pid}/outputs`, { partId: a.id })).status).toBe(409);
		expect((await s.ok('PATCH', `/procedures/${s.pid}/outputs/${out.id}`, { quantity: '4' })).quantity).toBe('4');
		expect((await s.call('PATCH', `/procedures/${s.pid}/outputs/${out.id}`, { quantity: '0' })).status).toBe(422);
		await s.ok('DELETE', `/procedures/${s.pid}/outputs/${out.id}`);
		expect(await s.ok('GET', `/procedures/${s.pid}/outputs`)).toEqual([]);
	});
});

describe('op dependencies', () => {
	async function ops(n: number) {
		const s = await fx();
		const ids: number[] = [];
		for (let i = 0; i < n; i++) ids.push((await s.step(s.pid, `OP ${i + 1}`)).id);
		return { ...s, ids };
	}

	test('set and list dependencies; the draft carries them', async () => {
		const s = await ops(3);
		const r = await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[2]}/dependencies`, { dependsOn: [s.ids[0], s.ids[1]] });
		expect(r).toEqual({ stepId: s.ids[2], dependsOn: [s.ids[0], s.ids[1]] });
		expect(await s.ok('GET', `/procedures/${s.pid}/dependencies`)).toEqual([
			{ stepId: s.ids[2], dependsOnStepId: s.ids[0] },
			{ stepId: s.ids[2], dependsOnStepId: s.ids[1] }
		]);
		expect((await s.draft(s.pid))[2].dependsOn).toEqual([s.ids[0], s.ids[1]]);
		await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[2]}/dependencies`, { dependsOn: [s.ids[1]] });
		expect(await s.ok('GET', `/procedures/${s.pid}/dependencies`)).toHaveLength(1);
	});

	test('a self-loop is refused', async () => {
		const s = await ops(2);
		const r = await s.call('PUT', `/procedures/${s.pid}/steps/${s.ids[0]}/dependencies`, { dependsOn: [s.ids[0]] });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('dependency_self');
	});

	test('a cycle is refused, direct and transitive', async () => {
		const s = await ops(3);
		await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[1]}/dependencies`, { dependsOn: [s.ids[0]] });
		await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[2]}/dependencies`, { dependsOn: [s.ids[1]] });
		const direct = await s.call('PUT', `/procedures/${s.pid}/steps/${s.ids[0]}/dependencies`, { dependsOn: [s.ids[1]] });
		expect(direct.json.error).toBe('dependency_cycle');
		const loop = await s.call('PUT', `/procedures/${s.pid}/steps/${s.ids[0]}/dependencies`, { dependsOn: [s.ids[2]] });
		expect(loop.json.error).toBe('dependency_cycle');
		expect(await s.ok('GET', `/procedures/${s.pid}/dependencies`)).toHaveLength(2);
	});

	test('only top-level OPs of the same procedure take part', async () => {
		const s = await ops(2);
		const { a } = await s.tree(s.pid);
		expect((await s.call('PUT', `/procedures/${s.pid}/steps/${a.id}/dependencies`, { dependsOn: [s.ids[0]] })).json.error).toBe('not_an_op');
		expect((await s.call('PUT', `/procedures/${s.pid}/steps/${s.ids[0]}/dependencies`, { dependsOn: [a.id] })).json.error).toBe('not_an_op');
		const other = await s.proc('Other');
		const foreign = await s.step(other.id, 'F');
		expect((await s.call('PUT', `/procedures/${s.pid}/steps/${s.ids[0]}/dependencies`, { dependsOn: [foreign.id] })).json.error).toBe('dependency_foreign');
	});

	test('deleting an OP removes the edges that touch it', async () => {
		const s = await ops(2);
		await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[1]}/dependencies`, { dependsOn: [s.ids[0]] });
		await s.ok('DELETE', `/procedures/${s.pid}/steps/${s.ids[0]}`);
		expect(await s.ok('GET', `/procedures/${s.pid}/dependencies`)).toEqual([]);
	});

	test('a clone keeps type and dependencies on its own steps', async () => {
		const s = await ops(2);
		await s.ok('PATCH', `/procedures/${s.pid}`, { procedureType: 'build' });
		await s.ok('PUT', `/procedures/${s.pid}/steps/${s.ids[1]}/dependencies`, { dependsOn: [s.ids[0]] });
		const clone = (await s.call('POST', `/procedures/${s.pid}/clone`, {})).json;
		expect(clone.procedureType).toBe('build');
		const edges = await s.ok('GET', `/procedures/${clone.id}/dependencies`);
		expect(edges).toHaveLength(1);
		expect(s.ids).not.toContain(edges[0].stepId);
	});
});
