/**
 * Image viewer: PhotoSwipe v5 over a group of thumbnail links.
 *
 *   <div use:gallery>
 *     <a data-pswp href={attachmentUrl(id)} data-pswp-caption="Label"><img … /></a>
 *   </div>
 *
 * Each thumbnail link opens its group in the viewer. The full-size dimensions come from
 * the loaded thumbnail (`naturalWidth/naturalHeight`), so no backend change is needed.
 */
import type PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import './viewer.css';

/** Download URL for an attachment (images, files). */
export const attachmentUrl = (id: number) => `/api/attachments/${id}/download`;

/** Svelte action: every `a[data-pswp]` inside the node opens the image viewer. */
export function gallery(node: HTMLElement) {
	let lightbox: PhotoSwipeLightbox | null = null;
	let gone = false;

	import('photoswipe/lightbox').then(({ default: Lightbox }) => {
		if (gone) return;
		const lb = new Lightbox({
			gallery: node,
			children: 'a[data-pswp]',
			pswpModule: () => import('photoswipe'),
			bgOpacity: 0.9,
			showHideAnimationType: 'fade'
		});
		lb.addFilter('domItemData', (itemData, el) => {
			const img = el.querySelector('img');
			itemData.src = (el as HTMLAnchorElement).href;
			// An image that has not loaded reports 0x0: fall back to a 4:3 frame.
			itemData.width = img?.naturalWidth || 1600;
			itemData.height = img?.naturalHeight || 1200;
			itemData.msrc = img?.currentSrc || img?.src;
			itemData.alt = img?.alt;
			(itemData as { caption?: string }).caption = (el as HTMLElement).dataset.pswpCaption ?? '';
			return itemData;
		});
		lb.on('uiRegister', () => {
			lb.pswp?.ui?.registerElement({
				name: 'caption',
				order: 9,
				isButton: false,
				appendTo: 'root',
				onInit: (el, pswp) => {
					el.className = 'pswp__caption';
					pswp.on('change', () => {
						const c = (pswp.currSlide?.data as { caption?: string } | undefined)?.caption;
						el.textContent = c ?? '';
						el.hidden = !c;
					});
				}
			});
		});
		lb.init();
		lightbox = lb;
	});

	return {
		destroy() {
			gone = true;
			lightbox?.destroy();
			lightbox = null;
		}
	};
}
