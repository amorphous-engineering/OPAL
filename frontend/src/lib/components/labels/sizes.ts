/** Physical label stock. Dimensions in inches, as printed (landscape). */
export interface LabelSize {
	key: string;
	name: string;
	width: number;
	height: number;
}

export const LABEL_SIZES: LabelSize[] = [
	{ key: 'std-4x2', name: '4 × 2 in (thermal)', width: 4, height: 2 },
	{ key: 'dymo-30256', name: 'DYMO 30256 shipping, 4 × 2.31 in', width: 4, height: 2.3125 },
	{ key: 'dymo-99012', name: 'DYMO 99012 large address, 3.5 × 1.4 in', width: 3.5, height: 1.4 },
	{
		key: 'dymo-30334',
		name: 'DYMO 30334 multi-purpose, 2.25 × 1.25 in',
		width: 2.25,
		height: 1.25
	},
	{
		key: 'dymo-30336',
		name: 'DYMO 30336 small multi-purpose, 2.125 × 1 in',
		width: 2.125,
		height: 1
	}
];

export const DEFAULT_SIZE = 'std-4x2';

export function sizeFor(key: string | null | undefined): LabelSize {
	return LABEL_SIZES.find((s) => s.key === key) ?? LABEL_SIZES[0];
}
