import { z } from 'zod';

/**
 * Length limits for text people send in. Every input string has one, because a stored string is
 * copied into the audit log and the search index, and the server reads each one in a single pass.
 * The longest real text in the demo data is 1,330 characters (a step's instructions).
 */

/** Names, codes, identifiers, locations, search terms and filters. */
export const MAX_SHORT = 255;
/** Cursors, URLs and other opaque tokens. */
export const MAX_TOKEN = 2_000;
/** A note, reason, comment or rationale. These render as markdown and a root-cause write-up can run long. */
export const MAX_TEXT = 16_000;
/** Long prose a person writes as a document: descriptions, step instructions. About 10,000 words. */
export const MAX_MARKDOWN = 64_000;
/** A pasted CSV import. */
export const MAX_CSV = 2_000_000;
/** A number written as text (a quantity, a spec limit): digits, a sign and a decimal point. */
export const MAX_NUMBER_TEXT = 40;
/** An ISO 8601 timestamp, with a fraction and an offset. */
export const MAX_TIMESTAMP = 40;
/** Free-form JSON someone sends in: a part's metadata, captured data, plugin settings. */
export const MAX_JSON_TEXT = 256_000;

/** Free-form objects that carry their own cap. The walker in the tests stops here. */
export const LIMITED_JSON = new WeakSet<object>();

/** An object with free-form values. Text limits cannot see inside it, so its whole size is capped. */
export function zJsonObject() {
	const schema = z
		.record(z.string().max(MAX_SHORT), z.unknown())
		.refine((v) => JSON.stringify(v).length <= MAX_JSON_TEXT, `Must be at most ${MAX_JSON_TEXT} characters as JSON`);
	LIMITED_JSON.add(schema);
	return schema;
}
