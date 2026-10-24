/** Test templates per part, test results per stock record, and the test status. */
import {
	type Qty,
	type StockTestResult,
	type StockTestStatus,
	type StockTestTemplate,
	formatQty,
	notFound,
	now,
	parseQty
} from '@opal/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { type Ctx, actorUserId } from '../../context.ts';
import { stockTestResult, testTemplate, user } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { partById, recordById } from './records.ts';

type DbCtx = Pick<Ctx, 'db'>;
type TemplateRow = typeof testTemplate.$inferSelect;
type ResultRow = typeof stockTestResult.$inferSelect;

function toTemplate(t: TemplateRow): StockTestTemplate {
	return {
		id: t.id,
		partId: t.partId,
		name: t.name,
		description: t.description,
		required: t.required,
		testType: t.testType,
		minValue: t.minValue === null ? null : formatQty(t.minValue as Qty),
		maxValue: t.maxValue === null ? null : formatQty(t.maxValue as Qty),
		unit: t.unit,
		sortOrder: t.sortOrder,
		createdAt: t.createdAt
	};
}

function toResult(r: ResultRow, testedByName: string | null): StockTestResult {
	return {
		id: r.id,
		stockId: r.stockId,
		templateId: r.templateId,
		testName: r.testName,
		result: r.result,
		value: r.value,
		notes: r.notes,
		testedAt: r.testedAt,
		testedByName,
		createdAt: r.createdAt
	};
}

export function listTemplates(ctx: DbCtx, partId: number): StockTestTemplate[] {
	partById(ctx, partId);
	return ctx.db
		.select()
		.from(testTemplate)
		.where(eq(testTemplate.partId, partId))
		.orderBy(asc(testTemplate.sortOrder), asc(testTemplate.id))
		.all()
		.map(toTemplate);
}

export function createTemplate(
	ctx: Ctx,
	partId: number,
	input: {
		name: string;
		description?: string | null;
		required: boolean;
		testType: TemplateRow['testType'];
		minValue?: string | null;
		maxValue?: string | null;
		unit?: string | null;
		sortOrder: number;
	}
): StockTestTemplate {
	partById(ctx, partId);
	return toTemplate(
		insert(ctx, testTemplate, {
			partId,
			name: input.name,
			description: input.description ?? null,
			required: input.required,
			testType: input.testType,
			minValue: input.minValue == null ? null : parseQty(input.minValue),
			maxValue: input.maxValue == null ? null : parseQty(input.maxValue),
			unit: input.unit ?? null,
			sortOrder: input.sortOrder
		})
	);
}

/** Results keep their test name, so a deleted template leaves them readable. */
export function deleteTemplate(ctx: Ctx, partId: number, templateId: number): void {
	const t = ctx.db
		.select()
		.from(testTemplate)
		.where(and(eq(testTemplate.id, templateId), eq(testTemplate.partId, partId)))
		.get();
	if (!t) throw notFound('Test template');
	remove(ctx, testTemplate, templateId);
}

export function listResults(ctx: DbCtx, stockId: number): StockTestResult[] {
	return ctx.db
		.select({ r: stockTestResult, by: user.name })
		.from(stockTestResult)
		.leftJoin(user, eq(user.id, stockTestResult.testedById))
		.where(eq(stockTestResult.stockId, stockId))
		.orderBy(desc(stockTestResult.createdAt), desc(stockTestResult.id))
		.all()
		.map((x) => toResult(x.r, x.by));
}

function getResult(ctx: DbCtx, stockId: number, testId: number): StockTestResult {
	const x = ctx.db
		.select({ r: stockTestResult, by: user.name })
		.from(stockTestResult)
		.leftJoin(user, eq(user.id, stockTestResult.testedById))
		.where(and(eq(stockTestResult.id, testId), eq(stockTestResult.stockId, stockId)))
		.get();
	if (!x) throw notFound('Test result');
	return toResult(x.r, x.by);
}

interface ResultInput {
	testName: string;
	templateId?: number | null;
	result: ResultRow['result'];
	value?: string | null;
	notes?: string | null;
}

export function createResult(ctx: Ctx, stockId: number, input: ResultInput): StockTestResult {
	recordById(ctx, stockId);
	if (input.templateId != null) {
		const t = ctx.db.select().from(testTemplate).where(eq(testTemplate.id, input.templateId)).get();
		if (!t) throw notFound(`Test template ${input.templateId}`);
	}
	const row = insert(ctx, stockTestResult, {
		stockId,
		templateId: input.templateId ?? null,
		testName: input.testName,
		result: input.result,
		value: input.value ?? null,
		notes: input.notes ?? null,
		testedAt: input.result === 'pending' ? null : now(),
		testedById: actorUserId(ctx.actor)
	});
	return getResult(ctx, stockId, row.id);
}

export function updateResult(
	ctx: Ctx,
	stockId: number,
	testId: number,
	input: ResultInput
): StockTestResult {
	const cur = getResult(ctx, stockId, testId);
	// The tester is whoever first gave a result other than pending.
	const firstResult = input.result !== 'pending' && !cur.testedAt;
	update(ctx, stockTestResult, testId, {
		testName: input.testName,
		result: input.result,
		value: input.value ?? null,
		notes: input.notes ?? null,
		...(firstResult ? { testedAt: now(), testedById: actorUserId(ctx.actor) } : {})
	});
	return getResult(ctx, stockId, testId);
}

export function deleteResult(ctx: Ctx, stockId: number, testId: number): void {
	getResult(ctx, stockId, testId);
	remove(ctx, stockTestResult, testId);
}

/**
 * Counts by result, and whether every required template of the part has a passing result.
 * Overall: pass needs results, none failed, none pending and every required test passed.
 */
export function testStatus(ctx: DbCtx, stockId: number): StockTestStatus {
	const rec = recordById(ctx, stockId);
	const results = ctx.db
		.select()
		.from(stockTestResult)
		.where(eq(stockTestResult.stockId, stockId))
		.all();
	const count = (r: ResultRow['result']) => results.filter((x) => x.result === r).length;
	const required = ctx.db
		.select()
		.from(testTemplate)
		.where(and(eq(testTemplate.partId, rec.partId), eq(testTemplate.required, true)))
		.orderBy(asc(testTemplate.sortOrder), asc(testTemplate.id))
		.all();
	const missing = required
		.filter((t) => !results.some((x) => x.templateId === t.id && x.result === 'pass'))
		.map((t) => t.name);
	const passed = count('pass');
	const failed = count('fail');
	const pending = count('pending');
	const requiredPassed = missing.length === 0;
	return {
		stockId,
		total: results.length,
		passed,
		failed,
		pending,
		requiredPassed,
		missingRequired: missing,
		overall:
			failed === 0 && pending === 0 && requiredPassed && results.length > 0
				? 'pass'
				: failed > 0
					? 'fail'
					: 'pending'
	};
}
