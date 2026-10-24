/** A software WebAuthn authenticator (ES256, "none" attestation) for the passkey tests. */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

function cborText(s: string): Buffer {
	const body = Buffer.from(s);
	if (body.length > 23) throw new Error('test CBOR: text too long');
	return Buffer.concat([Buffer.from([0x60 + body.length]), body]);
}
function cborBytes(b: Buffer): Buffer {
	if (b.length < 24) return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
	if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
	return Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 255]), b]);
}

export class SoftAuthenticator {
	readonly credentialId = randomBytes(16);
	counter = 0;
	private privateKey: KeyObject;
	private cose: Buffer;

	constructor() {
		const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		this.privateKey = privateKey;
		const jwk = publicKey.export({ format: 'jwk' });
		const x = Buffer.from(jwk.x!, 'base64url');
		const y = Buffer.from(jwk.y!, 'base64url');
		// {1: 2, 3: -7, -1: 1, -2: x, -3: y}
		this.cose = Buffer.concat([
			Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
			x,
			Buffer.from([0x22, 0x58, 0x20]),
			y
		]);
	}

	get id(): string {
		return b64(this.credentialId);
	}
	get coseKey(): Buffer {
		return this.cose;
	}

	private clientData(type: string, challenge: string, origin: string): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	create(options: { challenge: string }, rpId: string, origin = `https://${rpId}`) {
		const idLen = Buffer.alloc(2);
		idLen.writeUInt16BE(this.credentialId.length);
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(this.counter);
		const authData = Buffer.concat([
			sha256(rpId),
			Buffer.from([0x45]),
			counter,
			Buffer.alloc(16),
			idLen,
			this.credentialId,
			this.cose
		]);
		const attestation = Buffer.concat([
			Buffer.from([0xa3]),
			cborText('fmt'),
			cborText('none'),
			cborText('attStmt'),
			Buffer.from([0xa0]),
			cborText('authData'),
			cborBytes(authData)
		]);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64(this.clientData('webauthn.create', options.challenge, origin)),
				attestationObject: b64(attestation),
				transports: ['internal', 'hybrid']
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}

	get(options: { challenge: string }, rpId: string, over: { origin?: string; counter?: number } = {}) {
		this.counter = over.counter ?? this.counter + 1;
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(this.counter);
		const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), counter]);
		const clientData = this.clientData('webauthn.get', options.challenge, over.origin ?? `https://${rpId}`);
		const signature = createSign('SHA256')
			.update(Buffer.concat([authData, sha256(clientData)]))
			.sign({ key: this.privateKey, dsaEncoding: 'der' });
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64(clientData),
				authenticatorData: b64(authData),
				signature: b64(signature),
				userHandle: null
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}
}
