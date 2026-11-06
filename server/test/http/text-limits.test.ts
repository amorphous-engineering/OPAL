import { describe, expect, test } from 'bun:test';
import { MAX_MARKDOWN, MAX_SHORT } from '@opal/shared';
import { setup } from '../parts/helpers.ts';

describe('text field limits', () => {
	test('a part description over the long-text limit is refused before anything is stored', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { name: 'Bolt', tier: 1, description: 'a'.repeat(MAX_MARKDOWN + 1) });
		expect(res.status).toBe(422);
		expect(res.json.fields).toHaveProperty('description');
		expect((await api('GET', '/parts')).json.items).toHaveLength(0);
	});

	test('a part description at the long-text limit is kept whole', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { name: 'Bolt', tier: 1, description: 'a'.repeat(MAX_MARKDOWN) });
		expect(res.status).toBe(201);
		expect(res.json.description).toHaveLength(MAX_MARKDOWN);
	});

	test('a search term over the short-text limit is refused', async () => {
		const { api } = await setup();
		expect((await api('GET', `/parts?q=${'a'.repeat(MAX_SHORT + 1)}`)).status).toBe(422);
		expect((await api('GET', `/parts?q=${'a'.repeat(MAX_SHORT)}`)).status).toBe(200);
	});
});
