/** Tables for the datasets area. */
import { DATASET_STATES, type DatasetSchema, type PointValues } from '@opal/shared';
import { type AnySQLiteColumn, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { project } from './org.ts'; // added by projects
import { stepExecution } from './execution.ts'; // added by execution

export const dataset = sqliteTable(
	'dataset',
	{
		id: id(),
		projectId: integer('project_id') // added by projects
			.notNull()
			.references(() => project.id),
		name: text('name').notNull(),
		description: text('description'),
		schema: text('schema', { mode: 'json' }).$type<DatasetSchema>().notNull(),
		// Plain integer, no foreign key yet: the procedures table belongs to the procedures area.
		// The lead adds the reference once that table exists.
		procedureId: integer('procedure_id'),
		state: text('state', { enum: DATASET_STATES }).notNull().default('active'),
		archivedAt: text('archived_at'),
		archivedById: integer('archived_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('dataset_name_idx').on(t.name),
		index('dataset_project_idx').on(t.projectId), // added by projects
		index('dataset_procedure_idx').on(t.procedureId),
		oneOf('dataset_state_check', 'state', DATASET_STATES)
	]
);

export const dataPoint = sqliteTable(
	'data_point',
	{
		id: id(),
		datasetId: integer('dataset_id')
			.notNull()
			.references(() => dataset.id, { onDelete: 'cascade' }),
		recordedAt: text('recorded_at').notNull(),
		values: text('values', { mode: 'json' }).$type<PointValues>().notNull(),
		// The step execution that produced the point (wave 3). Plain integer, no foreign key:
		// the execution tables do not exist yet. The execution area resolves it and adds the link.
		stepExecutionId: integer('step_execution_id').references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'set null' }), // added by execution
		createdAt: createdAt()
	},
	(t) => [
		index('data_point_dataset_time_idx').on(t.datasetId, t.recordedAt),
		index('data_point_step_execution_idx').on(t.stepExecutionId)
	]
);
