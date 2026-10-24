import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

describe('projects', () => {
	test('a project is created with an upper case code and listed by code', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const made = await call(bob, 'POST', '/projects', { code: 'zeta', name: 'Zeta' });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ code: 'ZETA', name: 'Zeta', state: 'active', archivedAt: null });
		await call(bob, 'POST', '/projects', { code: 'alpha', name: 'Alpha', description: 'First' });
		const list = await call(bob, 'GET', '/projects');
		expect(list.json.items.map((p: any) => p.code)).toEqual(['ALPHA', 'ZETA']);
	});

	test('a blank name, a code with spaces and a duplicate code ignoring case are refused', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'POST', '/projects', { code: 'A', name: ' ' })).status).toBe(422);
		expect((await call(bob, 'POST', '/projects', { code: 'A B', name: 'x' })).status).toBe(422);
		await call(bob, 'POST', '/projects', { code: 'ab', name: 'x' });
		expect((await call(bob, 'POST', '/projects', { code: 'AB', name: 'y' })).status).toBe(400);
		const other = (await call(bob, 'POST', '/projects', { code: 'cd', name: 'y' })).json;
		expect((await call(bob, 'PATCH', `/projects/${other.id}`, { code: 'Ab' })).status).toBe(400);
		expect((await call(bob, 'PATCH', `/projects/${other.id}`, { name: 'z', description: 'd' })).json).toMatchObject({ name: 'z', description: 'd' });
	});

	test('archiving is terminal: no edit, no second archive, and the project stays readable', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const p = (await call(bob, 'POST', '/projects', { code: 'P', name: 'P' })).json;
		const a = await call(bob, 'POST', `/projects/${p.id}/archive`);
		expect(a.json.state).toBe('archived');
		expect(a.json.archivedAt).toBeTruthy();
		expect((await call(bob, 'POST', `/projects/${p.id}/archive`)).status).toBe(409);
		expect((await call(bob, 'PATCH', `/projects/${p.id}`, { name: 'Q' })).status).toBe(409);
		expect((await call(bob, 'GET', `/projects/${p.id}`)).json.state).toBe('archived');
	});

	test('the list filters by state and searches name and code', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const a = (await call(bob, 'POST', '/projects', { code: 'A', name: 'Lander' })).json;
		await call(bob, 'POST', '/projects', { code: 'B', name: 'Rover' });
		await call(bob, 'POST', `/projects/${a.id}/archive`);
		expect((await call(bob, 'GET', '/projects?state=active')).json.items.map((p: any) => p.code)).toEqual(['B']);
		expect((await call(bob, 'GET', '/projects?state=archived')).json.items.map((p: any) => p.code)).toEqual(['A']);
		expect((await call(bob, 'GET', '/projects?search=rov')).json.items).toHaveLength(1);
		expect((await call(bob, 'GET', '/projects/999')).status).toBe(404);
	});

	test('the list pages by cursor', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		for (const c of ['A', 'B', 'C']) await call(bob, 'POST', '/projects', { code: c, name: c });
		const p1 = (await call(bob, 'GET', '/projects?limit=2')).json;
		expect(p1.items).toHaveLength(2);
		const p2 = (await call(bob, 'GET', `/projects?limit=2&cursor=${p1.next}`)).json;
		expect(p2.items.map((p: any) => p.code)).toEqual(['C']);
		expect(p2.next).toBeNull();
	});
});
