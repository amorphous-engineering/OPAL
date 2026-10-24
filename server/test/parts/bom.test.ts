import { describe, expect, test } from 'bun:test';
import { auditLog } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function fixture() {
	const s = await setup();
	const asm = await s.create({ name: 'Assembly' });
	const a = await s.create({ name: 'Comp A', externalPn: 'MCM-A' });
	const b = await s.create({ name: 'Comp B' });
	return { ...s, asm, a, b };
}

describe('bill of materials', () => {
	test('an assembly with no components has an empty BOM', async () => {
		const { api, asm } = await fixture();
		expect((await api('GET', `/parts/${asm.id}/bom`)).json).toEqual([]);
	});

	test('adding a component stores a decimal quantity and names both parts by number', async () => {
		const { api, asm, a } = await fixture();
		const res = await api('POST', `/parts/${asm.id}/bom`, {
			componentId: a.id,
			quantity: '2.5',
			referenceDesignator: 'R1',
			notes: 'sealed'
		});
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			assemblyId: asm.id,
			assemblyPn: asm.internalPn,
			assemblyName: 'Assembly',
			componentId: a.id,
			componentPn: a.internalPn,
			componentName: 'Comp A',
			componentExternalPn: 'MCM-A',
			componentTier: 1,
			componentState: 'draft',
			quantity: '2.5',
			referenceDesignator: 'R1',
			notes: 'sealed'
		});
	});

	test('quantity defaults to one', async () => {
		const { api, asm, a } = await fixture();
		expect((await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id })).json.quantity).toBe('1');
	});

	test('the BOM lists components in the order they were added', async () => {
		const { api, asm, a, b } = await fixture();
		await api('POST', `/parts/${asm.id}/bom`, { componentId: b.id });
		await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, quantity: '3' });
		const bom = (await api('GET', `/parts/${asm.id}/bom`)).json;
		expect(bom.map((l: any) => l.componentName)).toEqual(['Comp B', 'Comp A']);
	});

	test('a missing assembly or component is 404', async () => {
		const { api, asm, a } = await fixture();
		expect((await api('POST', `/parts/999/bom`, { componentId: a.id })).status).toBe(404);
		expect((await api('POST', `/parts/${asm.id}/bom`, { componentId: 999 })).status).toBe(404);
	});

	test('a part cannot be a component of itself', async () => {
		const { api, asm } = await fixture();
		const res = await api('POST', `/parts/${asm.id}/bom`, { componentId: asm.id });
		expect(res.status).toBe(422);
	});

	test('a component cannot be added twice to one assembly', async () => {
		const { api, asm, a } = await fixture();
		await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id });
		const res = await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id });
		expect(res.status).toBe(409);
	});

	test('a loop is refused, directly and through a sub-assembly', async () => {
		const { api, asm, a, b } = await fixture();
		await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id });
		await api('POST', `/parts/${a.id}/bom`, { componentId: b.id });
		const direct = await api('POST', `/parts/${a.id}/bom`, { componentId: asm.id });
		expect(direct.status).toBe(409);
		expect(direct.json.error).toBe('bom_loop');
		expect((await api('POST', `/parts/${b.id}/bom`, { componentId: asm.id })).status).toBe(409);
	});

	test('the quantity must be above zero', async () => {
		const { api, asm, a } = await fixture();
		for (const quantity of ['0', '-1', '0.0000']) {
			expect((await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, quantity })).status).toBe(422);
		}
		expect((await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, quantity: '1.23456' })).status).toBe(422);
		const line = (await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id })).json;
		expect((await api('PATCH', `/bom/${line.id}`, { quantity: '0' })).status).toBe(422);
	});

	test('the tree nests sub-assemblies with their quantities', async () => {
		const { api, asm, a, b } = await fixture();
		await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, quantity: '2', referenceDesignator: 'A1' });
		await api('POST', `/parts/${a.id}/bom`, { componentId: b.id, quantity: '0.5' });
		const tree = (await api('GET', `/parts/${asm.id}/bom/tree`)).json;
		expect(tree).toMatchObject({ partId: asm.id, quantity: '1', circular: false });
		expect(tree.children).toHaveLength(1);
		expect(tree.children[0]).toMatchObject({ partId: a.id, quantity: '2', referenceDesignator: 'A1' });
		expect(tree.children[0].children[0]).toMatchObject({ partId: b.id, quantity: '0.5', children: [] });
		const shallow = (await api('GET', `/parts/${asm.id}/bom/tree?depth=1`)).json;
		expect(shallow.children[0].children).toEqual([]);
	});

	test('where-used lists the assemblies of a component and is empty for an unused part', async () => {
		const { api, asm, a, b } = await fixture();
		await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id });
		const used = (await api('GET', `/parts/${a.id}/where-used`)).json;
		expect(used.map((l: any) => l.assemblyPn)).toEqual([asm.internalPn]);
		expect((await api('GET', `/parts/${b.id}/where-used`)).json).toEqual([]);
		const detail = (await api('GET', `/parts/${a.id}/detail`)).json;
		expect(detail.whereUsed).toHaveLength(1);
		expect(detail.references).toEqual({ used_in_assemblies: 1 });
	});

	test('a BOM line is edited and removed, with audit rows', async () => {
		const { db, api, asm, a } = await fixture();
		const line = (await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, referenceDesignator: 'R1', notes: 'n' })).json;
		const patched = await api('PATCH', `/bom/${line.id}`, { quantity: '7' });
		expect(patched.json).toMatchObject({ quantity: '7', referenceDesignator: 'R1', notes: 'n' });
		expect((await api('DELETE', `/bom/${line.id}`)).status).toBe(200);
		expect((await api('GET', `/parts/${asm.id}/bom`)).json).toEqual([]);
		const actions = db.select().from(auditLog).all().filter((r) => r.entity === 'bom_line').map((r) => r.action);
		expect(actions).toEqual(['create', 'update', 'delete']);
		expect((await api('DELETE', `/bom/${line.id}`)).status).toBe(404);
	});

	test('an explicit null clears the designator and notes; an omitted field is kept', async () => {
		const { api, asm, a } = await fixture();
		const line = (await api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, referenceDesignator: 'R1', notes: 'n' })).json;
		const kept = await api('PATCH', `/bom/${line.id}`, { quantity: '2' });
		expect(kept.json).toMatchObject({ referenceDesignator: 'R1', notes: 'n' });
		const cleared = await api('PATCH', `/bom/${line.id}`, { referenceDesignator: null, notes: null });
		expect(cleared.json).toMatchObject({ referenceDesignator: null, notes: null, quantity: '2' });
	});

	test('a section expects a BOM on make and both parts, suppliers and PO lines on buy and both', async () => {
		const { api, create } = await setup();
		const expects = async (procurement: string) => {
			const p = await create({ name: `P-${procurement}`, procurement });
			return (await api('GET', `/parts/${p.id}/detail`)).json.expects;
		};
		expect(await expects('make')).toEqual({ bom: true, suppliers: false, poLines: false });
		expect(await expects('buy')).toEqual({ bom: false, suppliers: true, poLines: true });
		expect(await expects('both')).toEqual({ bom: true, suppliers: true, poLines: true });
	});

	test('data wins over expectation: a buy part with BOM lines still returns them', async () => {
		const { api, create } = await setup();
		const buy = await create({ name: 'Bought', procurement: 'buy' });
		const c = await create({ name: 'C' });
		await api('POST', `/parts/${buy.id}/bom`, { componentId: c.id });
		const d = (await api('GET', `/parts/${buy.id}/detail`)).json;
		expect(d.expects.bom).toBe(false);
		expect(d.bom).toHaveLength(1);
	});

	test('expectation follows procurement edits', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'P', procurement: 'make' });
		await api('PATCH', `/parts/${p.id}`, { procurement: 'buy' });
		expect((await api('GET', `/parts/${p.id}/detail`)).json.expects).toEqual({ bom: false, suppliers: true, poLines: true });
	});
});
