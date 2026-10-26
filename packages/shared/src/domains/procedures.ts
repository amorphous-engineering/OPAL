/**
 * Contracts for the procedures area: master procedures (templates), the step tree, kit and
 * outputs, the op graph, and published versions.
 *
 * `zProcedureSnapshot` is the frozen content of a published version. The execution area reads
 * it and nothing else to know what to run. Rules for the snapshot:
 *   - it holds everything execution needs: structure, text, data-capture schema, sign-off
 *     slots, callouts, op dependencies, images, kit and outputs;
 *   - it references only immutable data: images by blob SHA-256 (the file name in the blob
 *     store), parts by id (a referenced part is never deleted), steps by their own `id`;
 *   - a step `id` is the draft step's database id at publish time. Restoring a version puts
 *     the same ids back, so one id names one step across all versions of a procedure.
 */
import { z } from 'zod';
import { zSpec } from '../specs.ts';
import { op, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zQty } from '../qty.ts';
import { zTimestamp } from '../time.ts';

export const PROCEDURE_STATUSES = ['draft', 'released', 'obsolete'] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];
/** op = work order with no output; build = produces an assembly. */
export const PROCEDURE_TYPES = ['op', 'build'] as const;
export type ProcedureType = (typeof PROCEDURE_TYPES)[number];
/** consume: stock is used up. tooling: used and returned. */
export const KIT_USAGES = ['consume', 'tooling'] as const;
export type KitUsage = (typeof KIT_USAGES)[number];
export const CALLOUT_KINDS = ['caution', 'info'] as const;
/** `boolean` is answered TRUE or FALSE (shown as a choice). Older data says `checkbox`. */
export const DATA_FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'textarea', 'photo'] as const;
export const PROCEDURE_SORT_KEYS = [
	'number',
	'name',
	'status',
	'type',
	'version',
	'steps',
	'executions',
	'createdAt',
	'updatedAt'
] as const;
export const DIFF_STATUSES = ['added', 'removed', 'modified', 'unchanged'] as const;

/** The labels sign-off slots get by position. An author never types a label. */
export const PRIMARY_SIGNOFF_LABEL = 'Primary buyoff';
export const SECONDARY_SIGNOFF_LABEL = 'Secondary buyoff';

// ---------------------------------------------------------------- building blocks

export const zProcedureCallout = z.object({
	kind: z.enum(CALLOUT_KINDS),
	text: z.string()
});
export type ProcedureCallout = z.infer<typeof zProcedureCallout>;

/** One captured value of a step: a typed field the operator fills in. */
export const zProcedureDataField = z.object({
	name: z.string().trim().min(1).max(100),
	label: z.string().optional(),
	// `checkbox` is the old name of `boolean`: accepted on input, never sent.
	type: z.preprocess((t) => (t === 'checkbox' ? 'boolean' : t), z.enum(DATA_FIELD_TYPES)),
	required: z.boolean().optional(),
	/** A unit code from `UNITS` (units.ts). Older versions may hold free text: show it as is. */
	unit: z.string().optional(),
	/** Numbers only: what a good value is. Out-of-spec values are recorded and flagged. */
	spec: zSpec.optional(),
	/** Older versions only: hard limits that refuse a value. New fields use `spec`. */
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.union([z.number(), z.string()]).optional(),
	options: z.array(z.string()).optional(),
	placeholder: z.string().optional(),
	rows: z.number().int().optional(),
	/** photo only: one picture or several. */
	multiple: z.boolean().optional()
});
export type ProcedureDataField = z.infer<typeof zProcedureDataField>;

export const zProcedureDataSchema = z
	.object({ fields: z.array(zProcedureDataField).default([]) })
	.superRefine((s, ctx) => {
		const seen = new Set<string>();
		s.fields.forEach((f, i) => {
			if (seen.has(f.name)) {
				ctx.addIssue({ code: 'custom', path: ['fields', i, 'name'], message: `Duplicate field name '${f.name}'` });
			}
			seen.add(f.name);
		});
	});
export type ProcedureDataSchema = z.infer<typeof zProcedureDataSchema>;

/** A sign-off slot as the server sends it: the label comes from the position. */
export const zProcedureSignoff = z.object({
	label: z.string(),
	role: z.string().nullable()
});
export type ProcedureSignoff = z.infer<typeof zProcedureSignoff>;

/** A sign-off slot as an author sends it: only the role is authored. */
export const zProcedureSignoffInput = z.object({
	label: z.string().optional(),
	role: z.string().max(50).nullable().optional()
});

export const zProcedureStepImage = z.object({
	id: z.number().int(),
	attachmentId: z.number().int(),
	/** File name in the blob store; `/api/blobs/<sha256>` serves it. */
	sha256: z.string(),
	filename: z.string(),
	caption: z.string().nullable(),
	position: z.number().int()
});
export type ProcedureStepImage = z.infer<typeof zProcedureStepImage>;

/** One part line: a kit item of the procedure (stepId null) or of one step. */
export const zProcedureKitItem = z.object({
	id: z.number().int(),
	procedureId: z.number().int(),
	stepId: z.number().int().nullable(),
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	partExternalPn: z.string().nullable(),
	partState: z.enum(['draft', 'active', 'obsolete']),
	unitOfMeasure: z.string(),
	quantity: zQty,
	usage: z.enum(KIT_USAGES),
	notes: z.string().nullable(),
	/** Stock on hand across all records of the part. */
	onHand: zQty
});
export type ProcedureKitItem = z.infer<typeof zProcedureKitItem>;

export const zProcedureOutput = z.object({
	id: z.number().int(),
	procedureId: z.number().int(),
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	partExternalPn: z.string().nullable(),
	partState: z.enum(['draft', 'active', 'obsolete']),
	unitOfMeasure: z.string(),
	quantity: zQty
});
export type ProcedureOutput = z.infer<typeof zProcedureOutput>;

// ---------------------------------------------------------------- the draft

/** One step of the draft. Numbers are derived from the tree, never stored. */
export const zProcedureStep = z.object({
	id: z.number().int(),
	procedureId: z.number().int(),
	/** 1..n in document order: normal OPs first, then contingency OPs, each followed by its steps. */
	order: z.number().int(),
	/** `1`, `1.2`, `C1`, `C1.2`. */
	number: z.string(),
	/** 0 = OP, 1 = sub-step. */
	level: z.number().int(),
	parentId: z.number().int().nullable(),
	title: z.string(),
	/** Markdown. */
	instructions: z.string().nullable(),
	dataSchema: zProcedureDataSchema.nullable(),
	isContingency: z.boolean(),
	/** Derived from `signoffs`: a leaf needs a second slot, an OP with sub-steps any slot. */
	requiresSignoff: z.boolean(),
	/** Derived from `signoffs`: the role of the first slot. */
	requiredRole: z.string().nullable(),
	signoffs: z.array(zProcedureSignoff),
	estimatedDurationMinutes: z.number().int().nullable(),
	callouts: z.array(zProcedureCallout),
	strictSequence: z.boolean(),
	workcenterId: z.number().int().nullable(),
	/** Ids of the OPs this OP waits on. */
	dependsOn: z.array(z.number().int()),
	images: z.array(zProcedureStepImage),
	kit: z.array(zProcedureKitItem)
});
export type ProcedureStep = z.infer<typeof zProcedureStep>;

export const zProcedureDraft = z.object({
	procedureId: z.number().int(),
	steps: z.array(zProcedureStep)
});
export type ProcedureDraft = z.infer<typeof zProcedureDraft>;

export const zProcedure = z.object({
	id: z.number().int(),
	templateNumber: z.string(),
	projectId: z.number().int(),
	projectCode: z.string(),
	projectName: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	procedureType: z.enum(PROCEDURE_TYPES),
	status: z.enum(PROCEDURE_STATUSES),
	currentVersionId: z.number().int().nullable(),
	currentVersionNumber: z.number().int().nullable(),
	opCount: z.number().int(),
	stepCount: z.number().int(),
	/** Executions started from any version. Supplied by the execution area; 0 until it registers. */
	executionCount: z.number().int(),
	/** Does the draft differ from the current version? Null when nothing is published. */
	unpublishedChanges: z.boolean().nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Procedure = z.infer<typeof zProcedure>;

// ---------------------------------------------------------------- the snapshot

export const zSnapshotImage = z.object({
	sha256: z.string(),
	filename: z.string(),
	caption: z.string().nullable()
});

export const zSnapshotKitLine = z.object({
	partId: z.number().int(),
	quantity: zQty,
	usage: z.enum(KIT_USAGES),
	notes: z.string().nullable()
});

export const zSnapshotStep = z.object({
	/** The draft step's id at publish time. The one key of a step in authoring and execution. */
	id: z.number().int(),
	order: z.number().int(),
	number: z.string(),
	level: z.number().int(),
	parentId: z.number().int().nullable(),
	title: z.string(),
	/** Markdown. Inline images point at `/api/blobs/<sha256>`. */
	instructions: z.string().nullable(),
	dataSchema: zProcedureDataSchema.nullable(),
	isContingency: z.boolean(),
	strictSequence: z.boolean(),
	estimatedDurationMinutes: z.number().int().nullable(),
	/** Default workcenter. A workcenter is deactivated, never deleted, so the id stays valid. */
	workcenterId: z.number().int().nullable(),
	/** Effective slots in order. A leaf has at least one. An OP with sub-steps may have none. */
	signoffs: z.array(zProcedureSignoff),
	callouts: z.array(zProcedureCallout),
	/** Ids of the OPs this OP waits on. Only OPs (level 0) have any. */
	dependsOn: z.array(z.number().int()),
	images: z.array(zSnapshotImage),
	kit: z.array(zSnapshotKitLine)
});
export type SnapshotStep = z.infer<typeof zSnapshotStep>;

export const zProcedureSnapshot = z.object({
	/** Bumped when this shape changes. */
	schemaVersion: z.literal(1),
	procedure: z.object({
		templateNumber: z.string(),
		/** The project the procedure belonged to at publish time. */
		projectId: z.number().int(),
		name: z.string(),
		description: z.string().nullable(),
		procedureType: z.enum(PROCEDURE_TYPES)
	}),
	/** Document order. */
	steps: z.array(zSnapshotStep),
	/** Parts consumed by the procedure as a whole. */
	kit: z.array(z.object({ partId: z.number().int(), quantity: zQty })),
	/** Parts the procedure produces. */
	outputs: z.array(z.object({ partId: z.number().int(), quantity: zQty }))
});
export type ProcedureSnapshot = z.infer<typeof zProcedureSnapshot>;

// ---------------------------------------------------------------- versions

export const zProcedureVersion = z.object({
	id: z.number().int(),
	procedureId: z.number().int(),
	versionNumber: z.number().int(),
	createdAt: zTimestamp,
	createdById: z.number().int().nullable(),
	createdByName: z.string().nullable(),
	changeNote: z.string().nullable(),
	stepCount: z.number().int(),
	isCurrent: z.boolean()
});
export type ProcedureVersion = z.infer<typeof zProcedureVersion>;

/** A part named by a snapshot. Names are live: part ids are never reused. */
export const zVersionPart = z.object({
	id: z.number().int(),
	internalPn: z.string(),
	name: z.string(),
	externalPn: z.string().nullable(),
	unitOfMeasure: z.string(),
	state: z.enum(['draft', 'active', 'obsolete'])
});
export type VersionPart = z.infer<typeof zVersionPart>;

export const zProcedureVersionDetail = zProcedureVersion.extend({
	procedureTemplateNumber: z.string(),
	procedureName: z.string(),
	procedureType: z.enum(PROCEDURE_TYPES),
	procedureStatus: z.enum(PROCEDURE_STATUSES),
	/** The project the version was published in. */
	projectCode: z.string(),
	snapshot: zProcedureSnapshot,
	parts: z.array(zVersionPart)
});
export type ProcedureVersionDetail = z.infer<typeof zProcedureVersionDetail>;

export const zStepDiff = z.object({
	status: z.enum(DIFF_STATUSES),
	number: z.string(),
	titleA: z.string().nullable(),
	titleB: z.string().nullable(),
	changedFields: z.array(z.string()),
	/** Old and new value of each changed field. */
	changes: z.record(z.string(), z.object({ a: z.unknown(), b: z.unknown() }))
});
export type StepDiff = z.infer<typeof zStepDiff>;

export const zPartDiff = z.object({
	partId: z.number().int(),
	internalPn: z.string().nullable(),
	name: z.string().nullable(),
	status: z.enum(['added', 'removed', 'modified']),
	quantityA: zQty.nullable(),
	quantityB: zQty.nullable()
});
export type PartDiff = z.infer<typeof zPartDiff>;

export const zVersionDiff = z.object({
	procedureId: z.number().int(),
	procedureName: z.string(),
	versionA: zProcedureVersion,
	versionB: zProcedureVersion,
	procedureChanges: z.array(z.object({ field: z.string(), a: z.string().nullable(), b: z.string().nullable() })),
	steps: z.array(zStepDiff),
	kit: z.array(zPartDiff),
	outputs: z.array(zPartDiff),
	added: z.number().int(),
	removed: z.number().int(),
	modified: z.number().int(),
	unchanged: z.number().int()
});
export type VersionDiff = z.infer<typeof zVersionDiff>;

// ---------------------------------------------------------------- inputs

/** Fields an author sets on a step. `null` clears a nullable field; absent leaves it alone. */
const stepFields = {
	instructions: z.string().nullable().optional(),
	dataSchema: zProcedureDataSchema.nullable().optional(),
	estimatedDurationMinutes: z.number().int().min(1).nullable().optional(),
	/** Replace the slots. Null resets to the default (a leaf: Primary buyoff; an OP with sub-steps: none). */
	signoffs: z.array(zProcedureSignoffInput).nullable().optional(),
	/** Sets the role of the first slot. `signoffs` wins when both are sent. */
	requiredRole: z.string().max(50).nullable().optional(),
	/** On: a leaf gets a second slot, an OP with sub-steps a first. Off: drops the slots after the first. */
	requiresSignoff: z.boolean().optional(),
	callouts: z.array(zProcedureCallout).nullable().optional(),
	strictSequence: z.boolean().optional(),
	workcenterId: z.number().int().nullable().optional()
};

export const zStepAdd = z.object({
	id: zId,
	title: z.string().trim().min(1).max(255),
	isContingency: z.boolean().default(false),
	/** Parent OP for a sub-step. Omit for a top-level OP. */
	parentId: z.number().int().optional(),
	/**
	 * Insert right after this step: a sub-step of the same OP, or the OP itself (then the new
	 * step is its first sub-step when `parentId` is that OP, else the next OP). Omit to append.
	 */
	afterStepId: z.number().int().optional(),
	...stepFields
});

export const zStepUpdate = z.object({
	id: zId,
	stepId: zId,
	title: z.string().trim().min(1).max(255).optional(),
	/** OPs only: moves the OP between the numbered and the C-numbered group. */
	isContingency: z.boolean().optional(),
	...stepFields
});

const zBuildStep = z.object({
	title: z.string().trim().min(1).max(255),
	instructions: z.string().nullable().optional(),
	requiredRole: z.string().max(50).nullable().optional(),
	requiresSignoff: z.boolean().optional(),
	signoffs: z.array(zProcedureSignoffInput).nullable().optional(),
	callouts: z.array(zProcedureCallout).nullable().optional(),
	strictSequence: z.boolean().optional(),
	estimatedDurationMinutes: z.number().int().min(1).nullable().optional(),
	workcenterId: z.number().int().nullable().optional(),
	kit: z
		.array(
			z.object({
				partId: zId,
				quantity: zQty,
				usage: z.enum(KIT_USAGES).default('consume'),
				notes: z.string().nullable().optional()
			})
		)
		.optional()
});

const zProcedureId = z.object({ id: zId });
const zStepRef = z.object({ id: zId, stepId: zId });

const zKitAdd = z.object({
	partId: zId,
	quantity: zQty,
	usage: z.enum(KIT_USAGES).default('consume'),
	notes: z.string().nullable().optional()
});

// ---------------------------------------------------------------- contracts

const steps = {
	add: op({
		name: 'procedures.steps.add',
		method: 'POST',
		path: '/procedures/:id/steps',
		summary:
			'Add an OP (no parentId) or a sub-step to the draft. Numbers follow: OP 1, 2; contingency C1, C2; sub-steps 1.1, 1.2. A number data field takes a unit code (such as in, mm, in_lbf, psi) and an optional spec.',
		input: zStepAdd,
		output: zProcedureStep,
		access: 'signed-in',
		mcp: true
	}),
	reorder: op({
		name: 'procedures.steps.reorder',
		method: 'POST',
		path: '/procedures/:id/steps/reorder',
		summary:
			'Set the order of every step from one list of all step ids in document order. A step keeps its parent; the order inside each parent follows the list.',
		input: z.object({ id: zId, stepIds: z.array(zId) }),
		output: z.array(zProcedureStep),
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'procedures.steps.update',
		method: 'PATCH',
		path: '/procedures/:id/steps/:stepId',
		summary:
			'Change a step. Absent fields stay; null clears instructions, data schema, duration, workcenter, callouts or sign-offs. A number data field takes a unit code (UNITS, such as in, mm, in_lbf, psi) and an optional spec (range, nominal, min, max, reference) as decimal strings; a spec is not combined with min or max. An out-of-spec value is recorded and needs a note or an NC before the step completes.',
		input: zStepUpdate,
		output: zProcedureStep,
		access: 'signed-in',
		mcp: true
	}),
	remove: op({
		name: 'procedures.steps.remove',
		method: 'DELETE',
		path: '/procedures/:id/steps/:stepId',
		summary: 'Delete a step. An OP takes its sub-steps along. Numbering closes over the gap.',
		input: zStepRef,
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	duplicate: op({
		name: 'procedures.steps.duplicate',
		method: 'POST',
		path: '/procedures/:id/steps/:stepId/duplicate',
		summary:
			'Copy a step (an OP with its sub-steps) to right after the original. Kit lines and images are copied. Op dependencies are not.',
		input: zStepRef,
		output: zProcedureStep,
		access: 'signed-in',
		mcp: true
	}),
	move: op({
		name: 'procedures.steps.move',
		method: 'POST',
		path: '/procedures/:id/steps/:stepId/move',
		summary:
			'Move a step to an index among the children of parentId (null: among the OPs). An OP with sub-steps stays top-level. Moving an OP under another OP drops its op dependencies.',
		input: z.object({
			id: zId,
			stepId: zId,
			parentId: z.number().int().nullable().default(null),
			index: z.number().int().min(0),
			/** Top level only: the group to land in. Default: keep the step's. */
			isContingency: z.boolean().optional()
		}),
		output: zProcedureStep,
		access: 'signed-in',
		mcp: true
	}),
	setDependencies: op({
		name: 'procedures.steps.setDependencies',
		method: 'PUT',
		path: '/procedures/:id/steps/:stepId/dependencies',
		summary:
			'Replace the OPs an OP waits on. Only top-level OPs of the same procedure; a self-loop or a cycle is refused.',
		input: z.object({ id: zId, stepId: zId, dependsOn: z.array(zId).default([]) }),
		output: z.object({ stepId: z.number().int(), dependsOn: z.array(z.number().int()) }),
		access: 'signed-in',
		mcp: true
	}),
	images: {
		list: op({
			name: 'procedures.steps.images.list',
			method: 'GET',
			path: '/procedures/:id/steps/:stepId/images',
			summary: "A step's reference images in display order.",
			input: zStepRef,
			output: z.array(zProcedureStepImage),
			access: 'signed-in',
			mcp: true
		}),
		update: op({
			name: 'procedures.steps.images.update',
			method: 'PATCH',
			path: '/procedures/:id/steps/:stepId/images/:imageId',
			summary: 'Change the caption of a step image.',
			input: z.object({ id: zId, stepId: zId, imageId: zId, caption: z.string().max(255).nullable().optional() }),
			output: zProcedureStepImage,
			access: 'signed-in',
			mcp: true
		}),
		remove: op({
			name: 'procedures.steps.images.remove',
			method: 'DELETE',
			path: '/procedures/:id/steps/:stepId/images/:imageId',
			summary: 'Unlink an image from the step. Published versions keep it by hash.',
			input: z.object({ id: zId, stepId: zId, imageId: zId }),
			output: zOk,
			access: 'signed-in',
			mcp: true
		}),
		reorder: op({
			name: 'procedures.steps.images.reorder',
			method: 'POST',
			path: '/procedures/:id/steps/:stepId/images/reorder',
			summary: 'Set the display order of a step images from the full list of image ids.',
			input: z.object({ id: zId, stepId: zId, imageIds: z.array(zId) }),
			output: z.array(zProcedureStepImage),
			access: 'signed-in',
			mcp: true
		})
	},
	kit: {
		list: op({
			name: 'procedures.steps.kit.list',
			method: 'GET',
			path: '/procedures/:id/steps/:stepId/kit',
			summary: 'Parts a step needs.',
			input: zStepRef,
			output: z.array(zProcedureKitItem),
			access: 'signed-in',
			mcp: true
		}),
		add: op({
			name: 'procedures.steps.kit.add',
			method: 'POST',
			path: '/procedures/:id/steps/:stepId/kit',
			summary: 'Add a part to a step. A part appears once per step.',
			input: z.object({ id: zId, stepId: zId }).extend(zKitAdd.shape),
			output: zProcedureKitItem,
			access: 'signed-in',
			mcp: true
		}),
		update: op({
			name: 'procedures.steps.kit.update',
			method: 'PATCH',
			path: '/procedures/:id/steps/:stepId/kit/:kitId',
			summary: 'Change quantity, usage or notes of a step kit line.',
			input: z.object({
				id: zId,
				stepId: zId,
				kitId: zId,
				quantity: zQty.optional(),
				usage: z.enum(KIT_USAGES).optional(),
				notes: z.string().nullable().optional()
			}),
			output: zProcedureKitItem,
			access: 'signed-in',
			mcp: true
		}),
		remove: op({
			name: 'procedures.steps.kit.remove',
			method: 'DELETE',
			path: '/procedures/:id/steps/:stepId/kit/:kitId',
			summary: 'Remove a part from a step.',
			input: z.object({ id: zId, stepId: zId, kitId: zId }),
			output: zOk,
			access: 'signed-in',
			mcp: true
		})
	}
};

const kit = {
	list: op({
		name: 'procedures.kit.list',
		method: 'GET',
		path: '/procedures/:id/kit',
		summary: 'Parts the procedure consumes as a whole, with stock on hand.',
		input: zProcedureId,
		output: z.array(zProcedureKitItem),
		access: 'signed-in',
		mcp: true
	}),
	add: op({
		name: 'procedures.kit.add',
		method: 'POST',
		path: '/procedures/:id/kit',
		summary: 'Add a part to the procedure kit. A part appears once.',
		input: z.object({ id: zId }).extend(zKitAdd.shape),
		output: zProcedureKitItem,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'procedures.kit.update',
		method: 'PATCH',
		path: '/procedures/:id/kit/:kitId',
		summary: 'Change the quantity of a kit line.',
		input: z.object({
			id: zId,
			kitId: zId,
			quantity: zQty.optional(),
			usage: z.enum(KIT_USAGES).optional(),
			notes: z.string().nullable().optional()
		}),
		output: zProcedureKitItem,
		access: 'signed-in',
		mcp: true
	}),
	remove: op({
		name: 'procedures.kit.remove',
		method: 'DELETE',
		path: '/procedures/:id/kit/:kitId',
		summary: 'Remove a part from the procedure kit.',
		input: z.object({ id: zId, kitId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};

const outputs = {
	list: op({
		name: 'procedures.outputs.list',
		method: 'GET',
		path: '/procedures/:id/outputs',
		summary: 'Parts the procedure produces.',
		input: zProcedureId,
		output: z.array(zProcedureOutput),
		access: 'signed-in',
		mcp: true
	}),
	add: op({
		name: 'procedures.outputs.add',
		method: 'POST',
		path: '/procedures/:id/outputs',
		summary:
			'Add a produced part. The first-level BOM of the part, times the quantity, is added to the procedure kit.',
		input: z.object({ id: zId, partId: zId, quantity: zQty.default('1') }),
		output: zProcedureOutput,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'procedures.outputs.update',
		method: 'PATCH',
		path: '/procedures/:id/outputs/:outputId',
		summary: 'Change the quantity produced.',
		input: z.object({ id: zId, outputId: zId, quantity: zQty }),
		output: zProcedureOutput,
		access: 'signed-in',
		mcp: true
	}),
	remove: op({
		name: 'procedures.outputs.remove',
		method: 'DELETE',
		path: '/procedures/:id/outputs/:outputId',
		summary: 'Remove a produced part.',
		input: z.object({ id: zId, outputId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};

const versions = {
	// Static `versions/:versionId` paths come before `:id`-parameterised siblings in the impl list.
	get: op({
		name: 'procedures.versions.get',
		method: 'GET',
		path: '/procedures/versions/:versionId',
		summary: 'A published version with its frozen snapshot and the parts it names. Also the data of the print view.',
		input: z.object({ versionId: zId }),
		output: zProcedureVersionDetail,
		access: 'signed-in',
		mcp: true
	}),
	qr: op({
		name: 'procedures.versions.qr',
		method: 'GET',
		path: '/procedures/versions/:versionId/qr',
		summary: 'QR code (SVG) for a traveler. The client passes the URL to encode.',
		input: z.object({ versionId: zId, url: z.string().min(1).max(2000) }),
		output: z.string(),
		access: 'signed-in',
		mcp: false,
		produces: 'image/svg+xml'
	}),
	list: op({
		name: 'procedures.versions.list',
		method: 'GET',
		path: '/procedures/:id/versions',
		summary: 'Published versions of a procedure, newest first.',
		input: zProcedureId,
		output: z.array(zProcedureVersion),
		access: 'signed-in',
		mcp: true
	}),
	publish: op({
		name: 'procedures.versions.publish',
		method: 'POST',
		path: '/procedures/:id/publish',
		summary:
			'Freeze the draft as a new immutable version and release the procedure. Refused with no steps, or when the kit or outputs hold draft parts.',
		input: z.object({ id: zId, changeNote: z.string().max(2000).nullable().optional() }),
		output: zProcedureVersion,
		access: 'signed-in',
		mcp: true
	}),
	diff: op({
		name: 'procedures.versions.diff',
		method: 'GET',
		path: '/procedures/:id/versions/:versionA/diff/:versionB',
		summary: 'Step, kit and output differences between two versions of one procedure.',
		input: z.object({ id: zId, versionA: zId, versionB: zId }),
		output: zVersionDiff,
		access: 'signed-in',
		mcp: true
	}),
	restore: op({
		name: 'procedures.versions.restore',
		method: 'POST',
		path: '/procedures/:id/versions/:versionId/restore',
		summary:
			'Replace the draft steps, kit and outputs with a version snapshot. The status and the current version stay.',
		input: z.object({ id: zId, versionId: zId }),
		output: zProcedure,
		access: 'signed-in',
		mcp: true
	})
};

export const procedures = {
	list: op({
		name: 'procedures.list',
		method: 'GET',
		path: '/procedures',
		summary: 'List procedures with search, filters, sort and per-row counts.',
		input: zPageInput.extend({
			q: z.string().optional(),
			projectId: zId.optional(),
			status: z.enum(PROCEDURE_STATUSES).optional(),
			procedureType: z.enum(PROCEDURE_TYPES).optional(),
			sort: z.enum(PROCEDURE_SORT_KEYS).default('updatedAt'),
			dir: z.enum(['asc', 'desc']).default('desc')
		}),
		output: zPage(zProcedure).extend({ total: z.number().int() }),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'procedures.create',
		method: 'POST',
		path: '/procedures',
		summary: 'Create a draft procedure in a project. It gets the next T-number.',
		input: z.object({
			projectId: zId,
			name: z.string().trim().min(1).max(255),
			description: z.string().nullable().optional(),
			procedureType: z.enum(PROCEDURE_TYPES).default('op')
		}),
		output: zProcedure,
		access: 'signed-in',
		mcp: true
	}),
	// Static paths before `/procedures/:id`.
	build: op({
		name: 'procedures.build',
		method: 'POST',
		path: '/procedures/build',
		summary:
			'Create a procedure with its OPs, step kits, kit and outputs in one call. Every part and workcenter is checked before anything is written.',
		input: z.object({
			projectId: zId,
			name: z.string().trim().min(1).max(255),
			description: z.string().nullable().optional(),
			procedureType: z.enum(PROCEDURE_TYPES).default('op'),
			steps: z.array(zBuildStep).default([]),
			kit: z.array(z.object({ partId: zId, quantity: zQty })).default([]),
			outputs: z.array(z.object({ partId: zId, quantity: zQty.default('1') })).default([])
		}),
		output: z.object({
			procedure: zProcedure,
			stepCount: z.number().int(),
			stepKitCount: z.number().int(),
			kitCount: z.number().int(),
			outputCount: z.number().int()
		}),
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'procedures.get',
		method: 'GET',
		path: '/procedures/:id',
		summary: 'One procedure with counts and whether the draft differs from the current version.',
		input: zProcedureId,
		output: zProcedure,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'procedures.update',
		method: 'PATCH',
		path: '/procedures/:id',
		summary:
			'Change name, description, type or status. Released needs a published version. Obsolete retires the procedure.',
		input: z.object({
			id: zId,
			projectId: zId.optional(),
			name: z.string().trim().min(1).max(255).optional(),
			description: z.string().nullable().optional(),
			status: z.enum(PROCEDURE_STATUSES).optional(),
			procedureType: z.enum(PROCEDURE_TYPES).optional()
		}),
		output: zProcedure,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'procedures.delete',
		method: 'DELETE',
		path: '/procedures/:id',
		summary: 'Delete a procedure that was never published. A published one becomes obsolete instead.',
		input: zProcedureId,
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	clone: op({
		name: 'procedures.clone',
		method: 'POST',
		path: '/procedures/:id/clone',
		summary: 'Copy the draft (steps, op dependencies, images, kit, outputs) into a new draft with a new T-number.',
		input: z.object({
			id: zId,
			newName: z.string().trim().min(1).max(255).optional(),
			copyKit: z.boolean().default(true),
			copyOutputs: z.boolean().default(true)
		}),
		output: zProcedure,
		access: 'signed-in',
		mcp: true
	}),
	draft: op({
		name: 'procedures.draft',
		method: 'GET',
		path: '/procedures/:id/draft',
		summary:
			'All draft steps in document order, each with images, kit lines and op dependencies. The editor loads this.',
		input: zProcedureId,
		output: zProcedureDraft,
		access: 'signed-in',
		mcp: true
	}),
	dependencies: op({
		name: 'procedures.dependencies',
		method: 'GET',
		path: '/procedures/:id/dependencies',
		summary: 'Every op dependency edge of the draft.',
		input: zProcedureId,
		output: z.array(z.object({ stepId: z.number().int(), dependsOnStepId: z.number().int() })),
		access: 'signed-in',
		mcp: true
	}),
	steps,
	kit,
	outputs,
	versions
};
