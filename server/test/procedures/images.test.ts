import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { attachment, blob, stepImage } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function fx() {
	const s = await setup();
	const p = await s.proc('Imgs');
	const st = await s.step(p.id, 'Step');
	return { ...s, pid: p.id as number, st };
}

describe('step images', () => {
	test('upload stores the file in the blob store and links it to the step', async () => {
		const s = await fx();
		const up = await s.upload(s.pid, s.st.id, s.png(), 'wiring diagram');
		expect(up.status).toBe(201);
		expect(up.json).toMatchObject({ caption: 'wiring diagram', position: 0, filename: 'x.png' });
		expect(up.json.sha256).toMatch(/^[0-9a-f]{64}$/);
		const att = s.db.select().from(attachment).where(eq(attachment.id, up.json.attachmentId)).get()!;
		expect(att).toMatchObject({ ownerType: 'procedure_step', ownerId: s.st.id, kind: 'step_image' });
		expect(s.db.select().from(blob).all()).toHaveLength(1);
		const listed = await s.ok('GET', `/procedures/${s.pid}/steps/${s.st.id}/images`);
		expect(listed.map((i: any) => i.caption)).toEqual(['wiring diagram']);
	});

	test('only image files are accepted', async () => {
		const s = await fx();
		const r = await s.upload(s.pid, s.st.id, new File(['hello'], 'n.txt', { type: 'text/plain' }));
		expect(r.status).toBe(422);
	});

	test('reorder sets the display order and refuses a partial list', async () => {
		const s = await fx();
		const ids: number[] = [];
		for (const name of ['one', 'two', 'three']) ids.push((await s.upload(s.pid, s.st.id, s.png(), name)).json.id);
		const r = await s.call('POST', `/procedures/${s.pid}/steps/${s.st.id}/images/reorder`, { imageIds: [ids[2], ids[0], ids[1]] });
		expect(r.json.map((i: any) => i.caption)).toEqual(['three', 'one', 'two']);
		expect((await s.draft(s.pid))[0].images.map((i: any) => i.caption)).toEqual(['three', 'one', 'two']);
		const bad = await s.call('POST', `/procedures/${s.pid}/steps/${s.st.id}/images/reorder`, { imageIds: ids.slice(0, 2) });
		expect(bad.status).toBe(422);
	});

	test('a caption can be changed and cleared', async () => {
		const s = await fx();
		const up = await s.upload(s.pid, s.st.id, s.png(), 'old');
		const base = `/procedures/${s.pid}/steps/${s.st.id}/images/${up.json.id}`;
		expect((await s.ok('PATCH', base, { caption: 'new' })).caption).toBe('new');
		expect((await s.ok('PATCH', base, { caption: null })).caption).toBeNull();
	});

	test('removing an image closes the order and keeps the blob', async () => {
		const s = await fx();
		const a = (await s.upload(s.pid, s.st.id, s.png(), 'a')).json;
		const b = (await s.upload(s.pid, s.st.id, s.png(), 'b')).json;
		await s.ok('DELETE', `/procedures/${s.pid}/steps/${s.st.id}/images/${a.id}`);
		const left = await s.ok('GET', `/procedures/${s.pid}/steps/${s.st.id}/images`);
		expect(left.map((i: any) => [i.caption, i.position])).toEqual([['b', 0]]);
		expect(s.db.select().from(blob).where(eq(blob.sha256, a.sha256)).all()).toHaveLength(1);
		expect(b.position).toBe(1);
	});

	test('duplicating a step copies its images as new attachments of the same blobs', async () => {
		const s = await fx();
		const up = (await s.upload(s.pid, s.st.id, s.png(), 'cap')).json;
		const copy = (await s.call('POST', `/procedures/${s.pid}/steps/${s.st.id}/duplicate`)).json;
		expect(copy.images).toHaveLength(1);
		expect(copy.images[0]).toMatchObject({ sha256: up.sha256, caption: 'cap' });
		expect(copy.images[0].attachmentId).not.toBe(up.attachmentId);
		expect(s.db.select().from(blob).all()).toHaveLength(1);
	});

	test('deleting a step removes its image links but the blob stays', async () => {
		const s = await fx();
		const up = (await s.upload(s.pid, s.st.id, s.png())).json;
		await s.ok('DELETE', `/procedures/${s.pid}/steps/${s.st.id}`);
		expect(s.db.select().from(stepImage).all()).toHaveLength(0);
		expect(s.db.select().from(attachment).where(eq(attachment.id, up.attachmentId)).all()).toHaveLength(0);
		expect(s.db.select().from(blob).where(eq(blob.sha256, up.sha256)).all()).toHaveLength(1);
	});

	test('reference documents are attachments of the procedure', async () => {
		const s = await fx();
		const form = new FormData();
		form.set('file', new File(['%PDF-fake'], 'drawing.pdf', { type: 'application/pdf' }));
		form.set('ownerType', 'procedure');
		form.set('ownerId', String(s.pid));
		form.set('kind', 'reference');
		expect((await s.app.request('/api/attachments', { method: 'POST', body: form })).status).toBe(201);
		const docs = await s.ok('GET', `/attachments?ownerType=procedure&ownerId=${s.pid}&kind=reference`);
		expect(docs.map((d: any) => d.filename)).toEqual(['drawing.pdf']);
	});

	test('a clone copies the images of the draft', async () => {
		const s = await fx();
		const up = (await s.upload(s.pid, s.st.id, s.png(), 'cap')).json;
		const clone = (await s.call('POST', `/procedures/${s.pid}/clone`, {})).json;
		const imgs = (await s.draft(clone.id))[0].images;
		expect(imgs).toHaveLength(1);
		expect(imgs[0].sha256).toBe(up.sha256);
	});
});
