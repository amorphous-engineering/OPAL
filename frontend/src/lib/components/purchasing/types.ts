/** Small shared bits of the purchasing screens. Wire types come from `@opal/shared`. */
export { PURCHASE_CHARGE_KINDS, PURCHASE_STATUSES } from '@opal/shared';
export type {
	Attachment,
	PartPoLine,
	Purchase,
	PurchaseExpense,
	PurchaseLine,
	PurchaseListItem,
	PurchaseStatus,
	Supplier,
	SupplierPartRow
} from '@opal/shared';

/** Zero-safe numeric view of a server decimal. */
export const num = (v: string | number | null | undefined): number => Number(v ?? 0);

export const LIST_PAGE_SIZE = 50;

/** Lists page by offset: the cursor of page N is the number of rows before it. */
export const pageCursor = (page: number): string | undefined =>
	page > 1 ? String((page - 1) * LIST_PAGE_SIZE) : undefined;

export const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined =>
	all.find((x) => x === v);
