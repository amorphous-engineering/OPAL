/** QR code that links to a part's page. */
import QRCode from 'qrcode';
import type { Ctx } from '../../context.ts';
import { getRow } from './index.ts';

export async function qrCode(ctx: Ctx, id: number, origin?: string) {
	getRow(ctx, id);
	const path = `/parts/${id}`;
	const url = origin ? `${origin.replace(/\/+$/, '')}${path}` : path;
	const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
	return { svg, url };
}
