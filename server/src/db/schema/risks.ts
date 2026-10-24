/** Tables for the risks area. */
import {
	RISK_DISPOSITIONS,
	RISK_REFERENCE_TYPES
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { issue } from './issues.ts';
import { project } from './org.ts'; // added by projects
import { part } from './parts.ts';

const userRef = (name: string) =>
	integer(name).references(() => user.id, { onDelete: 'set null' });

/**
 * A scenario-structured risk: condition, departure, asset, consequence. The prose statement is
 * generated from the parts and never stored. Responses are issues, linked through `issue_link`
 * (kind risk, with a role). A realized risk points at its issue by `realized_issue_id`.
 */
export const risk = sqliteTable(
	'risk',
	{
		id: id(),
		riskNumber: text('risk_number').notNull().unique(),
		projectId: integer('project_id') // added by projects
			.notNull()
			.references(() => project.id),
		title: text('title').notNull(),
		/** Narrative: context, evidence, suggested responses. */
		description: text('description'),
		condition: text('condition'),
		departure: text('departure'),
		/** The exposed asset: a part, or free text. At most one is set. */
		assetPartId: integer('asset_part_id').references(() => part.id, { onDelete: 'set null' }),
		assetText: text('asset_text'),
		consequence: text('consequence'),
		disposition: text('disposition', { enum: RISK_DISPOSITIONS }).notNull().default('open'),
		/** The note given with the latest disposition change; history shows it on that change. */
		dispositionNote: text('disposition_note'),
		ownerId: userRef('owner_id'),
		probability: integer('probability').notNull().default(3),
		impact: integer('impact').notNull().default(3),
		residualProbability: integer('residual_probability'),
		residualImpact: integer('residual_impact'),
		acceptedById: userRef('accepted_by_id'),
		acceptedAt: text('accepted_at'),
		acceptanceRationale: text('acceptance_rationale'),
		watchObservable: text('watch_observable'),
		watchThreshold: text('watch_threshold'),
		watchContingency: text('watch_contingency'),
		lastReviewedAt: text('last_reviewed_at'),
		lastReviewedById: userRef('last_reviewed_by_id'),
		realizedIssueId: integer('realized_issue_id').references(() => issue.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('risk_disposition_idx').on(t.disposition),
		index('risk_project_idx').on(t.projectId), // added by projects
		index('risk_owner_idx').on(t.ownerId),
		index('risk_asset_part_idx').on(t.assetPartId),
		index('risk_realized_issue_idx').on(t.realizedIssueId),
		oneOf('risk_disposition_check', 'disposition', RISK_DISPOSITIONS),
		check('risk_probability_check', sql.raw('"probability" BETWEEN 1 AND 5')),
		check('risk_impact_check', sql.raw('"impact" BETWEEN 1 AND 5')),
		check(
			'risk_residual_probability_check',
			sql.raw('"residual_probability" IS NULL OR "residual_probability" BETWEEN 1 AND 5')
		),
		check(
			'risk_residual_impact_check',
			sql.raw('"residual_impact" IS NULL OR "residual_impact" BETWEEN 1 AND 5')
		),
		check(
			'risk_one_asset_check',
			sql.raw('"asset_part_id" IS NULL OR "asset_text" IS NULL')
		)
	]
);

/** An OPAL number or a work order number a risk refers to. */
export const riskReference = sqliteTable(
	'risk_reference',
	{
		id: id(),
		riskId: integer('risk_id')
			.notNull()
			.references(() => risk.id, { onDelete: 'cascade' }),
		referenceType: text('reference_type', { enum: RISK_REFERENCE_TYPES }).notNull(),
		referenceValue: text('reference_value').notNull(),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('risk_reference_uq').on(t.riskId, t.referenceType, t.referenceValue),
		index('risk_reference_value_idx').on(t.referenceValue),
		oneOf('risk_reference_type_check', 'reference_type', RISK_REFERENCE_TYPES)
	]
);
