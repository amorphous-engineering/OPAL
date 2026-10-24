/** The one error shape. The client shows `message`; `fields` maps input paths to problems. */
export interface ApiErrorBody {
	error: string;
	message: string;
	fields?: Record<string, string>;
}

export class OpalError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly fields?: Record<string, string>
	) {
		super(message);
	}

	body(): ApiErrorBody {
		return this.fields
			? { error: this.code, message: this.message, fields: this.fields }
			: { error: this.code, message: this.message };
	}
}

export const notFound = (what: string) => new OpalError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new OpalError(409, code, message);
export const forbidden = (message = 'Not permitted') => new OpalError(403, 'forbidden', message);
export const unauthenticated = () => new OpalError(401, 'unauthenticated', 'Sign in required');
