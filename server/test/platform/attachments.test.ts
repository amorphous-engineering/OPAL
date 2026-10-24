import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { attachment, auditLog, blob, part } from '../../src/db/schema/index.ts';
import { insert } from '../../src/write.ts';
import { blobPath, purgeOrphanBlobs } from '../../src/services/platform/attachments.ts';
import { setup } from './helpers.ts';

type S = Awaited<ReturnType<typeof setup>>;

async function partId(s: S) {
	return insert(
		{ db: s.db, op: 't', actor: { kind: 'system' } },
		part,
		{ internalPn: `P-${Math.random()}`, name: 'Bolt', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1 }
	).id;
}

function upload(s: S, fields: Record<string, string | File>) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	return s.app.request('/api/attachments', { method: 'POST', body: form });
}

const text = (body: string, name = 'note.txt', type = 'text/plain') => new File([body], name, { type });

describe('attachments', () => {
	test('upload stores the file under its SHA-256 and links it to one owner', async () => {
		const s = await setup();
		const id = await partId(s);
		const res = await upload(s, { file: text('hello'), ownerType: 'part', ownerId: String(id), kind: 'reference' });
		expect(res.status).toBe(201);
		const a = await res.json();
		expect(a).toMatchObject({ filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 5, ownerType: 'part', ownerId: id, kind: 'reference', uploadedByName: 'User 1' });
		expect(a.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
		expect(existsSync(blobPath(a.sha256))).toBe(true);
	});

	test('the same bytes uploaded twice share one blob', async () => {
		const s = await setup();
		const id = await partId(s);
		await upload(s, { file: text('same', 'a.txt'), ownerType: 'part', ownerId: String(id) });
		await upload(s, { file: text('same', 'b.txt'), ownerType: 'part', ownerId: String(id) });
		expect(s.db.select().from(blob).all()).toHaveLength(1);
		expect(s.db.select().from(attachment).all()).toHaveLength(2);
	});

	test('download serves the right content type and Content-Disposition', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: text('hello', 'my note.txt'), ownerType: 'part', ownerId: String(id) })).json();
		const res = await s.app.request(a.href);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain');
		expect(res.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''my%20note.txt");
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await res.text()).toBe('hello');
		const forced = await s.app.request(`${a.href}?download=1`);
		expect(forced.headers.get('content-disposition')).toStartWith('attachment;');
	});

	test('types a browser could run as script download instead of rendering', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: new File(['<svg onload=alert(1)/>'], 'x.svg', { type: 'image/svg+xml' }), ownerType: 'part', ownerId: String(id) })).json();
		const res = await s.app.request(a.href);
		expect(res.headers.get('content-disposition')).toStartWith('attachment;');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
	});

	test('a blob can be fetched by its hash', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: text('by hash'), ownerType: 'part', ownerId: String(id) })).json();
		const res = await s.app.request(`/api/blobs/${a.sha256}`);
		expect(await res.text()).toBe('by hash');
		expect((await s.app.request(`/api/blobs/${'0'.repeat(64)}`)).status).toBe(404);
		expect((await s.app.request('/api/blobs/..%2F..%2Fetc')).status).toBe(404);
	});

	test('a file type off the allowed list is refused', async () => {
		const s = await setup();
		const id = await partId(s);
		const res = await upload(s, { file: text('x', 'a.exe', 'application/x-msdownload'), ownerType: 'part', ownerId: String(id) });
		expect(res.status).toBe(422);
		expect((await res.json()).error).toBe('file_type_not_allowed');
	});

	test('a file over the size limit is refused with 413', async () => {
		const s = await setup();
		const id = await partId(s);
		process.env.OPAL_MAX_UPLOAD_BYTES = '10';
		try {
			const res = await upload(s, { file: text('x'.repeat(11)), ownerType: 'part', ownerId: String(id) });
			expect(res.status).toBe(413);
		} finally {
			delete process.env.OPAL_MAX_UPLOAD_BYTES;
		}
	});

	test('the owner must exist, and the owner type must be a real table', async () => {
		const s = await setup();
		expect((await upload(s, { file: text('x'), ownerType: 'part', ownerId: '999' })).status).toBe(404);
		expect((await upload(s, { file: text('x'), ownerType: 'no_such_table', ownerId: '1' })).status).toBe(422);
		expect((await upload(s, { file: text('x'), ownerType: 'part' })).status).toBe(422);
	});

	test('an unknown kind is refused', async () => {
		const s = await setup();
		const id = await partId(s);
		expect((await upload(s, { file: text('x'), ownerType: 'part', ownerId: String(id), kind: 'weird' })).status).toBe(422);
	});

	test('anonymous callers cannot upload or download', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		expect((await upload(s, { file: text('x'), ownerType: 'part', ownerId: '1' })).status).toBe(401);
		expect((await s.app.request('/api/attachments/1/download')).status).toBe(401);
	});

	test('list filters by owner and kind; update changes kind and note', async () => {
		const s = await setup();
		const a = await partId(s);
		const b = await partId(s);
		const one = await (await upload(s, { file: text('1', '1.txt'), ownerType: 'part', ownerId: String(a), kind: 'closeout' })).json();
		await upload(s, { file: text('2', '2.txt'), ownerType: 'part', ownerId: String(a) });
		await upload(s, { file: text('3', '3.txt'), ownerType: 'part', ownerId: String(b) });
		expect(await (await s.call('GET', `/attachments?ownerType=part&ownerId=${a}`)).json()).toHaveLength(2);
		expect(await (await s.call('GET', `/attachments?ownerType=part&ownerId=${a}&kind=closeout`)).json()).toHaveLength(1);
		const patched = await (await s.call('PATCH', `/attachments/${one.id}`, { kind: 'capture', note: 'torque' })).json();
		expect(patched).toMatchObject({ kind: 'capture', note: 'torque' });
		expect((await s.call('PATCH', `/attachments/${one.id}`, { kind: 'weird' })).status).toBe(422);
	});

	test('delete removes only the link; the blob stays until purged', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: text('keep me'), ownerType: 'part', ownerId: String(id) })).json();
		expect((await s.call('DELETE', `/attachments/${a.id}`)).status).toBe(200);
		expect(s.db.select().from(attachment).all()).toHaveLength(0);
		expect(existsSync(blobPath(a.sha256))).toBe(true);
		expect((await s.app.request(`/api/blobs/${a.sha256}`)).status).toBe(200);
		expect((await s.call('DELETE', `/attachments/${a.id}`)).status).toBe(404);
		// A hash that a snapshot still references is not purged.
		expect(await purgeOrphanBlobs(s.db, [(h) => h === a.sha256])).toBe(0);
		expect(await purgeOrphanBlobs(s.db)).toBe(1);
		expect(existsSync(blobPath(a.sha256))).toBe(false);
	});

	test('a blob linked by a second attachment survives the purge', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: text('shared'), ownerType: 'part', ownerId: String(id) })).json();
		await upload(s, { file: text('shared', 'b.txt'), ownerType: 'part', ownerId: String(id) });
		await s.call('DELETE', `/attachments/${a.id}`);
		expect(await purgeOrphanBlobs(s.db)).toBe(0);
	});

	test('upload and delete leave audit rows', async () => {
		const s = await setup();
		const id = await partId(s);
		const a = await (await upload(s, { file: text('x'), ownerType: 'part', ownerId: String(id) })).json();
		await s.call('DELETE', `/attachments/${a.id}`);
		const rows = s.db.select().from(auditLog).all().filter((r) => r.entity === 'attachment');
		expect(rows.map((r) => [r.action, r.op])).toEqual([['create', 'attachments.upload'], ['delete', 'attachments.delete']]);
	});
});
