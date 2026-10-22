export interface Column<R> {
	key: string;
	label: string;
	align?: 'left' | 'right' | 'center';
	mono?: boolean;
	width?: string;
	sortable?: boolean;
	/** Sort key; defaults to row[key]. */
	sortValue?: (row: R) => string | number | null | undefined;
	class?: string;
}
