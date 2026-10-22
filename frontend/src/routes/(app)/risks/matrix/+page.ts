import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export interface MatrixData {
	matrix: number[][];
	residual_matrix: number[][];
	labels: { probability: string[]; impact: string[] };
	total_risks: number;
}

export const load: PageLoad = async ({ fetch }) => {
	try {
		return { matrix: await api.using(fetch).get<MatrixData>('/risks/matrix'), error: null };
	} catch (e) {
		return { matrix: null, error: e instanceof Error ? e.message : 'Failed to load the matrix' };
	}
};
