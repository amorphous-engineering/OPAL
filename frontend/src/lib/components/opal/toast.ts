import { toast } from 'svelte-sonner';
import { ApiError } from '#lib/api.js';

export { toast };

/** Report a failed action. The error text is the server's own detail. */
export function toastError(e: unknown, fallback = 'Action failed') {
	const message = e instanceof ApiError || e instanceof Error ? e.message : fallback;
	toast.error(message || fallback);
}
