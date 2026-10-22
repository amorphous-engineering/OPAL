import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Supplier fields edit in place on the detail page; keep old /edit links working.
export const load: PageLoad = ({ params }) => {
	redirect(308, `/suppliers/${params.id}`);
};
