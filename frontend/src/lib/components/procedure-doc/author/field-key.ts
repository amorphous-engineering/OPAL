/**
 * The key a data-capture field records its value under. Assigned once when the
 * field is added and never edited, so renaming the label never orphans data
 * already recorded against the key.
 */
export function newFieldKey(taken: readonly string[]): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	for (;;) {
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		const key = 'f_' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
		if (!taken.includes(key)) return key;
	}
}
