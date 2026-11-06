import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { setup as issueSetup } from '../issues/helpers.ts';
import { makePart, mkPo, setStatus, setup as purchaseSetup } from '../purchasing/helpers.ts';
import { setup as procedureSetup } from '../procedures/helpers.ts';
import { setup as requirementSetup } from '../requirements/helpers.ts';
import { setup as riskSetup } from '../risks/helpers.ts';

beforeAll(() => {
	process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-record-attachments-'));
});

async function upload(app: Hono, ownerType: string, ownerId: number) {
	const form = new FormData();
	form.set('file', new File([`evidence ${Math.random()}`], 'evidence.txt', { type: 'text/plain' }));
	form.set('ownerType', ownerType);
	form.set('ownerId', String(ownerId));
	return app.request('/api/attachments', { method: 'POST', body: form });
}

async function attached(app: Hono, ownerType: string, ownerId: number): Promise<number> {
	const res = await upload(app, ownerType, ownerId);
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: number }).id;
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number }>;

async function expectFrozen(call: Call, id: number) {
	expect((await call('DELETE', `/attachments/${id}`)).status).toBe(409);
	expect((await call('PATCH', `/attachments/${id}`, { note: 'rewritten' })).status).toBe(409);
	expect((await call('PATCH', `/attachments/${id}`, { kind: 'reference' })).status).toBe(409);
}

describe('attachments on an issue', () => {
	test('a closed issue keeps its evidence against anyone, and still takes a new file', async () => {
		const { raise, call, as, app, admin, plain } = await issueSetup();
		const i = await raise();
		const id = await attached(app, 'issue', i.id);
		expect((await call('PATCH', `/issues/${i.id}`, { status: 'closed' })).status).toBe(200);
		await expectFrozen(call, id);
		as(plain);
		await expectFrozen(call, id);
		as({ kind: 'token', userId: plain.id, isAdmin: false, tokenId: 1 });
		await expectFrozen(call, id);
		as(admin);
		expect((await call('GET', `/attachments?ownerType=issue&ownerId=${i.id}`)).body).toHaveLength(1);
		await attached(app, 'issue', i.id);
	});

	test('a pending issue is pencil, and anyone can correct its files', async () => {
		const { raise, call, as, app, plain } = await issueSetup();
		const i = await raise({ containment: 'wo' });
		const id = await attached(app, 'issue', i.id);
		as(plain);
		expect((await call('PATCH', `/attachments/${id}`, { note: 'left side' })).status).toBe(200);
		expect((await call('DELETE', `/attachments/${id}`)).status).toBe(200);
	});

	test('a signed disposition freezes what it saw, and a later file is pencil until review', async () => {
		const { raise, call, sign, app } = await issueSetup();
		const i = await raise({ containment: 'wo' });
		const seen = await attached(app, 'issue', i.id);
		expect((await sign(i.id)).status).toBe(200);
		await expectFrozen(call, seen);
		await Bun.sleep(2);
		const later = await attached(app, 'issue', i.id);
		expect((await call('PATCH', `/attachments/${later}`, { note: 'after the fix' })).status).toBe(200);
		expect((await call('POST', `/issues/${i.id}/review`, {})).status).toBe(200);
		await expectFrozen(call, later);
		await attached(app, 'issue', i.id);
	});

	test('an advisory issue in work keeps its files in pencil, and in review it does not', async () => {
		const { raise, call, app } = await issueSetup();
		const i = await raise();
		const id = await attached(app, 'issue', i.id);
		expect((await call('POST', `/issues/${i.id}/start`, {})).status).toBe(200);
		expect((await call('PATCH', `/attachments/${id}`, { note: 'ok' })).status).toBe(200);
		expect((await call('POST', `/issues/${i.id}/review`, {})).status).toBe(200);
		await expectFrozen(call, id);
	});

	test('a void issue keeps its files and takes no new one', async () => {
		const { raise, call, app } = await issueSetup();
		const i = await raise();
		const id = await attached(app, 'issue', i.id);
		expect((await call('POST', `/issues/${i.id}/void`, { reason: 'raised in error' })).status).toBe(200);
		await expectFrozen(call, id);
		expect((await upload(app, 'issue', i.id)).status).toBe(409);
	});
});

describe('attachments on a purchase order', () => {
	test('a draft is pencil; a placed order keeps its files in every state and takes new ones', async () => {
		const s = await purchaseSetup();
		const p = makePart(s.db);
		const po = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '3', unitCost: '1.5' }] });
		const draft = await attached(s.app, 'purchase', po.id);
		expect((await s.call('DELETE', `/attachments/${draft}`)).status).toBe(200);
		const quote = await attached(s.app, 'purchase', po.id);
		await setStatus(s, po.id, 'ordered');
		await expectFrozen(s.call, quote);
		await attached(s.app, 'purchase', po.id);
		await setStatus(s, po.id, 'cancelled');
		await expectFrozen(s.call, quote);
		await attached(s.app, 'purchase', po.id);
	});
});

describe('attachments on a requirement', () => {
	test('a draft is pencil; a baselined requirement keeps its files and takes new ones', async () => {
		const { req, call, app, baseline } = await requirementSetup();
		const r = await req();
		const first = await attached(app, 'requirement', r.id);
		expect((await call('DELETE', `/attachments/${first}`)).status).toBe(200);
		const kept = await attached(app, 'requirement', r.id);
		await baseline(r.id);
		await expectFrozen(call, kept);
		await attached(app, 'requirement', r.id);
	});

	test('superseded and cancelled requirements take nothing', async () => {
		const { req, call, app, baseline } = await requirementSetup();
		const r = await req();
		const kept = await attached(app, 'requirement', r.id);
		await baseline(r.id);
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		await baseline(rev2.id);
		await expectFrozen(call, kept);
		expect((await upload(app, 'requirement', r.id)).status).toBe(409);
		const c = await req({ title: 'Other' });
		expect((await call('POST', `/requirements/${c.id}/cancel`, { reason: 'dropped' })).status).toBe(200);
		expect((await upload(app, 'requirement', c.id)).status).toBe(409);
	});
});

describe('attachments on a risk', () => {
	test('an open risk is pencil; an accepted one keeps its files and takes new ones', async () => {
		const t = await riskSetup();
		const r = await t.mk();
		const first = await attached(t.app, 'risk', r.id);
		expect((await t.call('DELETE', `/attachments/${first}`)).status).toBe(200);
		const kept = await attached(t.app, 'risk', r.id);
		expect((await t.call('POST', `/risks/${r.id}/accept`, { rationale: 'Within appetite' })).status).toBe(200);
		await expectFrozen(t.call, kept);
		await attached(t.app, 'risk', r.id);
	});

	test('a realized or closed risk keeps its files and takes no new one', async () => {
		const t = await riskSetup();
		const realized = await t.mk();
		const issue = await t.mkIssue();
		const kept = await attached(t.app, 'risk', realized.id);
		const r = await t.call('POST', `/risks/${realized.id}/disposition`, { disposition: 'realized', realizedIssueId: issue.id });
		expect(r.status).toBe(200);
		await expectFrozen(t.call, kept);
		expect((await upload(t.app, 'risk', realized.id)).status).toBe(409);
		const closed = await t.mk();
		const also = await attached(t.app, 'risk', closed.id);
		expect((await t.call('POST', `/risks/${closed.id}/disposition`, { disposition: 'closed', note: 'gone' })).status).toBe(200);
		await expectFrozen(t.call, also);
		expect((await upload(t.app, 'risk', closed.id)).status).toBe(409);
	});
});

describe('attachments on a stock record', () => {
	test('stock keeps its files from receipt and takes a late certificate', async () => {
		const s = await purchaseSetup();
		const p = makePart(s.db);
		const made = await s.call('POST', '/inventory', { partId: p.id, quantity: '2', location: 'A1' });
		expect(made.status).toBeLessThan(300);
		const stockId = made.body.items[0].id;
		const cert = await attached(s.app, 'stock_record', stockId);
		await expectFrozen(s.call, cert);
		await attached(s.app, 'stock_record', stockId);
	});
});

describe('attachments on a procedure template', () => {
	test('a released template stays pencil, and an obsolete one changes nothing until reinstated', async () => {
		const t = await procedureSetup();
		const { id } = await t.published();
		const doc = await attached(t.app, 'procedure', id);
		expect((await t.call('PATCH', `/attachments/${doc}`, { note: 'rev B' })).status).toBe(200);
		expect((await t.call('POST', `/procedures/${id}/obsolete`, { reason: 'replaced' })).status).toBe(200);
		await expectFrozen(t.call, doc);
		expect((await upload(t.app, 'procedure', id)).status).toBe(409);
		expect((await t.call('POST', `/procedures/${id}/reinstate`, { reason: 'back in use' })).status).toBe(200);
		expect((await t.call('DELETE', `/attachments/${doc}`)).status).toBe(200);
	});
});
