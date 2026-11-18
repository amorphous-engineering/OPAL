import { isShortStep, type SnapshotStep } from '@opal/shared';

/** A sub-step of a snapshot that is a title and nothing else (see `isShortStep`). */
export function isShortSnapshotStep(s: SnapshotStep): boolean {
	return (
		s.level > 0 &&
		isShortStep({
			instructions: s.instructions,
			callouts: s.callouts,
			images: s.images,
			fieldCount: s.dataSchema?.fields.length ?? 0,
			kitCount: s.kit.length,
			signoffs: s.signoffs
		})
	);
}

/** Consecutive short steps in one run, which the traveler prints as tick rows. A long step is a run of one. */
export interface StepRun {
	short: boolean;
	steps: SnapshotStep[];
}

export function stepRuns(subs: SnapshotStep[]): StepRun[] {
	const runs: StepRun[] = [];
	for (const s of subs) {
		const short = isShortSnapshotStep(s);
		const last = runs.at(-1);
		if (short && last?.short) last.steps.push(s);
		else runs.push({ short, steps: [s] });
	}
	return runs;
}
