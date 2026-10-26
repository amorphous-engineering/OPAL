import { z } from 'zod';
import { op, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zQty } from '../qty.ts';
import { zTimestamp } from '../time.ts';

export const TRACKING_TYPES = ['serialized', 'bulk'] as const;
export const PROCUREMENT = ['make', 'buy', 'both'] as const;
/** draft (identity mutable) -> active (identity locked) -> obsolete (retired, still referenced). */
export const PART_STATES = ['draft', 'active', 'obsolete'] as const;
export const PART_SORT_KEYS = [
	'id',
	'internalPn',
	'externalPn',
	'name',
	'category',
	'tier',
	'state',
	'procurement',
	'unitOfMeasure',
	'createdAt',
	'updatedAt'
] as const;
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'select'] as const;

export type PartState = (typeof PART_STATES)[number];
export type Procurement = (typeof PROCUREMENT)[number];
export type TrackingType = (typeof TRACKING_TYPES)[number];

/** Project-defined fields. Values live under `metadata[key]` on the part. */
export const zPartMetadata = z.record(z.string(), z.unknown());

export const zPart = z.object({
	id: z.number().int(),
	internalPn: z.string(),
	externalPn: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	category: z.string().nullable(),
	unitOfMeasure: z.string(),
	trackingType: z.enum(TRACKING_TYPES),
	procurement: z.enum(PROCUREMENT),
	tier: z.number().int(),
	/** Display name of the tier in the project configuration; null when unconfigured. */
	tierName: z.string().nullable(),
	reorderPoint: zQty.nullable(),
	isTooling: z.boolean(),
	calibrationIntervalDays: z.number().int().nullable(),
	metadata: zPartMetadata.nullable(),
	state: z.enum(PART_STATES),
	activatedAt: zTimestamp.nullable(),
	activationCause: z.string().nullable(),
	obsoletedAt: zTimestamp.nullable(),
	obsoleteCause: z.string().nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Part = z.infer<typeof zPart>;

/** Booleans arrive as "true"/"false" in query strings. */
const zBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

const partFields = {
	externalPn: z.string().trim().max(255).nullable().optional(),
	description: z.string().nullable().optional(),
	category: z.string().trim().max(100).nullable().optional(),
	reorderPoint: zQty.nullable().optional(),
	isTooling: z.boolean().optional(),
	calibrationIntervalDays: z.number().int().positive().nullable().optional(),
	metadata: zPartMetadata.nullable().optional()
};

export const zPartCreate = z.object({
	name: z.string().trim().min(1).max(255),
	tier: z.number().int().min(1).default(1),
	unitOfMeasure: z.string().trim().min(1).max(20).default('ea'),
	/** Default: the tier's default tracking. */
	trackingType: z.enum(TRACKING_TYPES).optional(),
	/** Default: buy when an external PN is given, else make. */
	procurement: z.enum(PROCUREMENT).optional(),
	/** Also add the new part to this assembly's BOM. */
	assemblyId: zId.optional(),
	/** Quantity in that BOM line. */
	assemblyQuantity: zQty.optional(),
	...partFields,
	isTooling: z.boolean().default(false)
});
export type PartCreate = z.input<typeof zPartCreate>;

export const zPartUpdate = z.object({
	id: zId,
	name: z.string().trim().min(1).max(255).optional(),
	tier: z.number().int().min(1).optional(),
	unitOfMeasure: z.string().trim().min(1).max(20).optional(),
	trackingType: z.enum(TRACKING_TYPES).optional(),
	procurement: z.enum(PROCUREMENT).optional(),
	...partFields
});

// ---------------------------------------------------------------- variants

/** Where a new variant's BOM comes from: the source part as its one line, a copy, or nothing. */
export const VARIANT_BOM = ['source', 'copy', 'empty'] as const;
export type VariantBom = (typeof VARIANT_BOM)[number];

/** Omit a field to copy it from the source; send null to clear a nullable field. */
export const zVariantCreate = z.object({
	id: zId,
	name: z.string().trim().min(1).max(255).optional(),
	unitOfMeasure: z.string().trim().min(1).max(20).optional(),
	trackingType: z.enum(TRACKING_TYPES).optional(),
	procurement: z.enum(PROCUREMENT).optional(),
	...partFields,
	bom: z.enum(VARIANT_BOM).default('source')
});
export type VariantCreate = z.input<typeof zVariantCreate>;

export const zFamilyMember = z.object({
	id: z.number().int(),
	internalPn: z.string(),
	/** Three digits. A number without a suffix counts as 001. */
	variant: z.string(),
	name: z.string(),
	state: z.enum(PART_STATES),
	trackingType: z.enum(TRACKING_TYPES)
});

/** The parts that share a base number. The base has no row: the numbers are the family. */
export const zPartFamily = z.object({
	/** Everything up to and including the sequence: `F-1337` of `F-1337-002`. */
	baseNumber: z.string(),
	/** True when the organization numbers variants. */
	variants: z.boolean(),
	/** The number the next variant takes. Null when variants are off or the codes are used up. */
	nextNumber: z.string().nullable(),
	/** In code order. */
	members: z.array(zFamilyMember)
});
export type PartFamily = z.infer<typeof zPartFamily>;

// ---------------------------------------------------------------- BOM

export const zBomLine = z.object({
	id: z.number().int(),
	assemblyId: z.number().int(),
	assemblyPn: z.string(),
	assemblyName: z.string(),
	componentId: z.number().int(),
	componentPn: z.string(),
	componentName: z.string(),
	componentExternalPn: z.string().nullable(),
	componentTier: z.number().int(),
	componentState: z.enum(PART_STATES),
	quantity: zQty,
	referenceDesignator: z.string().nullable(),
	notes: z.string().nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type BomLine = z.infer<typeof zBomLine>;

export interface BomTreeNode {
	partId: number;
	internalPn: string;
	name: string;
	externalPn: string | null;
	tier: number;
	state: PartState;
	quantity: string;
	referenceDesignator: string | null;
	/** True when this part already appears above it in the tree; its children are cut. */
	circular: boolean;
	children: BomTreeNode[];
}
export const zBomTreeNode: z.ZodType<BomTreeNode> = z.lazy(() =>
	z.object({
		partId: z.number().int(),
		internalPn: z.string(),
		name: z.string(),
		externalPn: z.string().nullable(),
		tier: z.number().int(),
		state: z.enum(PART_STATES),
		quantity: zQty,
		referenceDesignator: z.string().nullable(),
		circular: z.boolean(),
		children: z.array(zBomTreeNode)
	})
);

// ---------------------------------------------------------------- Part page

export const zPartExpects = z.object({ bom: z.boolean(), suppliers: z.boolean(), poLines: z.boolean() });

export const zPartDetail = z.object({
	part: zPart,
	tierCode: z.string().nullable(),
	activatedBy: z.string().nullable(),
	/** Which sections expect content, declared by `procurement`. */
	expects: zPartExpects,
	/** Nonzero counts of everything that references this part. */
	references: z.record(z.string(), z.number().int()),
	deletable: z.boolean(),
	bom: z.array(zBomLine),
	whereUsed: z.array(zBomLine),
	family: zPartFamily
});
export type PartDetail = z.infer<typeof zPartDetail>;

export const zHistoryEntry = z.object({
	at: zTimestamp,
	action: z.enum(['create', 'update', 'delete']),
	op: z.string(),
	userName: z.string().nullable(),
	changes: z.array(z.object({ field: z.string(), old: z.unknown(), new: z.unknown() }))
});
export const zPartHistory = z.object({ items: z.array(zHistoryEntry), total: z.number().int() });
export type PartHistoryEntry = z.infer<typeof zHistoryEntry>;

// ---------------------------------------------------------------- Schema / numbering

export const zSchemaTier = z.object({
	level: z.number().int(),
	name: z.string(),
	code: z.string(),
	description: z.string(),
	defaultTracking: z.enum(TRACKING_TYPES),
	requireLot: z.boolean(),
	autoSerial: z.boolean()
});
export const zCustomFieldDef = z.object({
	key: z.string(),
	label: z.string(),
	type: z.enum(CUSTOM_FIELD_TYPES),
	options: z.array(z.string()),
	default: z.unknown(),
	required: z.boolean()
});
export const zPartSchema = z.object({
	tiers: z.array(zSchemaTier),
	categories: z.array(z.string()),
	customFields: z.array(zCustomFieldDef),
	numberingFormat: z.string().nullable()
});
export type PartSchema = z.infer<typeof zPartSchema>;
export type SchemaTier = z.infer<typeof zSchemaTier>;
export type CustomFieldDef = z.infer<typeof zCustomFieldDef>;

export const zNextPn = z.object({
	partNumber: z.string(),
	sequence: z.number().int(),
	tier: z.number().int(),
	tierName: z.string().nullable(),
	defaultTracking: z.enum(TRACKING_TYPES)
});

// ---------------------------------------------------------------- CSV import

export const zImportRowPreview = z.object({
	rowNumber: z.number().int(),
	name: z.string().nullable(),
	externalPn: z.string().nullable(),
	tier: z.number().int().nullable(),
	category: z.string().nullable(),
	unitOfMeasure: z.string().nullable(),
	trackingType: z.string().nullable(),
	procurement: z.string().nullable(),
	description: z.string().nullable(),
	reorderPoint: zQty.nullable(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	valid: z.boolean()
});
export const zImportPreview = z.object({
	totalRows: z.number().int(),
	validRows: z.number().int(),
	errorRows: z.number().int(),
	warningRows: z.number().int(),
	rows: z.array(zImportRowPreview),
	headersFound: z.array(z.string())
});
export const zImportResult = z.object({
	created: z.number().int(),
	skipped: z.number().int(),
	errors: z.array(z.string()),
	firstPn: z.string().nullable(),
	lastPn: z.string().nullable()
});

export type ImportPreview = z.infer<typeof zImportPreview>;
export type ImportPreviewRow = z.infer<typeof zImportRowPreview>;
export type ImportResult = z.infer<typeof zImportResult>;

export const MAX_BULK_PARTS = 500;

const parts_ = {
	// Static paths come first: the registry mounts routes in this order and `/parts/:id` would
	// otherwise swallow `/parts/next-pn`.
	nextPn: op({
		name: 'parts.nextPn',
		method: 'GET',
		path: '/parts/next-pn',
		summary: 'Preview the next part number for a tier without using it.',
		input: z.object({ tier: z.coerce.number().int().min(1) }),
		output: zNextPn,
		access: 'signed-in',
		mcp: true
	}),
	categories: op({
		name: 'parts.categories',
		method: 'GET',
		path: '/parts/categories',
		summary: 'List the categories in use on parts.',
		input: z.object({}),
		output: z.array(z.string()),
		access: 'signed-in',
		mcp: true
	}),
	schema: op({
		name: 'parts.schema',
		method: 'GET',
		path: '/parts/schema',
		summary: 'Tiers, categories, custom fields and the numbering format from the project configuration.',
		input: z.object({}),
		output: zPartSchema,
		access: 'signed-in',
		mcp: true
	}),
	reserve: op({
		name: 'parts.reserve',
		method: 'POST',
		path: '/parts/reserve',
		summary: 'Reserve a block of part numbers as draft parts, for label pre-printing or vendor pre-allocation.',
		input: z.object({
			tier: z.number().int().min(1).default(1),
			count: z.number().int().min(1).max(500),
			namePrefix: z.string().trim().min(1).max(100).optional()
		}),
		output: z.object({ parts: z.array(zPart), firstPn: z.string(), lastPn: z.string() }),
		access: 'signed-in',
		mcp: true
	}),
	importPreview: op({
		name: 'parts.importPreview',
		method: 'POST',
		path: '/parts/import/preview',
		summary: 'Parse and check CSV text for a parts import. Creates nothing.',
		input: z.object({ csv: z.string().min(1) }),
		output: zImportPreview,
		access: 'signed-in',
		mcp: true
	}),
	import: op({
		name: 'parts.import',
		method: 'POST',
		path: '/parts/import',
		summary: 'Create draft parts from checked rows. A bad row is reported and does not stop the others.',
		input: z.object({
			rows: z.array(zPartCreate).max(5000),
			skipDuplicates: z.boolean().default(true)
		}),
		output: zImportResult,
		access: 'signed-in',
		mcp: true
	}),
	activateMany: op({
		name: 'parts.activateMany',
		method: 'POST',
		path: '/parts/activate',
		summary: 'Activate several draft parts. Parts that are not drafts are skipped and reported.',
		input: z.object({
			partIds: z.array(zId).min(1).max(MAX_BULK_PARTS),
			cause: z.string().trim().min(1).max(255).optional()
		}),
		output: z.object({
			activated: z.array(zPart),
			skipped: z.array(z.object({ id: z.number().int(), reason: z.string() }))
		}),
		access: 'signed-in',
		mcp: true
	}),
	createMany: op({
		name: 'parts.createMany',
		method: 'POST',
		path: '/parts/bulk',
		summary: 'Create several draft parts in one transaction. One bad part rejects the batch.',
		input: z.object({ parts: z.array(zPartCreate).min(1).max(MAX_BULK_PARTS) }),
		output: z.object({ parts: z.array(zPart) }),
		access: 'signed-in',
		mcp: true
	}),
	list: op({
		name: 'parts.list',
		method: 'GET',
		path: '/parts',
		summary: 'List parts. Filter by text, state, tier, category, procurement and tooling. Newest first by default.',
		input: zPageInput.extend({
			q: z.string().optional(),
			state: z.enum(PART_STATES).optional(),
			category: z.string().optional(),
			tier: z.coerce.number().int().optional(),
			procurement: z.enum(PROCUREMENT).optional(),
			tooling: zBool.optional(),
			/** Only components of this assembly's BOM. */
			usedIn: zId.optional(),
			/** true: parts that are in no BOM; false: parts that are in at least one. */
			topLevel: zBool.optional(),
			sort: z.enum(PART_SORT_KEYS).default('id'),
			dir: z.enum(['asc', 'desc']).default('desc')
		}),
		output: zPage(zPart),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'parts.create',
		method: 'POST',
		path: '/parts',
		summary: 'Create a draft part. It takes the next number of its tier; with variants on, as variant 001.',
		input: zPartCreate,
		output: zPart,
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'parts.get',
		method: 'GET',
		path: '/parts/:id',
		summary: 'Get one part.',
		input: z.object({ id: zId }),
		output: zPart,
		access: 'signed-in',
		mcp: true
	}),
	detail: op({
		name: 'parts.detail',
		method: 'GET',
		path: '/parts/:id/detail',
		summary: 'The part page: the part, its lifecycle facts, BOM, where-used and its variant family.',
		input: z.object({ id: zId }),
		output: zPartDetail,
		access: 'signed-in',
		mcp: true
	}),
	history: op({
		name: 'parts.history',
		method: 'GET',
		path: '/parts/:id/history',
		summary: 'Audit trail of a part, newest first.',
		input: z.object({ id: zId, limit: z.coerce.number().int().min(1).max(200).default(15) }),
		output: zPartHistory,
		access: 'signed-in',
		mcp: true
	}),
	qrcode: op({
		name: 'parts.qrcode',
		method: 'GET',
		path: '/parts/:id/qrcode',
		summary: 'QR code (SVG text) that links to the part page.',
		input: z.object({ id: zId, origin: z.string().max(200).optional() }),
		output: z.object({ svg: z.string(), url: z.string() }),
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'parts.update',
		method: 'PATCH',
		path: '/parts/:id',
		summary:
			'Edit a part. Omit a field to keep it; send null to clear a nullable field. Part number and tier change only while draft.',
		input: zPartUpdate,
		output: zPart,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'parts.delete',
		method: 'DELETE',
		path: '/parts/:id',
		summary: 'Delete a draft part that nothing references. Its number is retired and never issued again.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	activate: op({
		name: 'parts.activate',
		method: 'POST',
		path: '/parts/:id/activate',
		summary: 'Activate a draft part. This locks its part number and tier for good.',
		input: z.object({ id: zId, cause: z.string().trim().min(1).max(255).optional() }),
		output: zPart,
		access: 'signed-in',
		mcp: true
	}),
	obsolete: op({
		name: 'parts.obsolete',
		method: 'POST',
		path: '/parts/:id/obsolete',
		summary: 'Retire an active part. Records that reference it keep working.',
		input: z.object({ id: zId, cause: z.string().trim().min(1).max(255).optional() }),
		output: zPart,
		access: 'signed-in',
		mcp: true
	})
};

const bom = {
	list: op({
		name: 'parts.bom.list',
		method: 'GET',
		path: '/parts/:id/bom',
		summary: 'The components of an assembly: one level of its BOM.',
		input: z.object({ id: zId }),
		output: z.array(zBomLine),
		access: 'signed-in',
		mcp: true
	}),
	tree: op({
		name: 'parts.bom.tree',
		method: 'GET',
		path: '/parts/:id/bom/tree',
		summary: 'The full BOM of an assembly as a tree, to a depth. Each node carries its quantity in its parent.',
		input: z.object({ id: zId, depth: z.coerce.number().int().min(1).max(50).default(20) }),
		output: zBomTreeNode,
		access: 'signed-in',
		mcp: true
	}),
	whereUsed: op({
		name: 'parts.bom.whereUsed',
		method: 'GET',
		path: '/parts/:id/where-used',
		summary: 'The assemblies that use a part as a component.',
		input: z.object({ id: zId }),
		output: z.array(zBomLine),
		access: 'signed-in',
		mcp: true
	}),
	add: op({
		name: 'parts.bom.add',
		method: 'POST',
		path: '/parts/:id/bom',
		summary: 'Add a component to an assembly. A part cannot contain itself, directly or through a sub-assembly.',
		input: z.object({
			id: zId,
			componentId: zId,
			quantity: zQty.default('1'),
			referenceDesignator: z.string().trim().max(50).nullable().optional(),
			notes: z.string().nullable().optional()
		}),
		output: zBomLine,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'parts.bom.update',
		method: 'PATCH',
		path: '/bom/:lineId',
		summary: 'Change a BOM line. Omit a field to keep it; send null to clear the designator or notes.',
		input: z.object({
			lineId: zId,
			quantity: zQty.optional(),
			referenceDesignator: z.string().trim().max(50).nullable().optional(),
			notes: z.string().nullable().optional()
		}),
		output: zBomLine,
		access: 'signed-in',
		mcp: true
	}),
	remove: op({
		name: 'parts.bom.remove',
		method: 'DELETE',
		path: '/bom/:lineId',
		summary: 'Remove a component from an assembly.',
		input: z.object({ lineId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};

const variants = {
	create: op({
		name: 'parts.variants.create',
		method: 'POST',
		path: '/parts/:id/variants',
		summary:
			'Create a draft variant of a part: the next variant code of its family, same tier, attributes copied unless given. `bom` is source (one line: the source part), copy (its BOM lines) or empty. Refused while variants are off.',
		input: zVariantCreate,
		output: zPart,
		access: 'signed-in',
		mcp: true
	})
};

export const parts = { ...parts_, bom, variants };
