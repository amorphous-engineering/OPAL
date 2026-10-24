import { z } from 'zod';
import { op, zId, zPage, zPageInput } from '../op.ts';
import { zQty } from '../qty.ts';
import { zTimestamp } from '../time.ts';

export const TRACKING_TYPES = ['serialized', 'bulk'] as const;
export const PROCUREMENT = ['make', 'buy', 'both'] as const;
export const PART_STATES = ['draft', 'active', 'obsolete'] as const;

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
	reorderPoint: zQty.nullable(),
	isTooling: z.boolean(),
	calibrationIntervalDays: z.number().int().nullable(),
	state: z.enum(PART_STATES),
	activatedAt: zTimestamp.nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Part = z.infer<typeof zPart>;
export type PartState = (typeof PART_STATES)[number];

export const zPartCreate = z.object({
	name: z.string().trim().min(1).max(255),
	tier: z.number().int().min(1),
	internalPn: z.string().trim().min(1).max(50).optional(),
	externalPn: z.string().trim().max(255).nullable().optional(),
	description: z.string().nullable().optional(),
	category: z.string().trim().max(100).nullable().optional(),
	unitOfMeasure: z.string().trim().min(1).max(20).default('ea'),
	trackingType: z.enum(TRACKING_TYPES).default('bulk'),
	procurement: z.enum(PROCUREMENT).default('make'),
	reorderPoint: zQty.nullable().optional(),
	isTooling: z.boolean().default(false),
	calibrationIntervalDays: z.number().int().positive().nullable().optional()
});

export const parts = {
	list: op({
		name: 'parts.list',
		method: 'GET',
		path: '/parts',
		summary: 'List parts, newest first. Filter by text and state.',
		input: zPageInput.extend({
			q: z.string().optional(),
			state: z.enum(PART_STATES).optional()
		}),
		output: zPage(zPart),
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
	create: op({
		name: 'parts.create',
		method: 'POST',
		path: '/parts',
		summary: 'Create a draft part. A part number is assigned if none is given.',
		input: zPartCreate,
		output: zPart,
		access: 'signed-in',
		mcp: true
	})
};
