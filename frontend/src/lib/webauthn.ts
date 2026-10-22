/**
 * WebAuthn JSON ⇄ browser credential objects. Uses the native
 * parse*FromJSON / toJSON when present, with a base64url fallback.
 */
type Json = Record<string, unknown>;

function b64urlToBytes(s: string): ArrayBuffer {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '===='.slice(b64.length % 4 || 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

function bytesToB64url(buf: ArrayBuffer | null): string | null {
	if (!buf) return null;
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PKC = () =>
	window.PublicKeyCredential as unknown as {
		parseRequestOptionsFromJSON?: (j: Json) => PublicKeyCredentialRequestOptions;
		parseCreationOptionsFromJSON?: (j: Json) => PublicKeyCredentialCreationOptions;
	};

export const passkeysSupported = () =>
	typeof window !== 'undefined' && !!window.PublicKeyCredential;

function credentialToJSON(cred: PublicKeyCredential): Json {
	const c = cred as PublicKeyCredential & { toJSON?: () => Json };
	if (typeof c.toJSON === 'function') return c.toJSON() as unknown as Json;
	const r = cred.response as AuthenticatorAssertionResponse & AuthenticatorAttestationResponse;
	const response: Json = { clientDataJSON: bytesToB64url(r.clientDataJSON) };
	if ('authenticatorData' in r) {
		response.authenticatorData = bytesToB64url(r.authenticatorData);
		response.signature = bytesToB64url(r.signature);
		response.userHandle = bytesToB64url(r.userHandle);
	}
	if ('attestationObject' in r) {
		response.attestationObject = bytesToB64url(r.attestationObject);
		response.transports = r.getTransports?.() ?? [];
	}
	return {
		id: cred.id,
		rawId: bytesToB64url(cred.rawId),
		type: cred.type,
		response,
		clientExtensionResults: cred.getClientExtensionResults(),
		authenticatorAttachment:
			(cred as { authenticatorAttachment?: string }).authenticatorAttachment ?? null
	};
}

export async function getAssertion(options: { publicKey: Json }): Promise<Json> {
	const pk = options.publicKey;
	const parsed: PublicKeyCredentialRequestOptions = PKC().parseRequestOptionsFromJSON
		? PKC().parseRequestOptionsFromJSON!(pk)
		: ({
				...pk,
				challenge: b64urlToBytes(pk.challenge as string),
				allowCredentials: ((pk.allowCredentials as Json[]) ?? []).map((c) => ({
					...c,
					id: b64urlToBytes(c.id as string)
				}))
			} as unknown as PublicKeyCredentialRequestOptions);
	const cred = (await navigator.credentials.get({ publicKey: parsed })) as PublicKeyCredential;
	return credentialToJSON(cred);
}

export async function createCredential(options: { publicKey: Json }): Promise<Json> {
	const pk = options.publicKey;
	const parsed: PublicKeyCredentialCreationOptions = PKC().parseCreationOptionsFromJSON
		? PKC().parseCreationOptionsFromJSON!(pk)
		: ({
				...pk,
				challenge: b64urlToBytes(pk.challenge as string),
				user: { ...(pk.user as Json), id: b64urlToBytes((pk.user as Json).id as string) },
				excludeCredentials: ((pk.excludeCredentials as Json[]) ?? []).map((c) => ({
					...c,
					id: b64urlToBytes(c.id as string)
				}))
			} as unknown as PublicKeyCredentialCreationOptions);
	const cred = (await navigator.credentials.create({ publicKey: parsed })) as PublicKeyCredential;
	return credentialToJSON(cred);
}
