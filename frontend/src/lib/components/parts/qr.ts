import { opal } from '#lib/api.js';

/** The part's QR code as an image URL (`<img src>`). Null while loading or when it fails. */
export async function partQr(id: number): Promise<string | null> {
	try {
		const { svg } = await opal.parts.qrcode({ id, origin: location.origin });
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	} catch {
		return null;
	}
}
