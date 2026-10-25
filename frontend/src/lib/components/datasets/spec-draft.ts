import { SPEC_KINDS, zDecimal, zSpec, type Spec, type SpecKind } from '@opal/shared';

/** The text boxes of a spec editor; the meaning of a, b, c depends on the kind. */
export interface SpecDraft {
	kind: SpecKind | 'none';
	a: string;
	b: string;
	c: string;
}

export const blankSpec = (): SpecDraft => ({ kind: 'none', a: '', b: '', c: '' });

export const SPEC_KIND_LABELS: Record<SpecKind | 'none', string> = {
	none: 'None',
	range: 'Range',
	nominal: 'Nominal ±',
	min: 'Minimum',
	max: 'Maximum',
	reference: 'Reference'
};
export const SPEC_KIND_OPTIONS = ['none', ...SPEC_KINDS] as const;

/** Box labels per kind, in a, b, c order. */
export const SPEC_BOXES: Record<SpecKind, string[]> = {
	range: ['Lower', 'Upper'],
	nominal: ['Nominal', 'Plus', 'Minus'],
	min: ['Lower'],
	max: ['Upper'],
	reference: ['Nominal']
};

export function draftFromSpec(s: Spec | undefined): SpecDraft {
	if (!s) return blankSpec();
	switch (s.kind) {
		case 'range':
			return { kind: 'range', a: s.lower, b: s.upper, c: '' };
		case 'nominal':
			return { kind: 'nominal', a: s.nominal, b: s.plus, c: s.minus };
		case 'min':
			return { kind: 'min', a: s.lower, b: '', c: '' };
		case 'max':
			return { kind: 'max', a: s.upper, b: '', c: '' };
		case 'reference':
			return { kind: 'reference', a: s.nominal, b: '', c: '' };
	}
}

/** Boxes that are filled but not decimals. */
export function badBoxes(d: SpecDraft): boolean[] {
	if (d.kind === 'none') return [];
	return [d.a, d.b, d.c]
		.slice(0, SPEC_BOXES[d.kind].length)
		.map((v, i) =>
			d.kind === 'nominal' && i === 2 && !v.trim() ? false : !zDecimal.safeParse(v).success
		);
}

/** The spec for a draft, or an error message. A blank minus equals the plus tolerance. */
export function specFromDraft(d: SpecDraft): { spec?: Spec; error?: string } {
	const t = (v: string) => v.trim();
	let raw: unknown;
	switch (d.kind) {
		case 'none':
			return {};
		case 'range':
			raw = { kind: 'range', lower: t(d.a), upper: t(d.b) };
			break;
		case 'nominal':
			raw = { kind: 'nominal', nominal: t(d.a), plus: t(d.b), minus: t(d.c) || t(d.b) };
			break;
		case 'min':
			raw = { kind: 'min', lower: t(d.a) };
			break;
		case 'max':
			raw = { kind: 'max', upper: t(d.a) };
			break;
		case 'reference':
			raw = { kind: 'reference', nominal: t(d.a) };
			break;
	}
	const r = zSpec.safeParse(raw);
	return r.success ? { spec: r.data } : { error: r.error.issues[0]?.message ?? 'Invalid spec' };
}
