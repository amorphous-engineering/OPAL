import { describe, expect, test } from 'bun:test';
import type { ProcedureSnapshot, SnapshotStep } from '@opal/shared';
import { diffSteps } from '../../src/services/procedures/diff.ts';
import { currentNumber } from '../../src/services/procedures/tree.ts';

const step = (id: number, number: string, over: Partial<SnapshotStep> = {}): SnapshotStep => ({
	id,
	order: id,
	number,
	level: number.includes('.') ? 1 : 0,
	parentId: null,
	title: `Step ${id}`,
	instructions: null,
	dataSchema: null,
	isContingency: number.startsWith('C'),
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

const snap = (steps: SnapshotStep[]): ProcedureSnapshot => ({
	schemaVersion: 1,
	procedure: { templateNumber: 'T-0001', projectId: 1, name: 'P', description: null, procedureType: 'op' },
	steps,
	kit: [],
	outputs: []
});

describe('contingency numbers', () => {
	test('a number from before the 900 series maps to the series, and no other number changes', () => {
		expect(currentNumber('C1')).toBe('C901');
		expect(currentNumber('C2.3')).toBe('C902.3');
		expect(currentNumber('C901')).toBe('C901');
		expect(currentNumber('C1000.1')).toBe('C1000.1');
		expect(currentNumber('1.2')).toBe('1.2');
	});

	test('comparing a version published as C1 with one published as C901 shows the same step, not a removal and an addition', () => {
		const before = snap([step(1, '1'), step(2, 'C1'), step(3, 'C1.1')]);
		const after = snap([step(1, '1'), step(2, 'C901'), step(3, 'C901.1')]);
		expect(diffSteps(before, after).map((d) => [d.number, d.status])).toEqual([
			['1', 'unchanged'],
			['C901', 'unchanged'],
			['C901.1', 'unchanged']
		]);
	});
});
