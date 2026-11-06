import { expect, test } from 'bun:test';
import { issueHooks } from '../../src/services/issues/hooks.ts';
import { setup as issueSetup } from '../issues/helpers.ts';
import { setup } from './helpers.ts';

test('execution tests get the issue seams back, whatever test file ran before them', async () => {
	await issueSetup();
	expect(issueHooks.describe).toBeNull();
	await setup();
	expect(issueHooks.describe).not.toBeNull();
	expect(issueHooks.holdChanged.length).toBeGreaterThan(0);
});
