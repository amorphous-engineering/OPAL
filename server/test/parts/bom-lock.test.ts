import { describe, expect, test } from 'bun:test';
import { execution, procedure, procedureVersion, purchase, purchaseLine, stockRecord } from '../../src/db/schema/index.ts';
import { createTestProject } from '../helpers/project.ts';
import { setup } from './helpers.ts';

const TS = '2026-01-01T00:00:00.000Z';

async function fixture() {
	const s = await setup();
	const asm = await s.create({ name: 'Assembly' });
	const a = await s.create({ name: 'Comp A' });
	const b = await s.create({ name: 'Comp B' });
	const line = (await s.api('POST', `/parts/${asm.id}/bom`, { componentId: a.id, quantity: '2', referenceDesignator: 'U1' })).json;
	await s.api('POST', `/parts/${asm.id}/activate`, {});
	const projectId = createTestProject(s.db).id;
	return { ...s, asm, a, b, line, projectId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function addStock(s: Fixture, partId: number) {
	s.db.insert(stockRecord).values({ partId, opalNumber: 'OPAL-0000000001', location: 'BIN', createdAt: TS, updatedAt: TS }).run();
}

function addVersion(s: Fixture, partId: number, status: 'released' | 'obsolete' = 'released') {
	const proc = s.db
		.insert(procedure)
		.values({ name: 'Build', templateNumber: 'T-0000000001', status, projectId: s.projectId, createdAt: TS, updatedAt: TS } as never)
		.returning()
		.get();
	const version = s.db
		.insert(procedureVersion)
		.values({ procedureId: proc.id, versionNumber: 1, content: { outputs: [{ partId, quantity: '1' }], kit: [] } as never, createdAt: TS })
		.returning()
		.get();
	return { proc, version };
}

function addOrder(s: Fixture, partId: number, orderedAt: string | null) {
	const po = s.db
		.insert(purchase)
		.values({ reference: 'PO-0000000001', supplierName: 'Acme', status: orderedAt ? 'ordered' : 'draft', orderedAt, createdAt: TS, updatedAt: TS } as never)
		.returning()
		.get();
	s.db.insert(purchaseLine).values({ purchaseId: po.id, partId, qtyOrdered: 10000, createdAt: TS, updatedAt: TS } as never).run();
}

async function expectLocked(s: Fixture) {
	const add = await s.api('POST', `/parts/${s.asm.id}/bom`, { componentId: s.b.id });
	const edit = await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' });
	const drop = await s.api('DELETE', `/bom/${s.line.id}`);
	for (const r of [add, edit, drop]) {
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('bom_locked');
	}
	const bom = (await s.api('GET', `/parts/${s.asm.id}/bom`)).json;
	expect(bom).toHaveLength(1);
	expect(bom[0].quantity).toBe('2');
}

describe('a BOM is pencil until copies of the part exist', () => {
	test('an active part with no copies still has an editable BOM', async () => {
		const s = await fixture();
		expect((await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' })).status).toBe(200);
		expect((await s.api('POST', `/parts/${s.asm.id}/bom`, { componentId: s.b.id })).status).toBe(200);
		expect((await s.api('GET', `/parts/${s.asm.id}/detail`)).json.bomLockedBy).toBeNull();
	});

	test('a stock record locks the BOM, and the page says what locked it', async () => {
		const s = await fixture();
		addStock(s, s.asm.id);
		await expectLocked(s);
		expect((await s.api('GET', `/parts/${s.asm.id}/detail`)).json.bomLockedBy).toBe('1 stock record');
	});

	test('a placed order locks the BOM and a draft order does not', async () => {
		const s = await fixture();
		addOrder(s, s.asm.id, null);
		expect((await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' })).status).toBe(200);
		const t = await fixture();
		addOrder(t, t.asm.id, TS);
		await expectLocked(t);
	});

	test('a cut work order locks the BOM and a voided one does not', async () => {
		const s = await fixture();
		const { proc, version } = addVersion(s, s.asm.id);
		s.db
			.insert(execution)
			.values({ procedureId: proc.id, versionId: version.id, woNumber: 'WO-0000000001', status: 'void', projectId: s.projectId, createdAt: TS, updatedAt: TS } as never)
			.run();
		expect((await s.api('GET', `/parts/${s.asm.id}/detail`)).json.bomLockedBy).toBeNull();
		s.db.update(execution).set({ status: 'cut' }).run();
		await expectLocked(s);
	});

	test('a published procedure does not lock the BOM, and the part says which kit stays as published', async () => {
		const s = await fixture();
		const { proc } = addVersion(s, s.asm.id);
		expect((await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' })).status).toBe(200);
		const detail = (await s.api('GET', `/parts/${s.asm.id}/detail`)).json;
		expect(detail.bomLockedBy).toBeNull();
		expect(detail.publishedKits).toEqual([{ procedureId: proc.id, templateNumber: expect.any(String), name: 'Build', versionNumber: 1 }]);
	});

	test('an obsolete part keeps the BOM it was retired with', async () => {
		const s = await fixture();
		await s.api('POST', `/parts/${s.asm.id}/obsolete`, { cause: 'gone' });
		expect((await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' })).status).toBe(409);
	});

	test('stock of a component does not lock the assembly that uses it', async () => {
		const s = await fixture();
		addStock(s, s.a.id);
		expect((await s.api('PATCH', `/bom/${s.line.id}`, { quantity: '3' })).status).toBe(200);
	});
});

describe('revising a part with copies files a new form', () => {
	test('the draft copies the BOM under a new number and the old part does not change', async () => {
		const s = await fixture();
		addStock(s, s.asm.id);
		const res = await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'Wrong fastener' });
		expect(res.status).toBe(200);
		expect(res.json.state).toBe('draft');
		expect(res.json.internalPn).not.toBe(s.asm.internalPn);
		expect(res.json.name).toBe('Assembly');
		const bom = (await s.api('GET', `/parts/${res.json.id}/bom`)).json;
		expect(bom).toHaveLength(1);
		expect(bom[0]).toMatchObject({ componentId: s.a.id, quantity: '2', referenceDesignator: 'U1' });
		// Pencil on the copy, pen on the original.
		expect((await s.api('PATCH', `/bom/${bom[0].id}`, { quantity: '3' })).status).toBe(200);
		await expectLocked(s);
		expect((await s.api('GET', `/parts/${s.asm.id}`)).json.state).toBe('active');
	});

	test('both parts show the revision, with who, when and why', async () => {
		const s = await fixture();
		addStock(s, s.asm.id);
		const next = (await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'Wrong fastener' })).json;
		const oldPart = (await s.api('GET', `/parts/${s.asm.id}/detail`)).json;
		const newPart = (await s.api('GET', `/parts/${next.id}/detail`)).json;
		expect(oldPart.revisedBy).toEqual([expect.objectContaining({ partId: next.id, internalPn: next.internalPn, state: 'draft', reason: 'Wrong fastener', createdAt: expect.any(String) })]);
		expect(oldPart.revises).toBeNull();
		expect(newPart.revises).toEqual(expect.objectContaining({ partId: s.asm.id, internalPn: s.asm.internalPn, state: 'active', reason: 'Wrong fastener' }));
		expect(newPart.revisedBy).toEqual([]);
	});

	test('a revision needs a reason and an active part', async () => {
		const s = await fixture();
		expect((await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: '  ' })).status).toBe(422);
		expect((await s.api('POST', `/parts/${s.a.id}/revise`, { reason: 'x' })).status).toBe(409);
		await s.api('POST', `/parts/${s.asm.id}/obsolete`, { cause: 'gone' });
		expect((await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'x' })).status).toBe(409);
	});

	test('assemblies keep naming the old part until someone changes them', async () => {
		const s = await fixture();
		const top = await s.create({ name: 'Top' });
		await s.api('POST', `/parts/${top.id}/bom`, { componentId: s.asm.id });
		addStock(s, s.asm.id);
		await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'x' });
		expect((await s.api('GET', `/parts/${top.id}/bom`)).json[0].componentId).toBe(s.asm.id);
	});

	test('a revision filed by mistake can be deleted once its draft is emptied, and its number stays taken', async () => {
		const s = await fixture();
		addStock(s, s.asm.id);
		const next = (await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'oops' })).json;
		const [line] = (await s.api('GET', `/parts/${next.id}/bom`)).json;
		await s.api('DELETE', `/bom/${line.id}`);
		expect((await s.api('DELETE', `/parts/${next.id}`)).status).toBe(200);
		expect((await s.api('GET', `/parts/${s.asm.id}/detail`)).json.revisedBy).toEqual([]);
		const again = (await s.api('POST', `/parts/${s.asm.id}/revise`, { reason: 'real' })).json;
		expect(again.internalPn).not.toBe(next.internalPn);
	});
});
