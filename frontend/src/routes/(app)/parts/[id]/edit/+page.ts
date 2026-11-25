import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The part page edits in place now; an old link lands there in edit mode.
export const load: PageLoad = ({ params }) => {
	redirect(308, `/parts/${params.id}?edit=1`);
};
