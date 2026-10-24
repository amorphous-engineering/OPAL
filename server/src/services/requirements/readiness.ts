/**
 * Baseline readiness as structured checks: the dossier panel and the queue payload.
 *
 * Hard checks regroup the block_baseline lint findings, so this agrees with what baselining
 * enforces by construction. The parent check is relational and advisory: flowing down from an
 * unbaselined parent is suspect but never blocks.
 */
import type { RequirementCheck, RequirementFinding, RequirementReadiness } from '@opal/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { requirement } from '../../db/schema/index.ts';
import { EDITABLE, type RequirementRow } from './lifecycle.ts';
import { lintRow } from './lint.ts';

function check(
	key: string,
	label: string,
	failing: RequirementFinding[],
	severity: 'hard' | 'warning' = 'hard'
): RequirementCheck {
	let detail: string | null = null;
	if (failing.length) {
		const messages = [...new Set(failing.map((f) => f.message))];
		detail = messages[0]! + (messages.length > 1 ? ` (+${messages.length - 1} more)` : '');
	}
	return { key, label, passed: !failing.length, severity, detail };
}

export function readiness(ctx: Pick<Ctx, 'db'>, r: RequirementRow): RequirementReadiness {
	const block = lintRow(r).filter((f) => f.severity === 'block_baseline');
	const rationale = block.filter((f) => f.name === 'rationale_present');
	const tbd = block.filter((f) => f.name === 'tbd_tbr_discipline' && f.message.includes('TBD'));
	const tbr = block.filter((f) => f.name === 'tbd_tbr_discipline' && f.message.startsWith('TBR'));
	const verification = block.filter((f) => f.name === 'verification_method_set');
	const grouped = new Set([...rationale, ...tbd, ...tbr, ...verification]);
	const rest = block.filter((f) => !grouped.has(f));

	const checks: RequirementCheck[] = [
		check('rationale_present', 'rationale recorded', rationale),
		check('no_tbd', 'no TBD values', tbd),
		check('tbr_fields', 'TBR has owner and due date', tbr),
		check('verification_method', 'verification method set', verification),
		check('lint_clean', 'statement lint clean', rest)
	];

	let parentDetail: string | null = null;
	if (r.parentId !== null) {
		const parent = ctx.db.select().from(requirement).where(eq(requirement.id, r.parentId)).get();
		if (parent && parent.lifecycleState !== 'baselined') {
			parentDetail = `${parent.reqNumber} is ${parent.lifecycleState}`;
		}
	}
	checks.push({
		key: 'parent_baselined',
		label: 'parent is baselined',
		passed: parentDetail === null,
		severity: 'warning',
		detail: parentDetail
	});

	const ready =
		EDITABLE.includes(r.lifecycleState) &&
		checks.filter((c) => c.severity === 'hard').every((c) => c.passed);
	return { ready, checks };
}

/** The draft and preliminary rows that would baseline cleanly, in level then number order. */
export function readyRows(ctx: Pick<Ctx, 'db'>, projectId?: number): RequirementRow[] {
	return ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				inArray(requirement.lifecycleState, [...EDITABLE]),
				projectId !== undefined ? eq(requirement.projectId, projectId) : undefined // added by projects
			)
		)
		.orderBy(asc(requirement.level), asc(requirement.reqNumber))
		.all()
		.filter((r) => readiness(ctx, r).ready);
}
