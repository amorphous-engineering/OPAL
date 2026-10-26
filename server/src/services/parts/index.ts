/** Parts: create, read, edit, delete. Lifecycle, BOM, CSV and history are in sibling files. */
import {
	type Part,
	type PartDetail,
	type PartSchema,
	type PartState,
	type Qty,
	type zPartCreate,
	type zPartUpdate,
	type zVariantCreate,
	conflict,
	formatQty,
	notFound,
	OpalError,
	parseQty
} from '@opal/shared';
import { and, asc, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { bomLine, part, user } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { getProjectConfig, getTier, levelDefaults, numbersFor } from '../org/project.ts';
import { addLine, listLines, whereUsedLines } from './bom.ts';
import { projectFieldDefs, validateMetadata } from './fields.ts';
import {
	allocatePartNumber,
	defaultTracking,
	requireConfiguredTier,
	retirePartNumber
} from './numbering.ts';
import { hasTrackingLock, referenceCounts } from './references.ts';
import { family, familyOf, nextVariantNumber } from './variants.ts';

type Row = typeof part.$inferSelect;
export type PartCreateInput = z.output<typeof zPartCreate>;

/** Tier names by level, read once per request. */
export type TierNames = Map<number, string>;
export function tierNames(db: Db): TierNames {
	return new Map((getProjectConfig(db)?.tiers ?? []).map((t) => [t.level, t.name]));
}

export function toPart(r: Row, names: TierNames): Part {
	return {
		id: r.id,
		internalPn: r.internalPn,
		externalPn: r.externalPn,
		name: r.name,
		description: r.description,
		category: r.category,
		unitOfMeasure: r.unitOfMeasure,
		trackingType: r.trackingType,
		procurement: r.procurement,
		tier: r.tier,
		tierName: names.get(r.tier) ?? null,
		reorderPoint: r.reorderPoint === null ? null : formatQty(r.reorderPoint as Qty),
		isTooling: r.isTooling,
		calibrationIntervalDays: r.calibrationIntervalDays,
		metadata: r.metadata ?? null,
		state: r.state,
		activatedAt: r.activatedAt,
		activationCause: r.activationCause,
		obsoletedAt: r.obsoletedAt,
		obsoleteCause: r.obsoleteCause,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

export function getRow(ctx: Pick<Ctx, 'db'>, id: number): Row {
	const row = ctx.db.select().from(part).where(eq(part.id, id)).get();
	if (!row) throw notFound('Part');
	return row;
}

export function present(ctx: Pick<Ctx, 'db'>, row: Row): Part {
	return toPart(row, tierNames(ctx.db));
}

// ---------------------------------------------------------------- read

const SORT = {
	id: part.id,
	internalPn: part.internalPn,
	externalPn: part.externalPn,
	name: sql`lower(${part.name})`,
	category: part.category,
	tier: part.tier,
	state: part.state,
	procurement: part.procurement,
	unitOfMeasure: part.unitOfMeasure,
	createdAt: part.createdAt,
	updatedAt: part.updatedAt
} as const;

interface ListInput {
	cursor?: string;
	limit: number;
	q?: string;
	state?: PartState;
	category?: string;
	tier?: number;
	procurement?: Part['procurement'];
	tooling?: boolean;
	usedIn?: number;
	topLevel?: boolean;
	sort: keyof typeof SORT;
	dir: 'asc' | 'desc';
}

/** The cursor is the offset of the next page: any sort order paginates the same way. */
export function list(ctx: Ctx, input: ListInput) {
	const q = input.q?.trim();
	const where = and(
		input.state ? eq(part.state, input.state) : undefined,
		input.category ? eq(part.category, input.category) : undefined,
		input.tier !== undefined ? eq(part.tier, input.tier) : undefined,
		input.procurement ? eq(part.procurement, input.procurement) : undefined,
		input.tooling !== undefined ? eq(part.isTooling, input.tooling) : undefined,
		input.usedIn !== undefined
			? inArray(part.id, ctx.db.select({ id: bomLine.componentId }).from(bomLine).where(eq(bomLine.assemblyId, input.usedIn)))
			: undefined,
		input.topLevel === true
			? notInArray(part.id, ctx.db.select({ id: bomLine.componentId }).from(bomLine))
			: input.topLevel === false
				? inArray(part.id, ctx.db.select({ id: bomLine.componentId }).from(bomLine))
				: undefined,
		q
			? or(
					like(part.name, `%${q}%`),
					like(part.internalPn, `%${q}%`),
					like(part.externalPn, `%${q}%`),
					like(part.description, `%${q}%`)
				)
			: undefined
	);
	const offset = Math.max(0, Number(input.cursor) || 0);
	const dir = input.dir === 'asc' ? asc : desc;
	const rows = ctx.db
		.select()
		.from(part)
		.where(where)
		.orderBy(dir(SORT[input.sort]), desc(part.id))
		.limit(input.limit + 1)
		.offset(offset)
		.all();
	const names = tierNames(ctx.db);
	return {
		items: rows.slice(0, input.limit).map((r) => toPart(r, names)),
		next: rows.length > input.limit ? String(offset + input.limit) : null
	};
}

export function get(ctx: Ctx, id: number): Part {
	return present(ctx, getRow(ctx, id));
}

export function detail(ctx: Ctx, id: number): PartDetail {
	const row = getRow(ctx, id);
	const activator = row.activatedById
		? ctx.db.select({ name: user.name }).from(user).where(eq(user.id, row.activatedById)).get()
		: undefined;
	const refs = referenceCounts(ctx, id);
	const config = getProjectConfig(ctx.db);
	return {
		part: present(ctx, row),
		tierCode: getTier(config, row.tier)?.code ?? null,
		activatedBy: activator?.name ?? null,
		expects: sectionExpectations(row.procurement),
		references: refs,
		deletable: row.state === 'draft' && Object.keys(refs).length === 0,
		bom: listLines(ctx, id),
		whereUsed: whereUsedLines(ctx, id),
		family: family(ctx.db, row)
	};
}

/** BOM expects content on make|both; suppliers and PO lines on buy|both. */
export function sectionExpectations(procurement: Part['procurement']) {
	return {
		bom: procurement === 'make' || procurement === 'both',
		suppliers: procurement === 'buy' || procurement === 'both',
		poLines: procurement === 'buy' || procurement === 'both'
	};
}

export function categories(ctx: Ctx): string[] {
	const rows = ctx.db.selectDistinct({ c: part.category }).from(part).where(sql`${part.category} is not null`).all();
	return rows.map((r) => r.c!).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function schema(ctx: Ctx): PartSchema {
	const config = getProjectConfig(ctx.db);
	const tiers = config
		? config.tiers.map((t) => ({ ...t }))
		: [1, 2, 3].map((level) => ({
				level,
				name: `Tier ${level}`,
				code: String(level),
				description: '',
				...levelDefaults(level)
			}));
	const all = new Set([...categories(ctx), ...(config?.categories ?? [])]);
	return {
		tiers,
		categories: [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
		customFields: projectFieldDefs(ctx.db),
		numberingFormat: config?.partNumbering.format ?? null
	};
}

// ---------------------------------------------------------------- write

function reorderQty(value: string | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value;
	const q = parseQty(value);
	if (q < 0) throw new OpalError(422, 'invalid_input', 'Invalid input', { reorderPoint: 'must not be negative' });
	return q;
}

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v);

/** Create one draft part. Parts are born draft; activation is a deliberate act. */
export function createRow(ctx: Ctx, input: PartCreateInput): Row {
	requireConfiguredTier(ctx.db, input.tier);
	const reorderPoint = reorderQty(input.reorderPoint) ?? null;
	const metadata = validateMetadata(ctx.db, input.metadata, { requireAll: true });
	if (input.assemblyId !== undefined) getRow(ctx, input.assemblyId);
	const externalPn = blank(input.externalPn) ?? null;
	const row = insert(ctx, part, {
		internalPn: allocateFor(ctx, input.tier),
		externalPn,
		name: input.name,
		description: blank(input.description) ?? null,
		category: blank(input.category) ?? null,
		unitOfMeasure: input.unitOfMeasure,
		trackingType: input.trackingType ?? defaultTracking(ctx.db, input.tier),
		procurement: input.procurement ?? (externalPn ? 'buy' : 'make'),
		tier: input.tier,
		reorderPoint,
		isTooling: input.isTooling,
		calibrationIntervalDays: input.calibrationIntervalDays ?? null,
		metadata,
		state: 'draft'
	});
	if (input.assemblyId !== undefined) {
		addLine(ctx, { assemblyId: input.assemblyId, componentId: row.id, quantity: input.assemblyQuantity ?? '1' });
	}
	return row;
}

export function create(ctx: Ctx, input: PartCreateInput): Part {
	return present(ctx, createRow(ctx, input));
}

export function createMany(ctx: Ctx, inputs: PartCreateInput[]): Part[] {
	const names = tierNames(ctx.db);
	return inputs.map((i) => toPart(createRow(ctx, i), names));
}

export function updatePart(ctx: Ctx, input: z.output<typeof zPartUpdate>): Part {
	const row = getRow(ctx, input.id);
	const patch: Partial<typeof part.$inferInsert> = {};

	// Identity (number, tier) changes only while draft.
	const tierChange = input.tier !== undefined && input.tier !== row.tier;
	if (tierChange && row.state !== 'draft') {
		throw conflict(
			'identity_locked',
			`${row.internalPn} is ${row.state}: its tier cannot change`
		);
	}
	// Tracking decides how stock is stored (one record per unit or one lump).
	if (input.trackingType !== undefined && input.trackingType !== row.trackingType) {
		if (hasTrackingLock(ctx, row.id)) {
			throw conflict('has_stock', `${row.internalPn} has stock records: tracking cannot change`);
		}
		patch.trackingType = input.trackingType;
	}
	if (tierChange) {
		const tier = input.tier!;
		// A tier change takes a fresh number from the new tier's counter.
		const next = allocateFor(ctx, tier);
		retirePartNumber(ctx, row.internalPn, 'replaced');
		patch.internalPn = next;
		patch.tier = tier;
	}
	if (input.name !== undefined) patch.name = input.name;
	if (input.unitOfMeasure !== undefined) patch.unitOfMeasure = input.unitOfMeasure;
	if (input.procurement !== undefined) patch.procurement = input.procurement;
	if (input.externalPn !== undefined) patch.externalPn = blank(input.externalPn);
	if (input.description !== undefined) patch.description = blank(input.description);
	if (input.category !== undefined) patch.category = blank(input.category);
	if (input.reorderPoint !== undefined) patch.reorderPoint = reorderQty(input.reorderPoint);
	if (input.isTooling !== undefined) patch.isTooling = input.isTooling;
	if (input.calibrationIntervalDays !== undefined) patch.calibrationIntervalDays = input.calibrationIntervalDays;
	if (input.metadata !== undefined) {
		patch.metadata = input.metadata === null ? null : validateMetadata(ctx.db, input.metadata, { requireAll: true });
	}
	if (Object.keys(patch).length === 0) return present(ctx, row);
	return present(ctx, update(ctx, part, row.id, patch));
}

function allocateFor(ctx: Ctx, tier: number): string {
	requireConfiguredTier(ctx.db, tier);
	return allocatePartNumber(ctx, tier);
}

/**
 * Delete a draft part that nothing references. Referenced things leave by state change,
 * stillborn things by deletion. The number stays taken.
 */
export function deletePart(ctx: Ctx, id: number): void {
	const row = getRow(ctx, id);
	if (row.state !== 'draft') {
		throw conflict('not_deletable', `${row.internalPn} is ${row.state} and cannot be deleted`);
	}
	const refs = referenceCounts(ctx, id);
	if (Object.keys(refs).length) {
		const list = Object.entries(refs).map(([k, n]) => `${n} ${k}`).join(', ');
		throw conflict(
			'referenced',
			`Draft part ${row.internalPn} is referenced (${list}); remove the references first`
		);
	}
	retirePartNumber(ctx, row.internalPn, 'deleted');
	remove(ctx, part, id);
}

/** Reserve a block of numbers as draft rows: stale reservations stay visible, not invisible holes. */
export function reserve(ctx: Ctx, input: { tier: number; count: number; namePrefix?: string }) {
	requireConfiguredTier(ctx.db, input.tier);
	const names = tierNames(ctx.db);
	const prefix = input.namePrefix ?? 'RESERVED';
	const parts: Part[] = [];
	for (let i = 0; i < input.count; i++) {
		const pn = allocatePartNumber(ctx, input.tier);
		// The sequence names the reservation, not the variant code.
		const digits = /(\d+)$/.exec(numbersFor(ctx.db).split(pn)?.base ?? pn)?.[1] ?? pn;
		const row = insert(ctx, part, {
			internalPn: pn,
			name: `${prefix}-${digits}`,
			unitOfMeasure: 'ea',
			trackingType: defaultTracking(ctx.db, input.tier),
			procurement: 'make',
			tier: input.tier,
			isTooling: false,
			state: 'draft'
		});
		parts.push(toPart(row, names));
	}
	return { parts, firstPn: parts[0]!.internalPn, lastPn: parts.at(-1)!.internalPn };
}

/**
 * A draft variant of a part: the next code of its family, in the same tier. Attributes come
 * from the source unless given. Stock, history, attachments and links stay with the source.
 */
export function createVariant(ctx: Ctx, input: z.output<typeof zVariantCreate>): Part {
	const src = getRow(ctx, input.id);
	const config = getProjectConfig(ctx.db);
	if (!config?.partNumbering.variants) {
		throw conflict('variants_off', 'Part number variants are off; an admin turns them on in the numbering settings');
	}
	const keep = <T>(given: T | undefined, old: T): T => (given === undefined ? old : given);
	const row = insert(ctx, part, {
		internalPn: nextVariantNumber(ctx, familyOf(ctx.db, src.internalPn)),
		externalPn: keep(blank(input.externalPn), src.externalPn),
		name: input.name ?? src.name,
		description: keep(blank(input.description), src.description),
		category: keep(blank(input.category), src.category),
		unitOfMeasure: input.unitOfMeasure ?? src.unitOfMeasure,
		trackingType: input.trackingType ?? src.trackingType,
		procurement: input.procurement ?? src.procurement,
		tier: src.tier,
		reorderPoint: keep(reorderQty(input.reorderPoint), src.reorderPoint),
		isTooling: input.isTooling ?? src.isTooling,
		calibrationIntervalDays: keep(input.calibrationIntervalDays, src.calibrationIntervalDays),
		metadata:
			input.metadata === undefined
				? (src.metadata ?? null)
				: input.metadata === null
					? null
					: validateMetadata(ctx.db, input.metadata, { requireAll: true }),
		state: 'draft'
	});
	if (input.bom === 'source') {
		addLine(ctx, { assemblyId: row.id, componentId: src.id, quantity: '1' });
	} else if (input.bom === 'copy') {
		for (const l of listLines(ctx, src.id)) {
			addLine(ctx, {
				assemblyId: row.id,
				componentId: l.componentId,
				quantity: l.quantity,
				referenceDesignator: l.referenceDesignator,
				notes: l.notes
			});
		}
	}
	return present(ctx, row);
}
