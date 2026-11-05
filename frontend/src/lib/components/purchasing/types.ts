/** Small shared bits of the purchasing screens. Wire types come from `@opal/shared`. */
export { PURCHASE_CHARGE_KINDS, PURCHASE_STATUSES } from '@opal/shared';
export type {
	Attachment,
	PartPoLine,
	Purchase,
	PurchaseChange,
	PurchaseExpense,
	PurchaseLine,
	PurchaseListItem,
	PurchaseReceivedRecord,
	PurchaseStatus,
	Supplier,
	SupplierPartRow
} from '@opal/shared';

import type { PurchaseChange } from '@opal/shared';
import { qtyUnit, stateLabel, unitMoney } from '#lib/format.js';

const FIELD_LABELS: Record<string, string> = {
	line: 'Line added',
	qtyOrdered: 'Quantity',
	qtyCancelled: 'Cancelled',
	unitCost: 'Unit cost',
	destination: 'Destination',
	supplierReference: 'Supplier ref',
	targetDate: 'Target date',
	notes: 'Notes',
	status: 'Status'
};
export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

/** An old or new value of a change as the page reads it: units on quantities, money as money. */
export function changeValue(
	c: Pick<PurchaseChange, 'field' | 'unitOfMeasure'>,
	v: string | null
): string {
	if (v === null || v === '') return '—';
	if (c.field === 'qtyOrdered' || c.field === 'qtyCancelled' || c.field === 'line') {
		return qtyUnit(v, c.unitOfMeasure);
	}
	if (c.field === 'unitCost') return unitMoney(v);
	if (c.field === 'status') return stateLabel(v);
	return v;
}

/** Zero-safe numeric view of a server decimal. */
export const num = (v: string | number | null | undefined): number => Number(v ?? 0);

export const LIST_PAGE_SIZE = 50;

/** Lists page by offset: the cursor of page N is the number of rows before it. */
export const pageCursor = (page: number): string | undefined =>
	page > 1 ? String((page - 1) * LIST_PAGE_SIZE) : undefined;

export const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined =>
	all.find((x) => x === v);
