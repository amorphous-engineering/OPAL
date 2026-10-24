/** Money is a Qty-scaled integer (4 decimals). These helpers keep the arithmetic exact. */
import { type Qty, formatQty, parseQty } from '@opal/shared';
import { invalid } from '../inventory/ledger.ts';

/** Wire string -> stored integer. Refuses a negative amount. */
export function parseMoney(field: string, s: string): number {
	const v = parseQty(s);
	if (v < 0) throw invalid(field, 'Amount cannot be negative');
	return v;
}

export function showMoney(v: number | null): string | null {
	return v === null ? null : formatQty(v as Qty);
}

/** cost x quantity, both scaled by 10,000, rounded to the scale. */
export function lineTotal(cost: number, qty: number): number {
	return Number((BigInt(cost) * BigInt(qty) + 5000n) / 10000n);
}
