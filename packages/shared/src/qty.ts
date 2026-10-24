/**
 * Quantities. Stored as integers scaled by QTY_SCALE so arithmetic is exact.
 * On the wire a quantity is a decimal string ("1.5"), never a float.
 */
import { z } from 'zod';

export const QTY_DECIMALS = 4;
export const QTY_SCALE = 10 ** QTY_DECIMALS;

/** A quantity in storage units (value × QTY_SCALE). */
export type Qty = number & { readonly __qty: unique symbol };

const DECIMAL = /^-?\d+(\.\d{1,4})?$/;

/** Wire format: a decimal string with at most four places. */
export const zQty = z.string().regex(DECIMAL, 'Quantity must be a decimal with at most 4 places');

export function parseQty(s: string): Qty {
	if (!DECIMAL.test(s)) throw new RangeError(`Invalid quantity: ${s}`);
	const neg = s.startsWith('-');
	const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
	const n = Number(whole) * QTY_SCALE + Number(frac.padEnd(QTY_DECIMALS, '0'));
	if (!Number.isSafeInteger(n)) throw new RangeError(`Quantity out of range: ${s}`);
	return (neg ? -n : n) as Qty;
}

export function formatQty(q: Qty): string {
	const neg = q < 0;
	const abs = Math.abs(q);
	const whole = Math.trunc(abs / QTY_SCALE);
	const frac = String(abs % QTY_SCALE)
		.padStart(QTY_DECIMALS, '0')
		.replace(/0+$/, '');
	return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
