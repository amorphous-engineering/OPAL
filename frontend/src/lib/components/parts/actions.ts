import { invalidateAll } from '$app/navigation';
import { toast, toastError } from '#lib/components/opal/index.js';

/**
 * Run a mutation, refresh the page data, report failure with the server's
 * own words. Returns whether it succeeded.
 */
export async function act(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
	try {
		await fn();
		await invalidateAll();
		if (success) toast.success(success);
		return true;
	} catch (e) {
		toastError(e);
		return false;
	}
}
