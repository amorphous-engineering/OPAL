import { ApiError } from '#lib/api.js';
import type { HandleClientError } from '@sveltejs/kit';

/**
 * A load that throws an API failure (rather than calling `error()`) still reaches the
 * shared error page with the API's own message and status, not "Internal Error".
 */
export const handleError: HandleClientError = ({ error, message }) => {
	if (error instanceof ApiError) return { message: error.message, status: error.status };
	if (error instanceof TypeError) return { message: 'Cannot reach the server' };
	return { message };
};
