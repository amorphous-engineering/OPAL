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
