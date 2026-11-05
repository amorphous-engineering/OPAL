import { makePart, setProject, setup } from '../inventory/helpers.ts';

export { makePart, setProject, setup };
export type { Setup } from '../inventory/helpers.ts';
type S = Awaited<ReturnType<typeof setup>>;

export async function mkSupplier(s: S, name = 'Acme', extra: Record<string, unknown> = {}) {
	const r = await s.call('POST', '/suppliers', { name, ...extra });
	if (r.status !== 201) throw new Error(JSON.stringify(r.body));
	return r.body;
}

export async function mkPo(s: S, body: Record<string, unknown> = {}) {
	const r = await s.call('POST', '/purchases', { supplierName: 'Acme', ...body });
	if (r.status !== 201) throw new Error(JSON.stringify(r.body));
	return r.body;
}

/** The hand acts, by the status they lead to: place, resume, hold, cancel. */
export async function setStatus(s: S, id: number, status: 'ordered' | 'on_hold' | 'cancelled') {
	if (status === 'on_hold') return s.call('POST', `/purchases/${id}/hold`, {});
	if (status === 'cancelled') return s.call('POST', `/purchases/${id}/cancel`, { reason: 'test' });
	const now = (await s.call('GET', `/purchases/${id}`)).body.status;
	return s.call('POST', `/purchases/${id}/${now === 'on_hold' ? 'resume' : 'place'}`, {});
}

export const recv = (s: S, id: number, lines: Record<string, unknown>[]) =>
	s.call('POST', `/purchases/${id}/receive`, { lines });

/** An ordered PO with one line. */
export async function orderedPo(s: S, partId: number, qty = '3', extra: Record<string, unknown> = {}) {
	const po = await mkPo(s, { lines: [{ partId, qtyOrdered: qty, unitCost: '1.5' }], ...extra });
	await setStatus(s, po.id, 'ordered');
	return po;
}
