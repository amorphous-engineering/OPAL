/**
 * Markdown → sanitized HTML for authored content (step instructions, issue
 * descriptions, notes). Always sanitize: content is user-authored.
 *   <div class="prose-opal">{@html markdown(text)}</div>
 *
 * Text here is written by one person and read by another, so it may format but not impersonate the
 * app: no forms, no styles or app classes that could cover the page, nothing fetched from another host.
 * Changes to the sanitized result go in the hooks. Editing the HTML string afterwards can undo the
 * sanitizer (a replacement can break out of an attribute value).
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const FORBID_TAGS = [
	// Inputs and controls. A GFM task list's checkbox is the exception; see tidy().
	'form',
	'button',
	'select',
	'option',
	'optgroup',
	'textarea',
	'datalist',
	'fieldset',
	'legend',
	'label',
	// A global style sheet, and elements that load from a URL on their own.
	'style',
	'audio',
	'video',
	'source',
	'track',
	'picture',
	'map',
	'area'
];
const FORBID_ATTR = [
	'style',
	'id',
	'name',
	'for',
	'tabindex',
	'accesskey',
	'action',
	'formaction',
	'method',
	'enctype',
	'autocomplete',
	'srcset',
	'sizes',
	'usemap',
	'ismap',
	'background',
	'poster',
	'ping',
	'target'
];

/** An image from another host becomes a link to it: opening the page must not call that host. */
function tidyImage(img: Element): void {
	const src = img.getAttribute('src');
	if (!src || src.startsWith('data:image/')) return void img.setAttribute('loading', 'lazy');
	let url: URL;
	try {
		url = new URL(src, window.location.href);
	} catch {
		return void img.remove();
	}
	if (url.origin === window.location.origin) return void img.setAttribute('loading', 'lazy');
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return void img.remove();
	const link = img.ownerDocument.createElement('a');
	link.setAttribute('href', url.href);
	link.textContent = img.getAttribute('alt') || url.href;
	img.replaceWith(link);
}

function tidy(node: Element): void {
	if (!node.tagName) return;
	if (node.tagName === 'IMG') return tidyImage(node);
	// App classes can position an element over the page. Only a code block's language stays.
	const cls = node.getAttribute('class');
	if (cls && !(node.tagName === 'CODE' && /^language-[\w-]+$/.test(cls)))
		node.removeAttribute('class');
	if (node.tagName === 'A' && node.getAttribute('href'))
		node.setAttribute('rel', 'noopener noreferrer');
	if (node.tagName === 'INPUT') {
		if (node.getAttribute('type') === 'checkbox') node.setAttribute('disabled', '');
		else node.remove();
	}
}

let hooked = false;

export function markdown(source: string | null | undefined): string {
	if (!source) return '';
	if (!hooked) {
		DOMPurify.addHook('afterSanitizeAttributes', tidy);
		hooked = true;
	}
	const html = marked.parse(source, { async: false }) as string;
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS,
		FORBID_ATTR,
		ALLOW_DATA_ATTR: false
	});
}
