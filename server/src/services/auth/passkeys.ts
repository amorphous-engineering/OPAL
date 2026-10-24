/**
 * Passkeys (WebAuthn) with @simplewebauthn/server. Credentials are discoverable, so sign-in is
 * usernameless. Challenges live in `webauthn_challenge`, single use, five minutes; the browser
 * carries only a signed cookie with the nonce.
 *
 * `public_key` keeps the legacy layout (python-fido2 AttestedCredentialData) so imported
 * credentials verify without conversion: aaguid (16) | id length (2, big endian) | id | COSE key.
 */
import { now } from '@opal/shared';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from '@simplewebauthn/server';
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';
import { and, eq, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/client.ts';
import { user } from '../../db/schema/index.ts';
import { passkeyCredential, webauthnChallenge } from '../../db/schema/auth.ts';

export const PASSKEY_STATE_COOKIE = 'opal_webauthn_state';
export const CHALLENGE_TTL_MS = 300_000;
const RP_NAME = 'OPAL';

export class PasskeyError extends Error {}

type Kind = 'login' | 'register';

export function storeChallenge(
	db: Db,
	kind: Kind,
	rpId: string,
	state: Record<string, unknown>,
	userId: number | null = null
): string {
	// Drop expired rows so the table cannot grow without bound.
	db.delete(webauthnChallenge).where(lt(webauthnChallenge.expiresAt, now())).run();
	const nonce = randomBytes(32).toString('base64url');
	const ts = now();
	db.insert(webauthnChallenge)
		.values({
			nonce,
			kind,
			rpId,
			userId,
			stateJson: JSON.stringify(state),
			expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
			createdAt: ts,
			updatedAt: ts
		})
		.run();
	return nonce;
}

export interface Challenge {
	rpId: string;
	state: Record<string, any>;
	userId: number | null;
}

/** Fetch and DELETE a pending handshake. Null when unknown, of another kind, or expired. */
export function consumeChallenge(db: Db, nonce: string | undefined | null, kind: Kind): Challenge | null {
	if (!nonce) return null;
	const row = db.select().from(webauthnChallenge).where(eq(webauthnChallenge.nonce, nonce)).get();
	if (!row) return null;
	db.delete(webauthnChallenge).where(eq(webauthnChallenge.id, row.id)).run(); // burn regardless
	if (row.kind !== kind || Date.parse(row.expiresAt) <= Date.now()) return null;
	return { rpId: row.rpId, state: JSON.parse(row.stateJson), userId: row.userId };
}

/** The pinned RP ID, else the hostname the browser reported, else localhost. */
export function rpIdFor(pinned: string, hint: string | undefined): string {
	if (pinned) return pinned;
	const host = (hint ?? '').split(':')[0]!.trim().toLowerCase();
	return /^[a-z0-9.-]+$/.test(host) && host ? host : 'localhost';
}

// ------------------------------------------------------------ legacy key layout

const uuidBytes = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');

export function encodeCredentialData(aaguid: string, credentialId: Buffer, cose: Uint8Array): Buffer {
	const len = Buffer.alloc(2);
	len.writeUInt16BE(credentialId.length);
	const id = aaguid.length === 36 ? uuidBytes(aaguid) : Buffer.alloc(16);
	return Buffer.concat([id, len, credentialId, cose]);
}

export function coseKeyOf(data: Buffer): Uint8Array<ArrayBuffer> {
	const cose = data.subarray(18 + data.readUInt16BE(16));
	const out = new Uint8Array(new ArrayBuffer(cose.length));
	out.set(cose);
	return out;
}

// ------------------------------------------------------------ origin

/** The origin the browser reports in clientDataJSON, accepted only on the RP's own host. */
function checkedOrigin(response: { response: { clientDataJSON: string } }, rpId: string): string {
	let origin = '';
	try {
		origin = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).origin;
		const url = new URL(origin);
		const hostOk = url.hostname === rpId || url.hostname.endsWith(`.${rpId}`);
		const schemeOk = url.protocol === 'https:' || url.hostname === 'localhost';
		if (hostOk && schemeOk) return url.origin;
	} catch {
		/* fall through */
	}
	throw new PasskeyError('The passkey was used on an origin this server does not accept');
}

// ------------------------------------------------------------ registration

export async function beginRegistration(db: Db, u: typeof user.$inferSelect, rpId: string) {
	const existing = db.select().from(passkeyCredential).where(eq(passkeyCredential.userId, u.id)).all();
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: rpId,
		userName: u.username,
		userID: new TextEncoder().encode(String(u.id)),
		userDisplayName: u.name || u.username,
		attestationType: 'none',
		excludeCredentials: existing.map((c) => ({
			id: c.credentialId.toString('base64url'),
			transports: c.transports ? c.transports.split(',') : undefined
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
	});
	return { options, state: { challenge: options.challenge } };
}

export async function completeRegistration(
	challenge: Challenge,
	response: RegistrationResponseJSON
): Promise<{
	credentialId: Buffer;
	publicKey: Buffer;
	signCount: number;
	aaguid: string | null;
	transports: string | null;
}> {
	const origin = checkedOrigin(response, challenge.rpId);
	const verified = await verifyRegistrationResponse({
		response,
		expectedChallenge: challenge.state.challenge,
		expectedOrigin: origin,
		expectedRPID: challenge.rpId,
		requireUserVerification: false
	});
	if (!verified.verified) throw new PasskeyError('Registration response was not verified');
	const { credential, aaguid } = verified.registrationInfo;
	const credentialId = Buffer.from(credential.id, 'base64url');
	const transports = (response.response.transports ?? []).join(',').slice(0, 100) || null;
	return {
		credentialId,
		publicKey: encodeCredentialData(aaguid, credentialId, credential.publicKey),
		signCount: credential.counter,
		aaguid: aaguid || null,
		transports
	};
}

// ------------------------------------------------------------ authentication

export async function beginAuthentication(rpId: string) {
	const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'preferred' });
	return { options, state: { challenge: options.challenge } };
}

/** Verify an assertion. Returns the credential row and the new counter, or null on any failure. */
export async function completeAuthentication(
	db: Db,
	challenge: Challenge,
	response: AuthenticationResponseJSON
): Promise<{ row: typeof passkeyCredential.$inferSelect; counter: number } | null> {
	const rawId = response.rawId || response.id;
	if (!rawId) return null;
	let credentialId: Buffer;
	try {
		credentialId = Buffer.from(rawId, 'base64url');
	} catch {
		return null;
	}
	const row = db.select().from(passkeyCredential).where(eq(passkeyCredential.credentialId, credentialId)).get();
	if (!row) return null;
	try {
		const verified = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge.state.challenge,
			expectedOrigin: checkedOrigin(response, challenge.rpId),
			expectedRPID: challenge.rpId,
			requireUserVerification: false,
			credential: {
				id: credentialId.toString('base64url'),
				publicKey: coseKeyOf(row.publicKey),
				counter: row.signCount,
				transports: row.transports ? (row.transports.split(',') as never[]) : undefined
			}
		});
		if (!verified.verified) return null;
		return { row, counter: verified.authenticationInfo.newCounter };
	} catch (e) {
		console.warn(`Passkey assertion failed: ${(e as Error).message}`);
		return null;
	}
}

/** Bookkeeping after a good sign-in: not business data, so no audit row. */
export function touchCredential(db: Db, id: number, counter: number, previous: number): void {
	db.update(passkeyCredential)
		.set({ lastUsedAt: now(), ...(counter && counter > previous ? { signCount: counter } : {}) })
		.where(eq(passkeyCredential.id, id))
		.run();
}

export const activeUser = (db: Db, id: number) =>
	db.select().from(user).where(and(eq(user.id, id), eq(user.isActive, true))).get();
