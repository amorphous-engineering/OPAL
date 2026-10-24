import { describe, expect, test } from 'bun:test';
import { makePart, mkPo, mkSupplier, setup } from './helpers.ts';

describe('suppliers', () => {
	test('the website must be an http or https URL with a host', async () => {
		const s = await setup();
		for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'http://', 'example.com']) {
			const r = await s.call('POST', '/suppliers', { name: 'W', website: bad });
			expect(r.status).toBe(422);
		}
		expect((await s.call('POST', '/suppliers', { name: 'W', website: 'https://example.com/x' })).status).toBe(201);
	});

	test('a null name or active flag on update is ignored', async () => {
		const s = await setup();
		const sup = await mkSupplier(s, 'Keep Me');
		const r = await s.call('PATCH', `/suppliers/${sup.id}`, { name: null, isActive: null });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ name: 'Keep Me', isActive: true });
	});

	test('a supplier code is unique', async () => {
		const s = await setup();
		await mkSupplier(s, 'A', { code: 'SUP001' });
		const b = await mkSupplier(s, 'B');
		expect((await s.call('POST', '/suppliers', { name: 'C', code: 'SUP001' })).status).toBe(409);
		expect((await s.call('PATCH', `/suppliers/${b.id}`, { code: 'SUP001' })).status).toBe(409);
	});

	test('counts and sort', async () => {
		const s = await setup();
		const b = await mkSupplier(s, 'Bravo');
		await mkSupplier(s, 'Alpha');
		const p = makePart(s.db);
		await s.call('POST', `/suppliers/${b.id}/parts`, { partId: p.id, vendorPn: 'B-1' });
		await mkPo(s, { supplierId: b.id, supplierName: null });
		const items = (await s.call('GET', '/suppliers?sort=name&dir=desc')).body.items;
		expect(items.map((i: { name: string }) => i.name)).toEqual(['Bravo', 'Alpha']);
		expect(items[0]).toMatchObject({ purchaseCount: 1, partCount: 1, deletable: false });
		expect(items[1].deletable).toBe(true);
	});

	test('search and the active filter', async () => {
		const s = await setup();
		await mkSupplier(s, 'Digi', { email: 'sales@digi.example' });
		const off = await mkSupplier(s, 'Mouse');
		await s.call('PATCH', `/suppliers/${off.id}`, { isActive: false });
		expect((await s.call('GET', '/suppliers?q=digi.example')).body.total).toBe(1);
		expect((await s.call('GET', '/suppliers?active=false')).body.items[0].name).toBe('Mouse');
	});

	test('a supplier with orders cannot be deleted; one without can, with its catalog', async () => {
		const s = await setup();
		const used = await mkSupplier(s, 'Used');
		await mkPo(s, { supplierId: used.id, supplierName: null });
		const refused = await s.call('DELETE', `/suppliers/${used.id}`);
		expect(refused.status).toBe(409);
		expect(refused.body.message).toContain('Deactivate');
		const free = await mkSupplier(s, 'Free');
		const p = makePart(s.db);
		await s.call('POST', `/suppliers/${free.id}/parts`, { partId: p.id, vendorPn: 'F' });
		expect((await s.call('DELETE', `/suppliers/${free.id}`)).status).toBe(200);
		expect((await s.call('GET', `/suppliers/${free.id}`)).status).toBe(404);
		expect((await s.call('GET', `/parts/${p.id}/suppliers`)).body).toEqual([]);
	});
});

describe('supplier catalog', () => {
	test('create, list, update and delete an entry', async () => {
		const s = await setup();
		const sup = await mkSupplier(s);
		const p = makePart(s.db);
		const add = await s.call('POST', `/suppliers/${sup.id}/parts`, {
			partId: p.id,
			vendorPn: 'VPN-1',
			isPreferred: true,
			leadTimeDays: 14
		});
		expect(add.status).toBe(200);
		expect(add.body).toMatchObject({ supplierName: 'Acme', partInternalPn: p.internalPn, vendorPn: 'VPN-1', leadTimeDays: 14 });
		expect((await s.call('GET', `/suppliers/${sup.id}/parts`)).body).toHaveLength(1);
		const upd = await s.call('PATCH', `/suppliers/${sup.id}/parts/${add.body.id}`, { vendorPn: 'VPN-2', isPreferred: false });
		expect(upd.body).toMatchObject({ vendorPn: 'VPN-2', isPreferred: false });
		expect((await s.call('DELETE', `/suppliers/${sup.id}/parts/${add.body.id}`)).status).toBe(200);
		expect((await s.call('GET', `/suppliers/${sup.id}/parts`)).body).toEqual([]);
	});

	test('one supplier lists a part once', async () => {
		const s = await setup();
		const sup = await mkSupplier(s);
		const p = makePart(s.db);
		await s.call('POST', `/suppliers/${sup.id}/parts`, { partId: p.id, vendorPn: 'A' });
		const dup = await s.call('POST', `/suppliers/${sup.id}/parts`, { partId: p.id, vendorPn: 'B' });
		expect(dup.status).toBe(409);
		expect(dup.body.message).toContain('already exists');
	});

	test('an unknown part is refused', async () => {
		const s = await setup();
		const sup = await mkSupplier(s);
		expect((await s.call('POST', `/suppliers/${sup.id}/parts`, { partId: 9999, vendorPn: 'A' })).status).toBe(422);
	});

	test('the part side lists every supplier, preferred first', async () => {
		const s = await setup();
		const a = await mkSupplier(s, 'SupplierA');
		const b = await mkSupplier(s, 'SupplierB');
		const p = makePart(s.db);
		await s.call('POST', `/suppliers/${a.id}/parts`, { partId: p.id, vendorPn: 'SA-001' });
		await s.call('POST', `/suppliers/${b.id}/parts`, { partId: p.id, vendorPn: 'SB-002', isPreferred: true });
		const rows = (await s.call('GET', `/parts/${p.id}/suppliers`)).body;
		expect(rows.map((r: { vendorPn: string }) => r.vendorPn)).toEqual(['SB-002', 'SA-001']);
	});

	test('the last unit cost comes from the supplier\'s most recent order line with a cost', async () => {
		const s = await setup();
		const sup = await mkSupplier(s, 'Costly');
		const p = makePart(s.db);
		const e = await s.call('POST', `/suppliers/${sup.id}/parts`, { partId: p.id, vendorPn: 'C-1' });
		expect(e.body.lastUnitCost).toBeNull();
		await mkPo(s, { supplierId: sup.id, supplierName: null, lines: [{ partId: p.id, qtyOrdered: '1', unitCost: '4.25' }] });
		const listed = (await s.call('GET', `/suppliers/${sup.id}/parts`)).body;
		expect(listed[0].lastUnitCost).toBe('4.25');
		expect(listed[0].lastOrderedAt).not.toBeNull();
	});
});
