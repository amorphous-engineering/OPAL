/** Pure facts derived from a risk row: scores, the asset line, the generated statement. */
import { riskSeverityFor, type RiskSeverity } from '@opal/shared';
import type { risk } from '../../db/schema/index.ts';

export type RiskRow = typeof risk.$inferSelect;

export const blank = (v: string | null | undefined) => !v || !v.trim();

export const score = (r: Pick<RiskRow, 'probability' | 'impact'>) => r.probability * r.impact;

export function residualScore(r: Pick<RiskRow, 'residualProbability' | 'residualImpact'>) {
	return r.residualProbability === null || r.residualImpact === null
		? null
		: r.residualProbability * r.residualImpact;
}

export const severity = (n: number): RiskSeverity => riskSeverityFor(n);

/** Exactly one asset form set, and the other three parts present. */
export function scenarioComplete(r: RiskRow): boolean {
	const hasAsset = r.assetPartId !== null !== !blank(r.assetText);
	return !blank(r.condition) && !blank(r.departure) && hasAsset && !blank(r.consequence);
}

/** The generated NASA-format statement. Null until the scenario is complete. */
export function statement(r: RiskRow, assetDisplay: string | null): string | null {
	if (!scenarioComplete(r)) return null;
	const clean = (s: string | null) => s!.trim().replace(/\.+$/, '');
	return `Given that ${clean(r.condition)}, there is a possibility of ${clean(r.departure)} adversely impacting ${assetDisplay}, thereby leading to ${clean(r.consequence)}.`;
}
