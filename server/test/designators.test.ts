import { expect, test } from 'bun:test';
import { nextDesignator, nextSerial } from '../src/services/designators.ts';
import { openTestDb } from './helpers/db.ts';

test('designators count up per prefix and are stored at full width', async () => {
	const db = await openTestDb();
	expect(nextDesignator({ db }, 'OPAL')).toBe('OPAL-0000000001');
	expect(nextDesignator({ db }, 'OPAL')).toBe('OPAL-0000000002');
	expect(nextDesignator({ db }, 'REQ')).toBe('REQ-0000000001');
	expect(nextSerial({ db }, 'SPX-F-0000000001')).toBe('001');
	expect(nextSerial({ db }, 'SPX-F-0000000002')).toBe('001');
});
