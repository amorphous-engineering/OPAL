/**
 * The snapshot: the immutable content of a published version (see ProcedureSnapshot in the
 * shared package). Built from the draft at publish time; compared with the draft to tell
 * whether it has unpublished changes; converted from the legacy content format on import.
 */
import {
	type ProcedureSnapshot,
	type Qty,
	type SnapshotStep,
	formatQty
} from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { attachment, procedureOutput } from '../../db/schema/index.ts';
import { imageRows, procedureKitRows, procedureRow, presentDraft } from './draft.ts';
import { effectiveSignoffs, relabel } from './signoffs.ts';

const INLINE_LINK = /\/api\/attachments\/(\d+)\/download/g;

/**
 * Markdown images point at `/api/attachments/<id>/download` while authoring. A snapshot must not
 * depend on an attachment row that a later edit can remove, so the links become blob links.
 */
export function freezeInlineLinks(db: Db, markdown: string | null): string | null {
	if (!markdown) return markdown;
	const ids = [...new Set([...markdown.matchAll(INLINE_LINK)].map((m) => Number(m[1])))];
	if (!ids.length) return markdown;
	const sha = new Map(
		db
			.select({ id: attachment.id, sha: attachment.blobSha256 })
			.from(attachment)
			.where(inArray(attachment.id, ids))
			.all()
			.map((a) => [a.id, a.sha])
	);
	return markdown.replace(INLINE_LINK, (whole, id) => (sha.has(Number(id)) ? `/api/blobs/${sha.get(Number(id))}` : whole));
}

/** What a publish would freeze, built from the live draft. */
export function buildSnapshot(ctx: Pick<Ctx, 'db'>, procedureId: number): ProcedureSnapshot {
	const proc = procedureRow(ctx.db, procedureId);
	const steps = presentDraft(ctx, procedureId);
	const images = new Map<number, SnapshotStep['images']>();
	for (const img of imageRows(ctx.db, steps.map((s) => s.id))) {
		images.set(img.stepId, [...(images.get(img.stepId) ?? []), { sha256: img.sha256, filename: img.filename, caption: img.caption }]);
	}
	return {
		schemaVersion: 1,
		procedure: {
			templateNumber: proc.templateNumber,
			projectId: proc.projectId,
			name: proc.name,
			description: proc.description,
			procedureType: proc.procedureType
		},
		steps: steps.map((s) => ({
			id: s.id,
			order: s.order,
			number: s.number,
			level: s.level,
			parentId: s.parentId,
			title: s.title,
			instructions: freezeInlineLinks(ctx.db, s.instructions),
			dataSchema: s.dataSchema,
			isContingency: s.isContingency,
			strictSequence: s.strictSequence,
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			workcenterId: s.workcenterId,
			signoffs: s.signoffs,
			callouts: s.callouts.map((c) => ({ ...c })),
			dependsOn: s.dependsOn,
			images: images.get(s.id) ?? [],
			kit: s.kit.map((k) => ({ partId: k.partId, quantity: k.quantity, usage: k.usage, notes: k.notes }))
		})),
		kit: procedureKitRows(ctx.db, procedureId).map((k) => ({ partId: k.partId, quantity: formatQty(k.quantity as Qty) })),
		outputs: ctx.db
			.select()
			.from(procedureOutput)
			.where(eq(procedureOutput.procedureId, procedureId))
			.orderBy(procedureOutput.id)
			.all()
			.map((o) => ({ partId: o.partId, quantity: formatQty(o.quantity as Qty) }))
	};
}

/**
 * The snapshot without database identity, so a restored or re-created draft that reads the same
 * compares equal to the version it came from. Step ids become the step numbers they stand for.
 */
export function normalized(s: ProcedureSnapshot) {
	const numberOf = new Map(s.steps.map((x) => [x.id, x.number]));
	return {
		procedure: s.procedure,
		steps: s.steps.map((x) => ({
			number: x.number,
			parent: x.parentId === null ? null : (numberOf.get(x.parentId) ?? null),
			title: x.title,
			instructions: x.instructions,
			dataSchema: x.dataSchema,
			isContingency: x.isContingency,
			strictSequence: x.strictSequence,
			estimatedDurationMinutes: x.estimatedDurationMinutes,
			workcenterId: x.workcenterId,
			signoffs: relabel(x.signoffs),
			callouts: x.callouts,
			dependsOn: x.dependsOn.map((d) => numberOf.get(d) ?? null).sort(),
			images: x.images.map((i) => [i.sha256, i.caption]),
			kit: [...x.kit].sort((a, b) => a.partId - b.partId)
		})),
		kit: [...s.kit].sort((a, b) => a.partId - b.partId),
		outputs: [...s.outputs].sort((a, b) => a.partId - b.partId)
	};
}

export function snapshotsEquivalent(a: ProcedureSnapshot, b: ProcedureSnapshot): boolean {
	return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

// ----------------------------------------------------------------- legacy import

/** Legacy `ProcedureVersion.content` (snake_case, floats, attachment ids). */
interface LegacyStep {
	id: number;
	order: number;
	step_number: string;
	level?: number;
	parent_step_id: number | null;
	title: string;
	instructions?: string | null;
	required_data_schema?: { fields?: unknown[] } | null;
	is_contingency?: boolean;
	requires_signoff?: boolean;
	signoffs?: { label?: string; role?: string | null }[] | null;
	estimated_duration_minutes?: number | null;
	required_role?: string | null;
	callouts?: { kind: 'caution' | 'info'; text: string }[] | null;
	caution?: string | null;
	strict_sequence?: boolean;
	workcenter_id?: number | null;
	depends_on?: number[];
	images?: { attachment_id: number; caption?: string | null }[];
	step_kit?: { part_id: number; quantity_required: number; usage_type?: string; notes?: string | null }[];
}

export interface LegacyContent {
	procedure_name: string;
	procedure_description?: string | null;
	steps: LegacyStep[];
	kit_items?: { part_id: number; quantity_required: number }[];
	output_items?: { part_id: number; quantity_produced: number }[];
	change_note?: string;
}

const qtyString = (n: number) => formatQty(Math.round(n * 10000) as Qty);

/**
 * Convert legacy version content into a snapshot, for the import.
 *
 * - `depends_on` held prerequisite `order` values; they become step ids.
 * - Images held attachment ids; `blobOf(attachmentId)` gives the hash and file name, or null
 *   when the file is gone (the image is then dropped).
 * - Sign-offs become the effective list (legacy computed it from `requires_signoff` and
 *   `required_role` when no list was stored).
 * - A legacy `caution` text becomes one caution callout.
 * - Step kit part names are dropped: part names are read live.
 * - Template number, project and procedure type are not in legacy content; pass them in.
 */
export function snapshotFromLegacy(
	content: LegacyContent,
	meta: { templateNumber: string; projectId: number; procedureType: 'op' | 'build' },
	blobOf: (attachmentId: number) => { sha256: string; filename: string } | null
): ProcedureSnapshot {
	const steps = [...content.steps].sort((a, b) => a.order - b.order);
	const idOfOrder = new Map(steps.map((s) => [s.order, s.id]));
	const parents = new Set(steps.map((s) => s.parent_step_id).filter((x): x is number => x != null));
	return {
		schemaVersion: 1,
		procedure: {
			templateNumber: meta.templateNumber,
			projectId: meta.projectId,
			name: content.procedure_name,
			description: content.procedure_description ?? null,
			procedureType: meta.procedureType
		},
		steps: steps.map((s) => {
			const hasKids = parents.has(s.id);
			const explicit = s.signoffs ?? null;
			let stored: { role: string | null }[] | null = explicit ? explicit.map((x) => ({ role: x.role ?? null })) : null;
			if (stored === null) {
				// Derive the legacy default: Primary (role), plus Secondary when sign-off is required.
				const role = s.required_role ?? null;
				const requires = !!s.requires_signoff;
				stored = hasKids ? (requires ? [{ role }] : []) : requires ? [{ role }, { role: null }] : [{ role }];
			}
			return {
				id: s.id,
				order: s.order,
				number: s.step_number,
				level: s.parent_step_id == null ? 0 : 1,
				parentId: s.parent_step_id ?? null,
				title: s.title,
				instructions: s.instructions ?? null,
				dataSchema: (s.required_data_schema?.fields?.length ? s.required_data_schema : null) as SnapshotStep['dataSchema'],
				isContingency: !!s.is_contingency,
				strictSequence: !!s.strict_sequence,
				estimatedDurationMinutes: s.estimated_duration_minutes ?? null,
				workcenterId: s.workcenter_id ?? null,
				signoffs: effectiveSignoffs(stored, hasKids),
				callouts:
					s.callouts != null
						? s.callouts.map((c) => ({ kind: c.kind, text: c.text }))
						: s.caution
							? [{ kind: 'caution' as const, text: s.caution }]
							: [],
				dependsOn: (s.depends_on ?? []).map((o) => idOfOrder.get(o)).filter((x): x is number => x !== undefined),
				images: (s.images ?? []).flatMap((i) => {
					const b = blobOf(i.attachment_id);
					return b ? [{ sha256: b.sha256, filename: b.filename, caption: i.caption ?? null }] : [];
				}),
				kit: (s.step_kit ?? []).map((k) => ({
					partId: k.part_id,
					quantity: qtyString(k.quantity_required),
					usage: k.usage_type === 'tooling' ? ('tooling' as const) : ('consume' as const),
					notes: k.notes ?? null
				}))
			};
		}),
		kit: (content.kit_items ?? []).map((k) => ({ partId: k.part_id, quantity: qtyString(k.quantity_required) })),
		outputs: (content.output_items ?? []).map((o) => ({ partId: o.part_id, quantity: qtyString(o.quantity_produced) }))
	};
}
