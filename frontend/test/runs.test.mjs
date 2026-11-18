// The printed traveler prints a run of short steps as tick rows and every long step as a block.
import { expect, test } from 'bun:test';
import { isShortSnapshotStep, stepRuns } from '../src/lib/components/procedures/runs.ts';

let id = 0;
const step = (over = {}) => ({
	id: ++id,
	order: id,
	number: `1.${id}`,
	level: 1,
	parentId: 1,
	title: `Step ${id}`,
	instructions: null,
	dataSchema: null,
	isContingency: false,
	strictSequence: false,
	estimatedDurationMinutes: null,
	workcenterId: null,
	signoffs: [{ label: 'Primary buyoff', role: null }],
	callouts: [],
	dependsOn: [],
	images: [],
	kit: [],
	...over
});

test('a snapshot sub-step with a title and nothing else is short, an OP never is', () => {
	expect(isShortSnapshotStep(step())).toBe(true);
	expect(isShortSnapshotStep(step({ level: 0 }))).toBe(false);
	expect(isShortSnapshotStep(step({ instructions: 'Do it.' }))).toBe(false);
	expect(isShortSnapshotStep(step({ dataSchema: { fields: [{ name: 'a', type: 'text' }] } }))).toBe(
		false
	);
	expect(isShortSnapshotStep(step({ signoffs: [{ label: 'Primary buyoff', role: 'QA' }] }))).toBe(
		false
	);
});

test('consecutive short steps print as one run, and a long step breaks it', () => {
	const a = step();
	const b = step();
	const long = step({ instructions: 'Spark check.' });
	const c = step();
	const runs = stepRuns([a, b, long, c]);
	expect(runs.map((r) => [r.short, r.steps.length])).toEqual([
		[true, 2],
		[false, 1],
		[true, 1]
	]);
	expect(runs[0].steps).toEqual([a, b]);
});

test('an operation with no sub-steps has no runs', () => {
	expect(stepRuns([])).toEqual([]);
});
