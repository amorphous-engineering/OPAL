/**
 * Datasets: their own store of measurements. A dataset has a field schema; its data points are
 * validated against it. A point may name the step execution that produced it, but nothing
 * captures points automatically (decision O1).
 */
import { z } from 'zod';
import { op, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zTimestamp } from '../time.ts';

export const FIELD_TYPES = ['number', 'text', 'boolean', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** `archived` is terminal: a dataset with points is archived, never deleted (CLAUDE.md rule 6). */
export const DATASET_STATES = ['active', 'archived'] as const;
export type DatasetState = (typeof DATASET_STATES)[number];

export const MAX_CHART_POINTS = 1000;
export const MAX_IMPORT_POINTS = 5000;

export const zSchemaField = z
	.object({
		name: z.string().trim().min(1).max(100),
		type: z.enum(FIELD_TYPES),
		unit: z.string().trim().min(1).max(40).optional(),
		/** Numbers only: offer the field in the chart. */
		chart: z.boolean().optional(),
		/** A point must carry a value for this field. */
		required: z.boolean().optional(),
		/** Numbers only: inclusive bounds on a value. */
		min: z.number().optional(),
		max: z.number().optional()
	})
	.refine((f) => f.type === 'number' || (f.min === undefined && f.max === undefined && !f.chart), {
		message: 'Only number fields take min, max or chart',
		path: ['type']
	})
	.refine((f) => f.min === undefined || f.max === undefined || f.min <= f.max, {
		message: 'min is above max',
		path: ['min']
	});
export type SchemaField = z.infer<typeof zSchemaField>;

export const zDatasetSchema = z
	.object({ fields: z.array(zSchemaField).max(100) })
	.superRefine((s, ctx) => {
		const seen = new Set<string>();
		s.fields.forEach((f, i) => {
			if (seen.has(f.name)) {
				ctx.addIssue({ code: 'custom', message: `Field '${f.name}' is used twice`, path: ['fields', i, 'name'] });
			}
			seen.add(f.name);
		});
	});
export type DatasetSchema = z.infer<typeof zDatasetSchema>;

export const zPointValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const zPointValues = z.record(z.string(), zPointValue);
export type PointValues = z.infer<typeof zPointValues>;

export const zDataset = z.object({
	id: z.number().int(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	name: z.string(),
	description: z.string().nullable(),
	schema: zDatasetSchema,
	/** The procedure this dataset belongs to; the name comes from the procedures area. */
	procedureId: z.number().int().nullable(),
	state: z.enum(DATASET_STATES),
	archivedAt: zTimestamp.nullable(),
	pointCount: z.number().int(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Dataset = z.infer<typeof zDataset>;

export const zDataPoint = z.object({
	id: z.number().int(),
	datasetId: z.number().int(),
	recordedAt: zTimestamp,
	values: zPointValues,
	/** The step execution that produced the point. Resolved by the execution area. */
	stepExecutionId: z.number().int().nullable(),
	createdAt: zTimestamp
});
export type DataPoint = z.infer<typeof zDataPoint>;

const zRecordedAt = z.iso.datetime({ offset: true });
const zName = z.string().trim().min(1).max(255);
const zQueryId = z.coerce.number().int().positive();

export const zChart = z.object({
	field: z.string(),
	unit: z.string().nullable(),
	/** Oldest first. `value` is null where a point has no number for the field. */
	series: z.array(z.object({ recordedAt: zTimestamp, value: z.number().nullable() }))
});
export type Chart = z.infer<typeof zChart>;

export const zDatasetImportResult = z.object({ imported: z.number().int(), pointIds: z.array(z.number().int()) });

const idOnly = z.object({ id: zId });

export const datasets = {
	list: op({
		name: 'datasets.list',
		method: 'GET',
		path: '/datasets',
		summary: 'List datasets, newest first. Filter by name, procedure and state.',
		input: zPageInput.extend({
			q: z.string().optional(),
			projectId: zQueryId.optional(), // added by projects
			procedureId: zQueryId.optional(),
			state: z.enum(DATASET_STATES).optional()
		}),
		output: zPage(zDataset),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'datasets.create',
		method: 'POST',
		path: '/datasets',
		summary: 'Create a dataset with a field schema.',
		input: z.object({
			projectId: zId, // added by projects
			name: zName,
			description: z.string().trim().nullish(),
			schema: zDatasetSchema,
			procedureId: zId.nullish()
		}),
		output: zDataset,
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'datasets.get',
		method: 'GET',
		path: '/datasets/:id',
		summary: 'Read one dataset.',
		input: idOnly,
		output: zDataset,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'datasets.update',
		method: 'PATCH',
		path: '/datasets/:id',
		summary: 'Change a dataset. A null description or procedure clears it. Archived datasets are read-only.',
		input: z.object({
			id: zId,
			projectId: zId.optional(), // added by projects
			name: zName.optional(),
			description: z.string().trim().nullish(),
			schema: zDatasetSchema.optional(),
			procedureId: zId.nullish()
		}),
		output: zDataset,
		access: 'signed-in',
		mcp: true
	}),
	archive: op({
		name: 'datasets.archive',
		method: 'POST',
		path: '/datasets/:id/archive',
		summary: 'Archive a dataset: terminal. It keeps its points and takes no new ones.',
		input: idOnly,
		output: zDataset,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'datasets.delete',
		method: 'DELETE',
		path: '/datasets/:id',
		summary: 'Delete a dataset that has no points. A dataset with points is archived instead.',
		input: idOnly,
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	exportCsv: op({
		name: 'datasets.exportCsv',
		method: 'GET',
		path: '/datasets/:id/export',
		summary: 'Every point of a dataset as CSV text (recorded_at, then one column per field).',
		input: idOnly,
		output: z.string(),
		produces: 'text/csv',
		access: 'signed-in',
		mcp: true
	}),
	chart: op({
		name: 'datasets.chart',
		method: 'GET',
		path: '/datasets/:id/chart',
		summary: 'The series of one field over time, oldest first, for graphing.',
		input: z.object({
			id: zId,
			field: z.string().min(1),
			start: zRecordedAt.optional(),
			end: zRecordedAt.optional(),
			limit: z.coerce.number().int().min(1).max(MAX_CHART_POINTS).default(MAX_CHART_POINTS)
		}),
		output: zChart,
		access: 'signed-in',
		mcp: true
	}),
	points: {
		list: op({
			name: 'datasets.points.list',
			method: 'GET',
			path: '/datasets/:id/points',
			summary: 'List the points of a dataset. Newest first unless order is asc.',
			input: zPageInput.extend({
				id: zId,
				start: zRecordedAt.optional(),
				end: zRecordedAt.optional(),
				order: z.enum(['asc', 'desc']).default('desc')
			}),
			output: zPage(zDataPoint),
			access: 'signed-in',
			mcp: true
		}),
		// Static path before `/datasets/:id/points/:pointId`.
		import: op({
			name: 'datasets.points.import',
			method: 'POST',
			path: '/datasets/:id/points/import',
			summary:
				'Import points from CSV text. The header names the fields; an optional recorded_at column sets the time. All rows are checked first: one bad row imports nothing.',
			input: z.object({ id: zId, csv: z.string().min(1) }),
			output: zDatasetImportResult,
			access: 'signed-in',
			mcp: true
		}),
		add: op({
			name: 'datasets.points.add',
			method: 'POST',
			path: '/datasets/:id/points',
			summary: 'Add a point. The values are checked against the dataset schema.',
			input: z.object({
				id: zId,
				recordedAt: zRecordedAt.optional(),
				values: zPointValues,
				stepExecutionId: zId.nullish()
			}),
			output: zDataPoint,
			access: 'signed-in',
			mcp: true
		}),
		remove: op({
			name: 'datasets.points.remove',
			method: 'DELETE',
			path: '/datasets/:id/points/:pointId',
			summary: 'Delete a point.',
			input: z.object({ id: zId, pointId: zId }),
			output: zOk,
			access: 'signed-in',
			mcp: true
		})
	}
};
