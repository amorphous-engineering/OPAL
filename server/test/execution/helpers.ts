import { now } from '@opal/shared';
import type { Actor } from '../../src/context.ts';
import { issueHooks } from '../../src/services/issues/hooks.ts';
import { user } from '../../src/db/schema/index.ts';
import { setup as procedureSetup } from '../procedures/helpers.ts';

/** The procedures harness plus shorthands for cutting and working executions. */
export async function setup() {
	const base = await procedureSetup();
	const { db, call, ok, author } = base;
	const ts = now();
	const mkUser = (username: string, isAdmin = false) =>
		db.insert(user).values({ username, name: username.toUpperCase(), isAdmin, createdAt: ts, updatedAt: ts }).returning().get();
	const ben = mkUser('ben');
	const cat = mkUser('cat');
	const asUser = (u: { id: number; isAdmin: boolean }): Actor => ({ kind: 'user', userId: u.id, isAdmin: u.isAdmin, sessionId: 1 });
	const benActor = asUser(ben);
	const catActor = asUser(cat);

	const cut = (procedureId: number, extra: Record<string, unknown> = {}) => ok('POST', '/executions', { procedureId, ...extra });
	const doc = (id: number) => ok('GET', `/executions/${id}/document`);
	const get = (id: number) => ok('GET', `/executions/${id}`);
	/** step execution id by display number */
	const stepOf = async (id: number, number: string): Promise<number> => {
		const e = await get(id);
		const s = e.steps.find((x: any) => x.number === number);
		if (!s) throw new Error(`no step ${number} in ${JSON.stringify(e.steps.map((x: any) => x.number))}`);
		return s.id;
	};
	const complete = async (id: number, number: string, body: Record<string, unknown> = {}, as?: Actor) =>
		call('POST', `/executions/${id}/steps/${await stepOf(id, number)}/complete`, body, as);
	const skip = async (id: number, number: string, body: Record<string, unknown> = {}, as?: Actor) =>
		call('POST', `/executions/${id}/steps/${await stepOf(id, number)}/skip`, body, as);
	const sign = async (id: number, number: string, slot: number, body: Record<string, unknown> = {}, as?: Actor) =>
		call('POST', `/executions/${id}/steps/${await stepOf(id, number)}/signoffs/${slot}`, body, as);
	const nc = async (id: number, number: string, body: Record<string, unknown> = {}, as?: Actor) =>
		call('POST', `/executions/${id}/steps/${await stepOf(id, number)}/nc`, { title: 'Scratch on bracket', ...body }, as);
	const disposition = (issueId: number) =>
		call('POST', `/issues/${issueId}/disposition`, { dispositionType: 'use_as_is', dispositionRationale: 'acceptable as built' });
	const stock = async (partId: number, quantity: string, location = 'A1', extra: Record<string, unknown> = {}) =>
		(await ok('POST', '/inventory', { partId, quantity, location, enforceTierRules: false, ...extra })).items[0];
	/** An active bulk part (the default parts are serialized). */
	const bulk = async (name: string) => {
		const p = await ok('POST', '/parts', { name, tier: 3, trackingType: 'bulk' });
		await ok('POST', `/parts/${p.id}/activate`, { cause: 'test' });
		return p;
	};
	/** A published procedure with the given OP titles; returns ids. */
	const published = async (titles = ['A', 'B'], extra: Record<string, unknown> = {}) => {
		const p = await base.proc('Proc ' + Math.random().toString(36).slice(2, 6), extra);
		for (const t of titles) await base.step(p.id, t);
		await ok('POST', `/procedures/${p.id}/publish`, {});
		return p.id as number;
	};
	issueHooks.deliver = issueHooks.deliver; // seams are registered by the execution ops at import time
	return { ...base, ben, cat, benActor, catActor, author, cut, doc, get, stepOf, complete, skip, sign, nc, disposition, stock, published, bulk };
}
