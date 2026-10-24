// The view mode is a per-viewer preference shared by every markdown editor on the page.
export type MarkdownMode = 'live' | 'hybrid' | 'source';
export const MARKDOWN_MODES: MarkdownMode[] = ['live', 'hybrid', 'source'];

const KEY = 'opal.markdown.mode';

function load(): MarkdownMode {
	try {
		const v = localStorage.getItem(KEY);
		if (v === 'live' || v === 'hybrid' || v === 'source') return v;
	} catch {
		/* storage unavailable */
	}
	return 'hybrid';
}

export const markdownMode = $state<{ value: MarkdownMode }>({ value: load() });

export function setMarkdownMode(mode: MarkdownMode): void {
	markdownMode.value = mode;
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		/* storage unavailable */
	}
}
