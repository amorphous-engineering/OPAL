import { ApiError } from '#lib/api.js';
import type { HandleClientError } from '@sveltejs/kit/hooks';

/**
 * A load that throws an API failure (rather than calling `error()`) still reaches the
 * shared error page with the API's own message and status, not "Internal Error".
 */
export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind !== 'unknown') return;
	// The error page shows only a message, so keep the stack where a developer can find it.
	console.error(error);
	if (error instanceof ApiError) return { message: error.message, status: error.status };
	if (error instanceof TypeError) return { message: 'Cannot reach the server', status: 503 };
};
