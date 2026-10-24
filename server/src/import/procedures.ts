/**
 * master_procedure, procedure_step, step_dependency, step_image, kit, step_kit,
 * procedure_output, procedure_version.
 */
import { KIT_USAGES, PROCEDURE_TYPES, type ProcedureSnapshot, type ProcedureCallout } from '@opal/shared';
import {
	kitItem,
	procedure,
	procedureOutput,
	procedureStep,
	procedureVersion,
	stepDependency,
	stepImage
} from '../db/schema/index.ts';
import { type LegacyContent, snapshotFromLegacy } from '../services/procedures/snapshot.ts';
import { effectiveSignoffs } from '../services/procedures/signoffs.ts';
import { type BlobMap } from './attachments.ts';
import {
	type ImportCtx,
	type Row,
	bool,
	fail,
	insertRows,
	json,
	keep,
	legacyQty,
	num,
	oneOf,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

const INLINE_LINK = /\/api\/attachments\/(\d+)\/download/g;

/** A snapshot must not depend on an attachment row: inline links become blob links. */
function freezeLinks(text: string | null, blobs: BlobMap): string | null {
	if (!text) return text;
	return text.replace(INLINE_LINK, (whole, id) => {
		const b = blobs.get(Number(id));
		return b ? `/api/blobs/${b.sha256}` : whole;
	});
}

function status(c: ImportCtx, r: Row): 'draft' | 'released' | 'obsolete' {
	if (r.deleted_at) return 'obsolete';
	const s = String(r.status);
	if (s === 'draft') return 'draft';
	if (s === 'active') return 'released';
	if (s === 'deprecated') return 'obsolete';
	warn(c, `master_procedure ${Number(r.id)}: status "${s}" is not valid, used "draft"`);
	return 'draft';
}

export function importProcedures(c: ImportCtx, blobs: BlobMap): void {
	const masters = readTable(c, 'master_procedure', ['id', 'template_number', 'name', 'description', 'procedure_type', 'status', 'current_version_id', 'created_at', 'updated_at', 'deleted_at']);
	const versions = readTable(c, 'procedure_version', ['id', 'procedure_id', 'version_number', 'content', 'created_by_id', 'created_at']);
	const versionIds = new Set(versions.map((v) => Number(v.id)));
	const typeOf = new Map<number, 'op' | 'build'>();
	const numberOf = new Map<number, string>();
	const procRows = masters.map((r) => {
		const id = Number(r.id);
		const procedureType = oneOf(c, r.procedure_type, PROCEDURE_TYPES, 'op', `master_procedure ${id} procedure_type`);
		typeOf.set(id, procedureType);
		numberOf.set(id, String(r.template_number));
		return {
			id,
			templateNumber: String(r.template_number),
			projectId: c.projectId,
			name: String(r.name),
			description: str(r.description),
			procedureType,
			status: status(c, r),
			currentVersionId: r.current_version_id && versionIds.has(Number(r.current_version_id)) ? Number(r.current_version_id) : null,
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'procedure', insertRows(c, 'master_procedure', procedure, procRows));

	// ---- steps
	const steps = readTable(c, 'procedure_step', ['id', 'procedure_id', 'parent_step_id', 'order', 'step_number', 'level', 'title', 'instructions', 'required_data_schema', 'is_contingency', 'requires_signoff', 'signoffs', 'estimated_duration_minutes', 'required_role', 'callouts', 'strict_sequence', 'workcenter_id', 'created_at', 'updated_at'], '"order"');
	const live = steps.filter((s) => c.ids.procedure!.has(Number(s.procedure_id)));
	const hasKids = new Set(live.map((s) => num(s.parent_step_id)).filter((x): x is number => x !== null));
	const sibling = new Map<string, number>();
	const stepRows = [...live].sort((a, b) => Number(a.order) - Number(b.order) || Number(a.id) - Number(b.id)).map((r) => {
		const id = Number(r.id);
		const parent = num(r.parent_step_id);
		const contingency = parent === null && bool(r.is_contingency);
		const group = `${Number(r.procedure_id)}/${parent ?? 'top'}/${parent === null ? contingency : ''}`;
		const position = sibling.get(group) ?? 0;
		sibling.set(group, position + 1);
		const explicit = json<{ role?: string | null }[]>(r.signoffs);
		const kids = hasKids.has(id);
		const role = str(r.required_role);
		const requires = bool(r.requires_signoff);
		const stored = Array.isArray(explicit)
			? explicit.map((x) => ({ role: x.role ?? null }))
			: kids ? (requires ? [{ role }] : []) : requires ? [{ role }, { role: null }] : [{ role }];
		const schema = json<{ fields?: unknown[] }>(r.required_data_schema);
		const callouts = json<ProcedureCallout[]>(r.callouts);
		return {
			id,
			procedureId: Number(r.procedure_id),
			parentStepId: parent,
			position,
			isContingency: contingency,
			title: String(r.title),
			instructions: str(r.instructions),
			dataSchema: schema?.fields?.length ? schema : null,
			signoffs: effectiveSignoffs(stored, kids).map((s) => ({ role: s.role })),
			estimatedDurationMinutes: num(r.estimated_duration_minutes),
			callouts: Array.isArray(callouts) ? callouts.map((x) => ({ kind: x.kind, text: x.text })) : [],
			strictSequence: bool(r.strict_sequence),
			workcenterId: ref(c, 'workcenter', r.workcenter_id, `procedure_step ${id} workcenter_id`),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'procedure_step', insertRows(c, 'procedure_step', procedureStep, stepRows));
	const stepIds = c.ids.procedure_step!;

	const deps = readTable(c, 'step_dependency', ['id', 'step_id', 'depends_on_step_id', 'created_at']);
	insertRows(c, 'step_dependency', stepDependency, keep(c, 'step_dependency', deps, (r) =>
		stepIds.has(Number(r.step_id)) && stepIds.has(Number(r.depends_on_step_id)) ? null : 'a step is not imported')
		.map((r) => ({ id: Number(r.id), stepId: Number(r.step_id), dependsOnStepId: Number(r.depends_on_step_id), createdAt: tsReq(r.created_at) })));

	// ---- step images: the attachment row already exists (see importAttachments)
	const images = readTable(c, 'step_image', ['id', 'step_id', 'attachment_id', 'caption', 'position', 'created_at']);
	const usedAttachment = new Set<number>();
	insertRows(c, 'step_image', stepImage, images.flatMap((r) => {
		const id = Number(r.id);
		const att = Number(r.attachment_id);
		if (!stepIds.has(Number(r.step_id)) || !c.ids.attachment?.has(att)) {
			fail(c, 'step_image', id, 'step or attachment is not imported');
			return [];
		}
		if (usedAttachment.has(att)) {
			fail(c, 'step_image', id, `attachment ${att} is already the image of another step`);
			return [];
		}
		usedAttachment.add(att);
		return [{ id, stepId: Number(r.step_id), attachmentId: att, caption: str(r.caption), position: Number(r.position), createdAt: tsReq(r.created_at) }];
	}));

	// ---- parts a procedure or a step needs
	const kit = readTable(c, 'kit', ['id', 'procedure_id', 'part_id', 'quantity_required', 'created_at', 'updated_at']);
	const stepKit = readTable(c, 'step_kit', ['id', 'step_id', 'part_id', 'quantity_required', 'usage_type', 'notes', 'created_at', 'updated_at']);
	// kit and step_kit have separate id spaces; the new table has one, so step_kit ids follow.
	const base = Math.max(0, ...kit.map((k) => Number(k.id)));
	const seenProc = new Set<string>();
	const kitRows: Record<string, unknown>[] = [];
	for (const r of kit) {
		const id = Number(r.id);
		const q = legacyQty(r.quantity_required) ?? 0;
		const key = `${Number(r.procedure_id)}/${Number(r.part_id)}`;
		if (!c.ids.procedure!.has(Number(r.procedure_id)) || !c.ids.part!.has(Number(r.part_id)) || q <= 0 || seenProc.has(key)) {
			fail(c, 'kit', id, 'procedure or part is not imported, quantity is not above zero, or the part repeats');
			continue;
		}
		seenProc.add(key);
		kitRows.push({ id, procedureId: Number(r.procedure_id), stepId: null, partId: Number(r.part_id), quantity: q, usage: 'consume', notes: null, createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) });
	}
	insertRows(c, 'kit', kitItem, kitRows);
	const seenStep = new Set<string>();
	const stepKitRows: Record<string, unknown>[] = [];
	const stepKitIds = new Map<number, number>();
	let next = base;
	for (const r of stepKit) {
		const id = Number(r.id);
		const q = legacyQty(r.quantity_required) ?? 0;
		const key = `${Number(r.step_id)}/${Number(r.part_id)}`;
		if (!stepIds.has(Number(r.step_id)) || !c.ids.part!.has(Number(r.part_id)) || q <= 0 || seenStep.has(key)) {
			fail(c, 'step_kit', id, 'step or part is not imported, quantity is not above zero, or the part repeats');
			continue;
		}
		seenStep.add(key);
		stepKitIds.set(id, ++next);
		stepKitRows.push({ id: next, procedureId: null, stepId: Number(r.step_id), partId: Number(r.part_id), quantity: q, usage: oneOf(c, r.usage_type, KIT_USAGES, 'consume', `step_kit ${id} usage_type`), notes: str(r.notes), createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) });
	}
	insertRows(c, 'step_kit', kitItem, stepKitRows);

	const outputs = readTable(c, 'procedure_output', ['id', 'procedure_id', 'part_id', 'quantity_produced', 'created_at', 'updated_at']);
	const seenOut = new Set<string>();
	insertRows(c, 'procedure_output', procedureOutput, outputs.flatMap((r) => {
		const id = Number(r.id);
		const q = legacyQty(r.quantity_produced) ?? 0;
		const key = `${Number(r.procedure_id)}/${Number(r.part_id)}`;
		if (!c.ids.procedure!.has(Number(r.procedure_id)) || !c.ids.part!.has(Number(r.part_id)) || q <= 0 || seenOut.has(key)) {
			fail(c, 'procedure_output', id, 'procedure or part is not imported, quantity is not above zero, or the part repeats');
			return [];
		}
		seenOut.add(key);
		return [{ id, procedureId: Number(r.procedure_id), partId: Number(r.part_id), quantity: q, createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) }];
	}));

	// ---- published versions, with attachment ids turned into blob hashes
	const blobOf = (attachmentId: number) => blobs.get(attachmentId) ?? null;
	const versionRows = versions.flatMap((r) => {
		const id = Number(r.id);
		const pid = Number(r.procedure_id);
		if (!c.ids.procedure!.has(pid)) {
			fail(c, 'procedure_version', id, `procedure ${pid} is not imported`);
			return [];
		}
		const content = json<LegacyContent>(r.content);
		if (!content || !Array.isArray(content.steps)) {
			fail(c, 'procedure_version', id, 'content is not readable');
			return [];
		}
		const snap: ProcedureSnapshot = snapshotFromLegacy(content, { templateNumber: numberOf.get(pid)!, projectId: c.projectId, procedureType: typeOf.get(pid)! }, blobOf);
		for (const s of snap.steps) s.instructions = freezeLinks(s.instructions, blobs);
		for (const li of content.steps.flatMap((s) => s.images ?? [])) {
			if (!blobs.has(li.attachment_id)) warn(c, `procedure_version ${id}: image attachment ${li.attachment_id} has no file, image dropped`);
		}
		return [{
			id,
			procedureId: pid,
			versionNumber: Number(r.version_number),
			content: snap,
			changeNote: content.change_note ?? null,
			createdById: ref(c, 'user', r.created_by_id, `procedure_version ${id} created_by_id`),
			createdAt: tsReq(r.created_at)
		}];
	});
	track(c, 'procedure_version', insertRows(c, 'procedure_version', procedureVersion, versionRows));
	void ts;
}
