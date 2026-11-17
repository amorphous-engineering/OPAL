import { describe, expect, test } from 'bun:test';
import { isShortStep, type StepContent } from './short-step.ts';

const bare: StepContent = {
	instructions: null,
	callouts: [],
	images: [],
	fieldCount: 0,
	kitCount: 0,
	signoffs: [{ role: null }]
};

describe('short step', () => {
	test('a step with a title and nothing else is short', () => {
		expect(isShortStep(bare)).toBe(true);
	});

	test('blank instructions and an empty callout are still nothing', () => {
		expect(isShortStep({ ...bare, instructions: '' })).toBe(true);
		expect(isShortStep({ ...bare, instructions: '  \n ' })).toBe(true);
		expect(isShortStep({ ...bare, callouts: [{ text: '  ' }] })).toBe(true);
	});

	test('any body makes a step long', () => {
		expect(isShortStep({ ...bare, instructions: 'Flip the switch.' })).toBe(false);
		expect(isShortStep({ ...bare, callouts: [{ text: 'Eye protection.' }] })).toBe(false);
		expect(isShortStep({ ...bare, images: [{}] })).toBe(false);
		expect(isShortStep({ ...bare, fieldCount: 1 })).toBe(false);
		expect(isShortStep({ ...bare, kitCount: 1 })).toBe(false);
	});

	test('a declared sign-off makes a step long: a role on the slot, or a second slot', () => {
		expect(isShortStep({ ...bare, signoffs: [{ role: 'Launch Director' }] })).toBe(false);
		expect(isShortStep({ ...bare, signoffs: [{ role: null }, { role: null }] })).toBe(false);
	});

	test('a step with no slot at all is not short, because a tick could not complete it', () => {
		expect(isShortStep({ ...bare, signoffs: [] })).toBe(false);
		expect(isShortStep({ ...bare, signoffs: null })).toBe(false);
	});
});
