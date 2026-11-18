/**
 * Short steps. A sub-step with a title and nothing else is short: the run view draws it as one row
 * with a tick, and the printed traveler prints a run of them as tick rows. Nothing is stored. The
 * rule reads the authored content only, never the state of a run (notes, holds, status), so the
 * screen and the paper agree and a row does not change shape while it is being worked.
 *
 * Both document shapes (the execution document and the published snapshot) reduce to `StepContent`
 * and ask here, so there is one definition.
 */

export interface StepContent {
	instructions: string | null | undefined;
	callouts: readonly { text: string }[] | null | undefined;
	images: readonly unknown[] | null | undefined;
	/** Data capture fields. */
	fieldCount: number;
	/** Parts the step names (consume or tooling). Picking stock happens in the body. */
	kitCount: number;
	signoffs: readonly { role: string | null }[] | null | undefined;
}

/**
 * Only the default slot: one, with no role. A role on the slot or a second slot is an author's
 * declared sign-off. No slot at all is not routine either, so nothing is hidden behind a tick that
 * cannot complete.
 */
export function hasOnlyDefaultSignoff(
	signoffs: readonly { role: string | null }[] | null | undefined
): boolean {
	return signoffs?.length === 1 && !signoffs[0]?.role;
}

/** Title and nothing else: no instructions, pictures, parts, data fields, callouts or declared sign-off. */
export function isShortStep(c: StepContent): boolean {
	return (
		!c.instructions?.trim() &&
		!(c.callouts ?? []).some((x) => x.text.trim()) &&
		(c.images?.length ?? 0) === 0 &&
		c.fieldCount === 0 &&
		c.kitCount === 0 &&
		hasOnlyDefaultSignoff(c.signoffs)
	);
}
