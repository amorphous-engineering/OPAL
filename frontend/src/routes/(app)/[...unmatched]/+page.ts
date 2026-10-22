import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Unknown URLs inside the signed-in app get the shared error page, shell included.
export const load: PageLoad = () => error(404, 'No such page');
