/** attachment: copy each file into the blob store by SHA-256 and link it to its owner. */
import { ATTACHMENT_KINDS } from '@opal/shared';
import { attachment, blob } from '../db/schema/index.ts';
import { sourceFile, storeByHash } from './files.ts';
import { type ImportCtx, type Row, derived, fail, insertRows, leaveInLegacyRow, oneOf, readTable, ref, str, track, tsReq, warn } from './context.ts';

/**
 * Owner type = the owner's table name. The execution names are set from the execution
 * schema (see importExecutions).
 */
export const OWNER = {
	execution: 'execution',
	stepExecution: 'step_execution',
	stepNote: 'step_note',
	issue: 'issue',
	procedure: 'procedure',
	procedureStep: 'procedure_step',
	purchase: 'purchase'
};

export interface BlobInfo {
	sha256: string;
	filename: string;
}

const COLS = [
	'id', 'original_filename', 'stored_filename', 'mime_type', 'size_bytes', 'kind', 'note',
	'uploaded_by_id', 'procedure_instance_id', 'step_execution_id', 'step_note_id', 'issue_id',
	'procedure_id', 'purchase_id', 'created_at'
];

/** Legacy attachment id to its blob. Used to rewrite snapshot links. */
export type BlobMap = Map<number, BlobInfo>;

export function importAttachments(c: ImportCtx): BlobMap {
	const rows = readTable(c, 'attachment', COLS);
	const map: BlobMap = new Map();
	// Which attachments are step images: the step owns them, not the procedure.
	const stepImage = new Map<number, number>();
	for (const r of c.src.query('SELECT attachment_id, step_id FROM step_image ORDER BY id').all() as Row[]) {
		if (!stepImage.has(Number(r.attachment_id))) stepImage.set(Number(r.attachment_id), Number(r.step_id));
	}

	const blobs = new Map<string, { size: number; mime: string; at: string }>();
	const links: Record<string, unknown>[] = [];
	for (const [i, r] of rows.entries()) {
		if (i > 0 && i % 100 === 0) c.progress(`attachments, ${i} of ${rows.length}`);
		const id = Number(r.id);
		const file = sourceFile(c.attachmentsDir, r.stored_filename);
		if ('missing' in file) {
			fail(c, 'attachment', id, `file ${String(r.stored_filename)} is missing`);
			continue;
		}
		if ('refused' in file) {
			fail(c, 'attachment', id, file.refused);
			continue;
		}
		const stored = storeByHash(file.path, c.blobsDir, c.createdFiles);
		const sha = stored.sha256;
		if (r.size_bytes != null && Number(r.size_bytes) !== stored.size) warn(c, `attachment ${id} ${String(r.original_filename)}: the record says ${Number(r.size_bytes)} bytes and the file has ${stored.size}, kept the file`);
		if (!blobs.has(sha)) {
			blobs.set(sha, { size: stored.size, mime: String(r.mime_type), at: tsReq(r.created_at) });
		} else {
			const b = blobs.get(sha)!;
			const at = tsReq(r.created_at);
			if (at < b.at) b.at = at;
		}
		const filename = String(r.original_filename);
		map.set(id, { sha256: sha, filename });

		let owner: { type: string; id: number } | null = null;
		let kind = r.kind ? oneOf(c, r.kind, ATTACHMENT_KINDS, 'reference', `attachment ${id} kind`) : null;
		if (stepImage.has(id)) {
			owner = { type: OWNER.procedureStep, id: stepImage.get(id)! };
			kind = 'step_image';
		} else if (r.step_note_id) owner = { type: OWNER.stepNote, id: Number(r.step_note_id) };
		else if (r.step_execution_id) owner = { type: OWNER.stepExecution, id: Number(r.step_execution_id) };
		else if (r.procedure_instance_id) owner = { type: OWNER.execution, id: Number(r.procedure_instance_id) };
		else if (r.issue_id) owner = { type: OWNER.issue, id: Number(r.issue_id) };
		else if (r.procedure_id) owner = { type: OWNER.procedure, id: Number(r.procedure_id) };
		else if (r.purchase_id) owner = { type: OWNER.purchase, id: Number(r.purchase_id) };
		if (!owner) {
			warn(c, `attachment ${id} ${filename}: no owner, file stored but not linked`);
			leaveInLegacyRow(c, 'attachment', r, 'no owner');
			continue;
		}
		links.push({
			id,
			blobSha256: sha,
			filename,
			ownerType: owner.type,
			ownerId: owner.id,
			kind,
			note: str(r.note),
			uploadedById: ref(c, 'user', r.uploaded_by_id, `attachment ${id} uploaded_by_id`),
			createdAt: tsReq(r.created_at)
		});
	}
	for (const [sha, b] of blobs) {
		c.d.insert(blob).values({ sha256: sha, sizeBytes: b.size, mimeType: b.mime, createdAt: b.at }).run();
	}
	derived(c, 'blob', blobs.size);
	track(c, 'attachment', insertRows(c, 'attachment', attachment, links));
	return map;
}
