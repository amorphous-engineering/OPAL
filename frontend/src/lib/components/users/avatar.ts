/** Centre-crop an image file to a square and resize it to `size` px; returns WebP or PNG. */
export async function squareAvatar(file: File, size = 256): Promise<Blob> {
	const bitmap = await createImageBitmap(file);
	try {
		const side = Math.min(bitmap.width, bitmap.height);
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Cannot process images in this browser');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(
			bitmap,
			(bitmap.width - side) / 2,
			(bitmap.height - side) / 2,
			side,
			side,
			0,
			0,
			size,
			size
		);
		const webp = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/webp', 0.9)
		);
		if (webp && webp.type === 'image/webp') return webp;
		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!png) throw new Error('Cannot encode the image');
		return png;
	} finally {
		bitmap.close();
	}
}

/** The bytes of a blob as base64 text, for the JSON upload. */
export async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
