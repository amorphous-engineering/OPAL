// Which part numbers written in a text name a part. The server reads the numbers (the UI never
// parses one) and answers for a batch of texts. `numbersIn` answers from what is known now and
// asks for the rest; a page that renders through it re-renders when the answer lands.
import { MAX_NUMBERS_IN_TEXTS } from '@opal/shared';
import { opal } from '#lib/api.js';

const found = new Map<string, readonly string[]>();
const waiting = new Set<string>();
const asking = new Set<string>();
let answered = $state(0);
let timer: ReturnType<typeof setTimeout> | null = null;

// A text with no digit holds no number: no request.
const NO_DIGIT = /^\D*$/;
// Texts kept per tab. Edits make new texts; the oldest go first.
const KEEP = 2000;

/** The part numbers in `text` that name a part, as written. Empty until the server answers. */
export function numbersIn(text: string): readonly string[] {
	// Read so that a template calling this re-runs when an answer lands.
	void answered;
	if (NO_DIGIT.test(text)) return [];
	const hit = found.get(text);
	if (hit) return hit;
	// State is written only in the response, never while a template renders.
	if (!waiting.has(text) && !asking.has(text)) {
		waiting.add(text);
		timer ??= setTimeout(flush, 30);
	}
	return [];
}

async function flush(): Promise<void> {
	timer = null;
	const batch = [...waiting].slice(0, MAX_NUMBERS_IN_TEXTS);
	for (const t of batch) {
		waiting.delete(t);
		asking.add(t);
	}
	if (waiting.size) timer = setTimeout(flush, 0);
	let answers: string[][];
	try {
		answers = (await opal.parts.numbersIn({ texts: batch })).found;
	} catch {
		// Not signed in, or offline: the text stays plain. No retry loop.
		answers = batch.map(() => []);
	}
	batch.forEach((t, i) => {
		asking.delete(t);
		found.set(t, answers[i] ?? []);
	});
	for (const old of found.keys()) {
		if (found.size <= KEEP) break;
		found.delete(old);
	}
	answered++;
}
