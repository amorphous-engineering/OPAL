// Editor chrome and rendered formatting from the app's CSS tokens (layout.css), so light and
// dark follow the document. Formatting mirrors .prose-opal.
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const sourceHighlight = HighlightStyle.define([
	{ tag: t.heading, fontWeight: '700' },
	{ tag: t.strong, fontWeight: '700' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.monospace, backgroundColor: 'var(--muted)' },
	{ tag: [t.link, t.url], color: 'var(--info)' },
	{ tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--muted-foreground)' },
	{ tag: t.quote, color: 'var(--muted-foreground)' }
]);

export const theme = EditorView.theme({
	'&': {
		color: 'var(--foreground)',
		backgroundColor: 'color-mix(in oklab, var(--input) 20%, transparent)',
		border: '1px solid var(--input)',
		borderRadius: 'var(--radius-md, 0.375rem)',
		fontSize: 'var(--text-sm, 0.875rem)'
	},
	'&.cm-focused': {
		outline: 'none',
		borderColor: 'var(--ring)',
		boxShadow: '0 0 0 2px color-mix(in oklab, var(--ring) 30%, transparent)'
	},
	'&.cm-mode-source': { fontSize: 'var(--text-xs, 0.75rem)' },
	'.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-sans)', lineHeight: '1.625' },
	'&.cm-mode-source .cm-scroller': { fontFamily: 'var(--font-mono)' },
	'.cm-content': { padding: '0.5rem', caretColor: 'var(--foreground)' },
	'.cm-line': { padding: '0 0.125rem' },
	'&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: 'var(--foreground)' },
	'.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
		{ backgroundColor: 'color-mix(in oklab, var(--info) 28%, transparent)' },
	'.cm-placeholder': { color: 'var(--muted-foreground)' },
	'.cm-md-h': { fontWeight: '600', paddingTop: '0.25rem' },
	'.cm-md-h1': { fontSize: '1.25em' },
	'.cm-md-h2': { fontSize: '1.125em' },
	'.cm-md-strong': { fontWeight: '700' },
	'.cm-md-em': { fontStyle: 'italic' },
	'.cm-md-strike': { textDecoration: 'line-through' },
	'.cm-md-underline': { textDecoration: 'underline' },
	'.cm-md-code': {
		backgroundColor: 'var(--muted)',
		padding: '0 0.25rem',
		fontFamily: 'var(--font-mono)',
		fontSize: '0.85em'
	},
	'.cm-md-link': { color: 'var(--info)', textDecoration: 'underline' },
	'.cm-md-quote': {
		borderLeft: '2px solid var(--border)',
		paddingLeft: '0.75rem !important',
		color: 'var(--muted-foreground)'
	},
	'.cm-md-fence': {
		backgroundColor: 'var(--muted)',
		fontFamily: 'var(--font-mono)',
		fontSize: '0.85em'
	},
	'.cm-md-bullet': { display: 'inline-block', width: '1em', textAlign: 'center' },
	'.cm-md-image img': { maxHeight: '20rem', maxWidth: '100%', border: '1px solid var(--border)' },
	'.cm-md-image-below': { display: 'block', padding: '0.25rem 0' }
});
