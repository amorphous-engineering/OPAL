import { describe, expect, test } from 'bun:test';
import { contracts } from '@opal/shared';
import { impls } from '../../src/ops/index.ts';
import { setup } from './helpers.ts';

function flatten(tree: Record<string, any>): any[] {
	return Object.values(tree).flatMap((v) => (v && 'path' in v && 'method' in v ? [v] : flatten(v)));
}

describe('parts operations', () => {
	test('every parts contract has a handler and is an MCP tool, except a person\'s strikes', () => {
		const bound = new Set(impls.map((i) => i.contract.name));
		const humanOnly = new Set(['parts.obsolete', 'parts.reinstate']);
		for (const c of flatten(contracts.parts)) {
			expect(bound.has(c.name)).toBe(true);
			expect(c.mcp).toBe(!humanOnly.has(c.name));
			expect(c.name.startsWith('parts.')).toBe(true);
		}
	});

	test('bulk create makes every part, or none when one fails', async () => {
		const { api } = await setup();
		const ok = await api('POST', '/parts/bulk', { parts: [{ name: 'A' }, { name: 'B' }] });
		expect(ok.status).toBe(200);
		expect(ok.json.parts.map((p: any) => p.internalPn)).toEqual(['PN-1-0001', 'PN-1-0002']);
		const bad = await api('POST', '/parts/bulk', { parts: [{ name: 'C' }, { name: '' }] });
		expect(bad.status).toBe(422);
		expect((await api('GET', '/parts')).json.items).toHaveLength(2);
	});
});
