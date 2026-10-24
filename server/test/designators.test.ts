import { expect, test } from 'bun:test';
import { nextDesignator, nextSerial } from '../src/services/designators.ts';
import { openTestDb } from './helpers/db.ts';

test('designators count up per prefix and pad as legacy did', async () => {
	const db = await openTestDb();
	expect(nextDesignator({ db }, 'OPAL')).toBe('OPAL-00001');
	expect(nextDesignator({ db }, 'OPAL')).toBe('OPAL-00002');
	expect(nextDesignator({ db }, 'REQ')).toBe('REQ-0001');
	expect(nextSerial({ db }, 'SPX-F-0001')).toBe('001');
	expect(nextSerial({ db }, 'SPX-F-0002')).toBe('001');
});
