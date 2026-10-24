import { describe, expect, test } from 'bun:test';
import { OpalError } from '@opal/shared';
import { auditLog } from '../../src/db/schema/index.ts';
import { AGENT_ACTIVATION_SETTING, ensurePartsActive } from '../../src/services/parts/lifecycle.ts';
import { registerPartReference } from '../../src/services/parts/references.ts';
import { setup } from './helpers.ts';

describe('part lifecycle', () => {
	test('parts are born draft and the list filters by state', async () => {
		const { api, create, activate } = await setup();
		const a = await create({ name: 'A' });
		const b = await create({ name: 'B' });
		expect(a.state).toBe('draft');
		await activate(b.id);
		const states = async (s: string) => (await api('GET', `/parts?state=${s}`)).json.items.map((p: any) => p.id);
		expect(await states('draft')).toEqual([a.id]);
		expect(await states('active')).toEqual([b.id]);
		expect((await api('GET', '/parts?state=nonsense')).status).toBe(422);
	});

	test('activation records time, user and a default cause', async () => {
		const { call, create, makeUser } = await setup();
		const u = makeUser('ann');
		const p = await create({ name: 'A' });
		const res = await call(u.person, 'POST', `/parts/${p.id}/activate`, {});
		expect(res.status).toBe(200);
		expect(res.json.state).toBe('active');
		expect(res.json.activatedAt).toBeTruthy();
		expect(res.json.activationCause).toBe('manual activation from part page');
		const detail = (await call(u.person, 'GET', `/parts/${p.id}/detail`)).json;
		expect(detail.activatedBy).toBe('ann');
	});

	test('activation takes a custom cause', async () => {
		const { create, activate } = await setup();
		const p = await create({ name: 'A' });
		expect((await activate(p.id, 'released to flight')).activationCause).toBe('released to flight');
	});

	test('activating twice is a conflict', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		await activate(p.id);
		const res = await api('POST', `/parts/${p.id}/activate`, {});
		expect(res.status).toBe(409);
	});

	test('an active part keeps its number and tier but other fields stay editable', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'Locked' });
		await activate(p.id);
		expect((await api('PATCH', `/parts/${p.id}`, { internalPn: 'PN-NEW-001' })).status).toBe(409);
		expect((await api('PATCH', `/parts/${p.id}`, { tier: 2 })).status).toBe(409);
		const renamed = await api('PATCH', `/parts/${p.id}`, { name: 'Renamed' });
		expect(renamed.status).toBe(200);
		expect(renamed.json.name).toBe('Renamed');
	});

	test('sending the current number or tier on an active part is not a change', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		await activate(p.id);
		const res = await api('PATCH', `/parts/${p.id}`, { internalPn: p.internalPn, tier: p.tier, name: 'B' });
		expect(res.status).toBe(200);
	});

	test('an unreferenced draft is deleted, its audit row stays', async () => {
		const { db, api, create } = await setup();
		const p = await create({ name: 'Gone' });
		expect((await api('DELETE', `/parts/${p.id}`)).status).toBe(200);
		expect((await api('GET', `/parts/${p.id}`)).status).toBe(404);
		const actions = db.select().from(auditLog).all().filter((r) => r.entity === 'part').map((r) => r.action);
		expect(actions).toEqual(['create', 'delete']);
	});

	test('a draft that a BOM references cannot be deleted', async () => {
		const { api, create } = await setup();
		const asm = await create({ name: 'Asm' });
		const comp = await create({ name: 'Comp' });
		await api('POST', `/parts/${asm.id}/bom`, { componentId: comp.id });
		const res = await api('DELETE', `/parts/${comp.id}`);
		expect(res.status).toBe(409);
		expect(res.json.message).toContain('used_in_assemblies');
		expect((await api('DELETE', `/parts/${asm.id}`)).status).toBe(409);
	});

	test('a reference from another area blocks the delete', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A' });
		let n = 1;
		registerPartReference({ name: 'test_kits', count: () => n });
		expect((await api('DELETE', `/parts/${p.id}`)).status).toBe(409);
		expect((await api('GET', `/parts/${p.id}/detail`)).json.references).toEqual({ test_kits: 1 });
		n = 0;
		expect((await api('DELETE', `/parts/${p.id}`)).status).toBe(200);
	});

	test('an active part cannot be deleted', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		await activate(p.id);
		const res = await api('DELETE', `/parts/${p.id}`);
		expect(res.status).toBe(409);
		expect(res.json.message).toContain('cannot be deleted');
	});

	test('the part page reports deletable only for an unreferenced draft', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		const d1 = (await api('GET', `/parts/${p.id}/detail`)).json;
		expect(d1).toMatchObject({ deletable: true, references: {}, activatedBy: null });
		await activate(p.id);
		expect((await api('GET', `/parts/${p.id}/detail`)).json.deletable).toBe(false);
	});

	test('an active part becomes obsolete with a cause; a draft cannot', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		expect((await api('POST', `/parts/${p.id}/obsolete`, {})).status).toBe(409);
		await activate(p.id);
		const res = await api('POST', `/parts/${p.id}/obsolete`, { cause: 'superseded' });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ state: 'obsolete', obsoleteCause: 'superseded' });
		expect(res.json.obsoletedAt).toBeTruthy();
		expect((await api('POST', `/parts/${p.id}/obsolete`, {})).status).toBe(409);
		expect((await api('DELETE', `/parts/${p.id}`)).status).toBe(409);
	});

	test('a BOM between draft parts is legal', async () => {
		const { api, create } = await setup();
		const a = await create({ name: 'A' });
		const b = await create({ name: 'B' });
		expect((await api('POST', `/parts/${a.id}/bom`, { componentId: b.id })).status).toBe(200);
	});
});

describe('draft parts are blocked from commitments', () => {
	test('ensurePartsActive names every draft and activates none', async () => {
		const { db, create, activate } = await setup();
		const draft1 = await create({ name: 'D1' });
		const live = await create({ name: 'Live' });
		const draft2 = await create({ name: 'D2' });
		await activate(live.id);
		let err: OpalError | undefined;
		try {
			ensurePartsActive({ db }, [draft1.id, live.id, draft2.id, draft1.id, null], 'creating a purchase order');
		} catch (e) {
			err = e as OpalError;
		}
		expect(err).toBeInstanceOf(OpalError);
		expect(err!.status).toBe(409);
		expect(err!.code).toBe('draft_parts_blocked');
		expect(err!.message).toContain(draft1.internalPn);
		expect(err!.message).toContain(draft2.internalPn);
		expect(err!.message).not.toContain(live.internalPn);
		expect(Object.keys(err!.fields!)).toEqual([`part.${draft1.id}`, `part.${draft2.id}`]);
		expect(() => ensurePartsActive({ db }, [live.id], 'x')).not.toThrow();
		expect(() => ensurePartsActive({ db }, [], 'x')).not.toThrow();
	});
});

describe('activation through an API token', () => {
	test('is refused unless an admin authorised an operator', async () => {
		const { call, create, makeUser } = await setup();
		const u = makeUser('agent-owner');
		const p = await create({ name: 'A' });
		const res = await call(u.token, 'POST', `/parts/${p.id}/activate`, {});
		expect(res.status).toBe(403);
		expect(res.json.message).toContain('disabled');
	});

	test('with an operator, the activation is attributed to the operator and marked', async () => {
		const { call, create, makeUser, setSetting } = await setup();
		const operator = makeUser('olga');
		const agent = makeUser('agent');
		setSetting(AGENT_ACTIVATION_SETTING, String(operator.id));
		const p = await create({ name: 'A' });
		const res = await call(agent.token, 'POST', `/parts/${p.id}/activate`, { cause: 'bench check' });
		expect(res.status).toBe(200);
		expect(res.json.activationCause).toBe('bench check (API token, authorized by olga)');
		expect((await call(operator.person, 'GET', `/parts/${p.id}/detail`)).json.activatedBy).toBe('olga');
	});

	test('bulk activation skips parts that are not drafts', async () => {
		const { api, create, activate } = await setup();
		const draft = await create({ name: 'D' });
		const live = await create({ name: 'L' });
		await activate(live.id);
		const res = await api('POST', '/parts/activate', { partIds: [draft.id, live.id, 999], cause: 'batch' });
		expect(res.status).toBe(200);
		expect(res.json.activated.map((p: any) => p.id)).toEqual([draft.id]);
		expect(res.json.skipped.map((s: any) => s.id)).toEqual([live.id, 999]);
		expect(res.json.activated[0].activationCause).toBe('batch');
	});

	test('bulk activation by a token is refused without an operator', async () => {
		const { call, create, makeUser } = await setup();
		const agent = makeUser('agent');
		const p = await create({ name: 'A' });
		expect((await call(agent.token, 'POST', '/parts/activate', { partIds: [p.id] })).status).toBe(403);
	});
});
