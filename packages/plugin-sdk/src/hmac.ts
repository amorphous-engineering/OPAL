import { createHmac, timingSafeEqual } from 'node:crypto';

/** Check a webhook signature. Accepts hex with or without a `sha256=` style prefix. */
export function verifyHmac(
	secret: string,
	body: string | Uint8Array,
	signature: string | null | undefined,
	algo = 'sha256'
): boolean {
	if (!signature) return false;
	let sig = signature.trim().toLowerCase();
	if (sig.startsWith(`${algo}=`)) sig = sig.slice(algo.length + 1);
	if (!/^[0-9a-f]+$/.test(sig) || sig.length % 2) return false;
	const want = createHmac(algo, secret).update(body).digest();
	const got = Buffer.from(sig, 'hex');
	return got.length === want.length && timingSafeEqual(got, want);
}
