import { opal } from '#lib/api.js';
import { contracts } from '@opal/shared';
import type { ProcedureOption } from './types.js';

type ProcedureList = (input: { limit: number }) => Promise<{ items: { id: number; name: string; projectId?: number }[] }>;

/**
 * Procedures a dataset can link to. Until the procedures area defines `procedures.list`, there
 * are none to offer, and no request is made.
 */
export async function procedureOptions(fetch: typeof globalThis.fetch): Promise<ProcedureOption[]> {
	if (!('list' in contracts.procedures)) return [];
	try {
		const list = (opal.using(fetch).procedures as unknown as { list: ProcedureList }).list;
		return (await list({ limit: 100 })).items.map((p) => ({ id: p.id, name: p.name, projectId: p.projectId })) // added by projects;
	} catch {
		return [];
	}
}
