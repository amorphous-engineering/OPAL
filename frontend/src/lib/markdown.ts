/**
 * Markdown → sanitized HTML for authored content (step instructions, issue
 * descriptions, notes). Always sanitize: content is user-authored.
 *   <div class="prose-opal">{@html markdown(text)}</div>
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function markdown(source: string | null | undefined): string {
	if (!source) return '';
	const html = marked.parse(source, { async: false }) as string;
	const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
	// Images in authored content load lazily (a procedure can carry hundreds).
	return clean.replace(/<img /g, '<img loading="lazy" ');
}
