/**
 * Guards for the Records rules in CLAUDE.md. Adding a destructive or committing operation forces a
 * decision here: either it is human only, or it is listed below as pencil or directory work.
 */
import { describe, expect, test } from 'bun:test';
import { contracts } from '@opal/shared';
import { impls } from '../src/ops/index.ts';
import { isReversible } from '../src/services/platform/undo.ts';

function flatten(tree: Record<string, any>): any[] {
	return Object.values(tree).flatMap((v) =>
		v && 'path' in v && 'method' in v ? [v] : v && typeof v === 'object' ? flatten(v) : []
	);
}

/** Signing, committing and striking. Rule 14: agents prepare, people commit. */
const HUMAN_ACTS = [
	'execution.closeShort',
	'execution.complete',
	'execution.sign',
	'execution.signoff',
	'execution.skip',
	'execution.void',
	'inventory.correct',
	'issues.reopen',
	'issues.signDisposition',
	'issues.signOff',
	'issues.void',
	'parts.obsolete',
	'parts.reinstate',
	'procedures.obsolete',
	'procedures.reinstate',
	'procedures.versions.publish',
	'projects.archive',
	'purchasing.orders.amendLine',
	'purchasing.orders.cancel',
	'purchasing.orders.cancelLine',
	'purchasing.orders.closeShort',
	'purchasing.orders.hold',
	'purchasing.orders.place',
	'purchasing.orders.resume',
	'requirements.baseline',
	'requirements.baselineBatch',
	'requirements.cancel',
	'requirements.reaffirm',
	'requirements.verifyLink',
	'risks.accept',
	'risks.correct',
	'risks.reviewStamp',
	'risks.withdrawAcceptance'
];

/** Destructive-sounding, but pencil or directory work: the service refuses it on a committed record. */
const NOT_A_STRIKE = new Set([
	'attachments.delete', // refused on evidence of signed steps and closed executions
	'auth.passkeys.delete',
	'datasets.archive',
	'datasets.delete', // refused once a dataset has points
	'execution.deleteRedline', // refused once a redline's work has started
	'inventory.templates.delete',
	'inventory.tests.delete', // KNOWN GAP: should be struck with a reason, see RECORDS.md
	'issues.removeLink',
	'parts.bom.remove', // KNOWN GAP: the owner has not decided on active BOM change control
	'parts.delete', // drafts only
	'plugins.links.remove',
	'procedures.delete', // refused once a version exists
	'procedures.kit.remove',
	'procedures.outputs.remove',
	'procedures.steps.images.remove',
	'procedures.steps.kit.remove',
	'procedures.steps.remove',
	'procedures.versions.restore', // copies a version into the draft
	'purchasing.catalog.remove',
	'purchasing.orders.discard', // drafts only
	'purchasing.orders.removeCharge',
	'purchasing.orders.removeLine', // drafts only
	'purchasing.suppliers.delete', // refused once an order refers to the supplier
	'reports.lifecycle.deleteDemo',
	'requirements.assign',
	'requirements.delete', // unreferenced drafts only
	'requirements.unassign',
	'risks.delete', // refused once accepted or realized
	'risks.removeReference',
	'roles.delete',
	'users.deactivate',
	'users.removeAvatar',
	'workcenters.deactivate'
]);

const STRIKE_WORDS =
	/(void|cancel|close|obsolete|archive|withdraw|strike|scrap|reinstate|reopen|correct|sign|baseline|reaffirm|accept|publish|place|amend|hold|resume|discard|deactivate|delete|remove|restore|realize|skip)/i;

describe('records stay on paper', () => {
	const all = flatten(contracts);
	const byName = new Map(all.map((c) => [c.name, c]));

	test('every act of signing, committing or striking is human only', () => {
		for (const name of HUMAN_ACTS) {
			expect(byName.has(name), `${name} exists`).toBe(true);
			expect(byName.get(name).humanOnly, `${name} is human only`).toBe(true);
		}
	});

	test('a new destructive operation has to be classified', () => {
		const unclassified = all
			.filter((c) => c.method !== 'GET' && STRIKE_WORDS.test(c.name))
			.filter((c) => !c.humanOnly && !NOT_A_STRIKE.has(c.name))
			.map((c) => c.name);
		expect(unclassified).toEqual([]);
	});

	test('no operation of a committed record can be undone', () => {
		// Modules register at load; importing the handlers above loads them.
		expect(impls.length).toBeGreaterThan(0);
		for (const name of HUMAN_ACTS) expect(isReversible(name), `${name} is not reversible`).toBe(false);
		for (const name of ['execution.create', 'execution.update', 'execution.createRedline', 'purchasing.orders.create'])
			expect(isReversible(name), `${name} is not reversible`).toBe(false);
	});
});
