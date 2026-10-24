import { describe, expect, test } from 'bun:test';
import { zProcedureSnapshot } from '@opal/shared';
import { eq } from 'drizzle-orm';
import { attachment, procedureVersion } from '../../src/db/schema/index.ts';
import { snapshotFromLegacy } from '../../src/services/procedures/snapshot.ts';
import { versionForExecution, versionHoldsBlob } from '../../src/services/procedures/versions.ts';
import { referenceCounts } from '../../src/services/parts/references.ts';
import { setup } from './helpers.ts';

describe('publishing', () => {
	test('publish freezes the draft as version 1 and releases the procedure', async () => {
		const s = await setup();
		const p = await s.proc('V');
		await s.step(p.id, 'Step 1');
		await s.step(p.id, 'Step 2');
		const v = (await s.call('POST', `/procedures/${p.id}/publish`, {})).json;
		expect(v).toMatchObject({ versionNumber: 1, stepCount: 2, isCurrent: true, createdByName: 'Author', changeNote: null });
		const after = await s.ok('GET', `/procedures/${p.id}`);
		expect(after).toMatchObject({ status: 'released', currentVersionId: v.id, currentVersionNumber: 1 });
	});

	test('a procedure with no steps cannot be published', async () => {
		const s = await setup();
		const p = await s.proc('Empty');
		const r = await s.call('POST', `/procedures/${p.id}/publish`, {});
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('empty_procedure');
	});

	test('versions list newest first with the change note', async () => {
		const s = await setup();
		const p = await s.proc('N');
		await s.step(p.id, 'Only');
		const v1 = (await s.call('POST', `/procedures/${p.id}/publish`, { changeNote: '  first cut ' })).json;
		expect(v1.changeNote).toBe('first cut');
		const v2 = (await s.call('POST', `/procedures/${p.id}/publish`, {})).json;
		expect(v2).toMatchObject({ versionNumber: 2, changeNote: null });
		const listed = await s.ok('GET', `/procedures/${p.id}/versions`);
		expect(listed.map((v: any) => [v.versionNumber, v.isCurrent])).toEqual([[2, true], [1, false]]);
		expect(listed[1].changeNote).toBe('first cut');
	});

	test('draft parts in the kit, step kit or outputs block publish and name the parts', async () => {
		const s = await setup();
		const p = await s.proc('Parted');
		const st = await s.step(p.id, 'Do');
		const draftPart = await s.part('Draft thing', false);
		await s.ok('POST', `/procedures/${p.id}/steps/${st.id}/kit`, { partId: draftPart.id, quantity: '1' });
		const blocked = await s.call('POST', `/procedures/${p.id}/publish`, {});
		expect(blocked.status).toBe(409);
		expect(blocked.json.error).toBe('draft_parts_blocked');
		expect(blocked.json.message).toContain(draftPart.internalPn);
		await s.ok('POST', `/parts/${draftPart.id}/activate`, { cause: 'test' });
		expect((await s.call('POST', `/procedures/${p.id}/publish`, {})).status).toBe(200);
	});

	test('the snapshot matches the shared schema and holds everything execution needs', async () => {
		const s = await setup();
		const p = await s.proc('Full', { description: 'desc', procedureType: 'build' });
		const wc = await s.ok('POST', '/workcenters', { name: 'Bench', code: 'B1' });
		const { op1, a, op2 } = await s.tree(p.id);
		const screw = await s.part('Screw');
		const asm = await s.part('Asm');
		await s.ok('PATCH', `/procedures/${p.id}/steps/${a.id}`, {
			instructions: 'Torque it',
			dataSchema: { fields: [{ name: 'torque', type: 'number', unit: 'Nm' }] },
			callouts: [{ kind: 'caution', text: 'hot' }],
			estimatedDurationMinutes: 10,
			workcenterId: wc.id,
			signoffs: [{ role: 'Quality' }]
		});
		await s.ok('PATCH', `/procedures/${p.id}/steps/${op1.id}`, { strictSequence: true });
		await s.ok('POST', `/procedures/${p.id}/steps/${a.id}/kit`, { partId: screw.id, quantity: '4', usage: 'tooling' });
		await s.ok('PUT', `/procedures/${p.id}/steps/${op2.id}/dependencies`, { dependsOn: [op1.id] });
		await s.ok('POST', `/procedures/${p.id}/kit`, { partId: screw.id, quantity: '8' });
		await s.ok('POST', `/procedures/${p.id}/outputs`, { partId: asm.id, quantity: '1' });
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const detail = await s.ok('GET', `/procedures/versions/${v.id}`);
		const snap = zProcedureSnapshot.parse(detail.snapshot);
		expect(snap.procedure).toEqual({ templateNumber: 'T-0001', projectId: s.proj.id, name: 'Full', description: 'desc', procedureType: 'build' });
		expect(snap.steps.map((x) => [x.id, x.order, x.number, x.level, x.parentId])).toEqual([
			[op1.id, 1, '1', 0, null], [a.id, 2, '1.1', 1, op1.id], [(await s.draft(p.id))[2].id, 3, '1.2', 1, op1.id], [op2.id, 4, '2', 0, null], [(await s.draft(p.id))[4].id, 5, '2.1', 1, op2.id]
		]);
		const sa = snap.steps[1]!;
		expect(sa).toMatchObject({
			instructions: 'Torque it',
			dataSchema: { fields: [{ name: 'torque', type: 'number', unit: 'Nm' }] },
			callouts: [{ kind: 'caution', text: 'hot' }],
			estimatedDurationMinutes: 10,
			workcenterId: wc.id,
			signoffs: [{ label: 'Primary buyoff', role: 'Quality' }],
			kit: [{ partId: screw.id, quantity: '4', usage: 'tooling', notes: null }]
		});
		expect(snap.steps[0]!.strictSequence).toBe(true);
		expect(snap.steps[3]!.dependsOn).toEqual([op1.id]);
		expect(snap.kit).toEqual([{ partId: screw.id, quantity: '8' }]);
		expect(snap.outputs).toEqual([{ partId: asm.id, quantity: '1' }]);
		expect(detail.parts.map((x: any) => x.id).sort()).toEqual([screw.id, asm.id].sort());
		expect(detail).toMatchObject({ procedureTemplateNumber: 'T-0001', procedureName: 'Full', procedureType: 'build', isCurrent: true });
	});

	test('a published version never changes when the draft or the procedure does', async () => {
		const s = await setup();
		const { id, version } = await s.published('Frozen', ['One', 'Two']);
		const before = (await s.ok('GET', `/procedures/versions/${version.id}`)).snapshot;
		const d = await s.draft(id);
		await s.ok('PATCH', `/procedures/${id}/steps/${d[0].id}`, { title: 'Changed' });
		await s.ok('DELETE', `/procedures/${id}/steps/${d[1].id}`);
		await s.ok('PATCH', `/procedures/${id}`, { name: 'Renamed' });
		expect((await s.ok('GET', `/procedures/versions/${version.id}`)).snapshot).toEqual(before);
	});

	test('a part that a version names cannot be deleted', async () => {
		const s = await setup();
		const p = await s.proc('Names a part');
		await s.step(p.id, 'x');
		const bolt = await s.part('Bolt');
		const k = await s.ok('POST', `/procedures/${p.id}/kit`, { partId: bolt.id, quantity: '1' });
		await s.ok('POST', `/procedures/${p.id}/publish`, {});
		await s.ok('DELETE', `/procedures/${p.id}/kit/${k.id}`);
		expect(referenceCounts({ db: s.db }, bolt.id)).toEqual({ procedure_versions: 1 });
	});
});

describe('unpublished changes', () => {
	test('null before the first publish, false right after, true after an edit', async () => {
		const s = await setup();
		const fresh = await s.proc('Fresh');
		expect(fresh.unpublishedChanges).toBeNull();
		const { id } = await s.published('Flagged');
		expect((await s.ok('GET', `/procedures/${id}`)).unpublishedChanges).toBe(false);
		await s.step(id, 'C');
		expect((await s.ok('GET', `/procedures/${id}`)).unpublishedChanges).toBe(true);
	});

	test('restoring the version clears the flag', async () => {
		const s = await setup();
		const { id, version } = await s.published('Restorable');
		await s.step(id, 'Extra');
		const r = await s.call('POST', `/procedures/${id}/versions/${version.id}/restore`);
		expect(r.status).toBe(200);
		expect(r.json.unpublishedChanges).toBe(false);
		expect(await s.numbers(id)).toEqual([['1', 'A'], ['2', 'B']]);
	});

	test('restore brings every step id, kit line, dependency, image and output back', async () => {
		const s = await setup();
		const p = await s.proc('Round trip');
		const { op1, op2, a } = await s.tree(p.id);
		const nut = await s.part('Nut');
		const asm = await s.part('Asm');
		await s.ok('POST', `/procedures/${p.id}/steps/${a.id}/kit`, { partId: nut.id, quantity: '2' });
		await s.ok('POST', `/procedures/${p.id}/kit`, { partId: nut.id, quantity: '2' });
		await s.ok('POST', `/procedures/${p.id}/outputs`, { partId: asm.id });
		await s.ok('PUT', `/procedures/${p.id}/steps/${op2.id}/dependencies`, { dependsOn: [op1.id] });
		await s.upload(p.id, a.id, s.png(), 'cap');
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const published = await s.draft(p.id);
		// Wreck the draft, then restore.
		for (const st of published.filter((x) => x.parentId === null)) await s.ok('DELETE', `/procedures/${p.id}/steps/${st.id}`);
		await s.ok('POST', `/procedures/${p.id}/versions/${v.id}/restore`);
		const restored = await s.draft(p.id);
		expect(restored.map((x) => x.id)).toEqual(published.map((x) => x.id));
		expect(restored.map((x) => x.dependsOn)).toEqual(published.map((x) => x.dependsOn));
		expect(restored.find((x) => x.id === a.id).kit[0].partId).toBe(nut.id);
		expect(restored.find((x) => x.id === a.id).images.map((i: any) => i.caption)).toEqual(['cap']);
		expect(await s.ok('GET', `/procedures/${p.id}/kit`)).toHaveLength(1);
		expect(await s.ok('GET', `/procedures/${p.id}/outputs`)).toHaveLength(1);
		expect((await s.ok('GET', `/procedures/${p.id}`)).unpublishedChanges).toBe(false);
	});

	test('restore keeps the status and current version', async () => {
		const s = await setup();
		const { id, version } = await s.published('Keep');
		await s.ok('PATCH', `/procedures/${id}`, { status: 'obsolete' });
		const r = (await s.call('POST', `/procedures/${id}/versions/${version.id}/restore`)).json;
		expect(r).toMatchObject({ status: 'obsolete', currentVersionId: version.id });
	});

	test('a version of another procedure cannot be restored', async () => {
		const s = await setup();
		const a = await s.published('A');
		const b = await s.published('B');
		expect((await s.call('POST', `/procedures/${a.id}/versions/${b.version.id}/restore`)).status).toBe(404);
	});
});

describe('diff', () => {
	test('a step, kit and name change show up with their old and new values', async () => {
		const s = await setup();
		const { id, version: v1 } = await s.published('Diffed', ['Prep', 'Run']);
		const run = (await s.draft(id))[1];
		await s.ok('PATCH', `/procedures/${id}/steps/${run.id}`, { signoffs: [{ role: null }, { role: null }] });
		await s.step(id, 'Clean');
		const glue = await s.part('Glue');
		await s.ok('POST', `/procedures/${id}/kit`, { partId: glue.id, quantity: '2' });
		await s.ok('PATCH', `/procedures/${id}`, { name: 'Diffed 2' });
		const v2 = (await s.call('POST', `/procedures/${id}/publish`, { changeNote: 'tweaks' })).json;
		const d = (await s.call('GET', `/procedures/${id}/versions/${v1.id}/diff/${v2.id}`)).json;
		expect(d.versionA.versionNumber).toBe(1);
		expect(d.versionB.versionNumber).toBe(2);
		expect([d.added, d.modified, d.unchanged, d.removed]).toEqual([1, 1, 1, 0]);
		const by = Object.fromEntries(d.steps.map((x: any) => [x.number, x]));
		expect(by['2'].changedFields).toEqual(['signoffs']);
		expect(by['2'].changes.signoffs.b).toHaveLength(2);
		expect(by['3'].status).toBe('added');
		expect(d.kit).toEqual([{ partId: glue.id, internalPn: glue.internalPn, name: 'Glue', status: 'added', quantityA: null, quantityB: '2' }]);
		expect(d.procedureChanges).toEqual([{ field: 'name', a: 'Diffed', b: 'Diffed 2' }]);
	});

	test('a version of another procedure is not found', async () => {
		const s = await setup();
		const a = await s.published('A');
		const b = await s.published('B');
		expect((await s.call('GET', `/procedures/${a.id}/versions/${a.version.id}/diff/${b.version.id}`)).status).toBe(404);
	});

	test('a version against itself has no differences', async () => {
		const s = await setup();
		const a = await s.published('A');
		const d = (await s.call('GET', `/procedures/${a.id}/versions/${a.version.id}/diff/${a.version.id}`)).json;
		expect([d.modified, d.added, d.removed]).toEqual([0, 0, 0]);
	});

	test('dependencies compare by the step numbers they point at', async () => {
		const s = await setup();
		const p = await s.proc('Deps');
		const o1 = await s.step(p.id, 'one');
		const o2 = await s.step(p.id, 'two');
		const v1 = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		await s.ok('PUT', `/procedures/${p.id}/steps/${o2.id}/dependencies`, { dependsOn: [o1.id] });
		const v2 = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const d = (await s.call('GET', `/procedures/${p.id}/versions/${v1.id}/diff/${v2.id}`)).json;
		expect(d.steps.find((x: any) => x.number === '2').changes.dependsOn).toEqual({ a: [], b: ['1'] });
	});
});

describe('images in snapshots', () => {
	test('a snapshot holds an image by blob hash and survives the image being unlinked', async () => {
		const s = await setup();
		const p = await s.proc('Imaged');
		const st = await s.step(p.id, 'Look');
		const up = await s.upload(p.id, st.id, s.png(), 'front');
		expect(up.status).toBe(201);
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const snap = (await s.ok('GET', `/procedures/versions/${v.id}`)).snapshot;
		expect(snap.steps[0].images).toEqual([{ sha256: up.json.sha256, filename: 'x.png', caption: 'front' }]);
		await s.ok('DELETE', `/procedures/${p.id}/steps/${st.id}/images/${up.json.id}`);
		expect(s.db.select().from(attachment).where(eq(attachment.id, up.json.attachmentId)).all()).toHaveLength(0);
		expect((await s.ok('GET', `/procedures/versions/${v.id}`)).snapshot.steps[0].images[0].sha256).toBe(up.json.sha256);
		const res = await s.app.request(`/api/blobs/${up.json.sha256}`);
		expect(res.status).toBe(200);
		expect(versionHoldsBlob(s.db)(up.json.sha256)).toBe(true);
		expect(versionHoldsBlob(s.db)('0'.repeat(64))).toBe(false);
	});

	test('inline markdown images become blob links in the snapshot', async () => {
		const s = await setup();
		const p = await s.proc('Inline');
		const form = new FormData();
		form.set('file', s.png());
		form.set('ownerType', 'procedure');
		form.set('ownerId', String(p.id));
		form.set('kind', 'inline');
		const up = await (await s.app.request('/api/attachments', { method: 'POST', body: form })).json();
		await s.step(p.id, 'Read', { instructions: `See ![fig](/api/attachments/${up.id}/download) and [x](/api/attachments/999/download)` });
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const text = (await s.ok('GET', `/procedures/versions/${v.id}`)).snapshot.steps[0].instructions;
		expect(text).toBe(`See ![fig](/api/blobs/${up.sha256}) and [x](/api/attachments/999/download)`);
	});
});

describe('qr and print data', () => {
	test('the QR code is an SVG for the given URL', async () => {
		const s = await setup();
		const { version } = await s.published('QR');
		const r = await s.app.request(`/api/procedures/versions/${version.id}/qr?url=${encodeURIComponent('http://x/procedures/versions/1')}`);
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toStartWith('image/svg+xml');
		expect(await r.text()).toContain('<svg');
		expect((await s.call('GET', '/procedures/versions/99999/qr?url=x')).status).toBe(404);
	});

	test('the version view carries what the print view needs', async () => {
		const s = await setup();
		const { version } = await s.published('Print');
		const v = (await s.call('GET', `/procedures/versions/${version.id}`)).json;
		expect(v.snapshot.steps).toHaveLength(2);
		expect(v.procedureTemplateNumber).toBe('T-0001');
		expect((await s.call('GET', '/procedures/versions/9999')).status).toBe(404);
	});
});

describe('for the execution area', () => {
	test('an execution runs the current version of a released procedure', async () => {
		const s = await setup();
		const { id, version } = await s.published('Run');
		expect(versionForExecution(s.db ? { db: s.db } : ({} as never), id).id).toBe(version.id);
	});

	test('an obsolete or unpublished procedure cannot be run', async () => {
		const s = await setup();
		const { id } = await s.published('Retired');
		await s.ok('PATCH', `/procedures/${id}`, { status: 'obsolete' });
		expect(() => versionForExecution({ db: s.db }, id)).toThrow(/obsolete/);
		await s.ok('PATCH', `/procedures/${id}`, { status: 'released' });
		expect(versionForExecution({ db: s.db }, id).versionNumber).toBe(1);
		const draftOnly = await s.proc('Draft');
		expect(() => versionForExecution({ db: s.db }, draftOnly.id)).toThrow(/no published version/);
	});

	test('a version is immutable in the table: rows are only inserted', async () => {
		const s = await setup();
		await s.published('Rows');
		const rows = s.db.select().from(procedureVersion).all();
		expect(rows).toHaveLength(1);
	});
});

describe('legacy snapshot conversion', () => {
	test('legacy content becomes a snapshot with ids, effective sign-offs and blob hashes', () => {
		const snap = snapshotFromLegacy(
			{
				procedure_name: 'Old',
				procedure_description: null,
				steps: [
					{ id: 10, order: 1, step_number: '1', level: 0, parent_step_id: null, title: 'OP', requires_signoff: true, required_role: 'QE', depends_on: [], images: [{ attachment_id: 5, caption: 'c' }, { attachment_id: 6 }] },
					{ id: 11, order: 2, step_number: '1.1', level: 1, parent_step_id: 10, title: 'Sub', caution: 'HOT', step_kit: [{ part_id: 3, quantity_required: 2.5, usage_type: 'tooling' }] },
					{ id: 12, order: 3, step_number: '2', level: 0, parent_step_id: null, title: 'Two', requires_signoff: true, required_role: 'QE', depends_on: [1] }
				],
				kit_items: [{ part_id: 3, quantity_required: 8 }],
				output_items: [{ part_id: 4, quantity_produced: 1 }]
			},
			{ templateNumber: 'T-0007', projectId: 1, procedureType: 'op' },
			(id) => (id === 5 ? { sha256: 'a'.repeat(64), filename: 'p.png' } : null)
		);
		expect(() => zProcedureSnapshot.parse(snap)).not.toThrow();
		expect(snap.steps[0]!.signoffs).toEqual([{ label: 'Primary buyoff', role: 'QE' }]);
		expect(snap.steps[0]!.images).toEqual([{ sha256: 'a'.repeat(64), filename: 'p.png', caption: 'c' }]);
		expect(snap.steps[1]!.callouts).toEqual([{ kind: 'caution', text: 'HOT' }]);
		expect(snap.steps[1]!.kit).toEqual([{ partId: 3, quantity: '2.5', usage: 'tooling', notes: null }]);
		expect(snap.steps[2]!.signoffs).toEqual([{ label: 'Primary buyoff', role: 'QE' }, { label: 'Secondary buyoff', role: null }]);
		expect(snap.steps[2]!.dependsOn).toEqual([10]);
		expect(snap.kit).toEqual([{ partId: 3, quantity: '8' }]);
	});
});
