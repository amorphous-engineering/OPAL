/* WebAuthn passkey helpers for OPAL.
 *
 * Uses the WebAuthn JSON serialization (PublicKeyCredential.parse*FromJSON /
 * toJSON) when the browser provides it, with a manual base64url fallback for
 * slightly older browsers. Requires a secure context (https or localhost).
 */

(function () {
    'use strict';

    function b64urlToBytes(b64url) {
        var b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
        var pad = b64.length % 4;
        if (pad) b64 += '===='.slice(pad);
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function bytesToB64url(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function parseCreationOptions(json) {
        if (window.PublicKeyCredential.parseCreationOptionsFromJSON) {
            return PublicKeyCredential.parseCreationOptionsFromJSON(json.publicKey);
        }
        var pk = json.publicKey;
        var options = Object.assign({}, pk);
        options.challenge = b64urlToBytes(pk.challenge);
        options.user = Object.assign({}, pk.user, { id: b64urlToBytes(pk.user.id) });
        if (pk.excludeCredentials) {
            options.excludeCredentials = pk.excludeCredentials.map(function (c) {
                return Object.assign({}, c, { id: b64urlToBytes(c.id) });
            });
        }
        return options;
    }

    function parseRequestOptions(json) {
        if (window.PublicKeyCredential.parseRequestOptionsFromJSON) {
            return PublicKeyCredential.parseRequestOptionsFromJSON(json.publicKey);
        }
        var pk = json.publicKey;
        var options = Object.assign({}, pk);
        options.challenge = b64urlToBytes(pk.challenge);
        if (pk.allowCredentials) {
            options.allowCredentials = pk.allowCredentials.map(function (c) {
                return Object.assign({}, c, { id: b64urlToBytes(c.id) });
            });
        }
        return options;
    }

    function credentialToJSON(credential) {
        if (credential.toJSON) return credential.toJSON();
        var response = {};
        if (credential.response.attestationObject !== undefined) {
            response.clientDataJSON = bytesToB64url(credential.response.clientDataJSON);
            response.attestationObject = bytesToB64url(credential.response.attestationObject);
            if (credential.response.getTransports) {
                response.transports = credential.response.getTransports();
            }
        } else {
            response.clientDataJSON = bytesToB64url(credential.response.clientDataJSON);
            response.authenticatorData = bytesToB64url(credential.response.authenticatorData);
            response.signature = bytesToB64url(credential.response.signature);
            if (credential.response.userHandle) {
                response.userHandle = bytesToB64url(credential.response.userHandle);
            }
        }
        return {
            id: credential.id,
            rawId: bytesToB64url(credential.rawId),
            type: credential.type,
            response: response,
            clientExtensionResults: credential.getClientExtensionResults
                ? credential.getClientExtensionResults()
                : {},
            authenticatorAttachment: credential.authenticatorAttachment || null,
        };
    }

    async function postJSON(url, body) {
        var resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? '{}' : JSON.stringify(body),
        });
        if (!resp.ok) {
            var detail = 'Request failed (' + resp.status + ')';
            try { detail = (await resp.json()).detail || detail; } catch (e) { /* keep default */ }
            throw new Error(detail);
        }
        return resp.json();
    }

    /* Sign in with a discoverable passkey. Resolves on success. */
    window.opalPasskeyLogin = async function () {
        var options = await postJSON('/api/auth/passkey/login/begin');
        var credential = await navigator.credentials.get({ publicKey: parseRequestOptions(options) });
        return postJSON('/api/auth/passkey/login/complete', credentialToJSON(credential));
    };

    /* Register a new passkey for the logged-in user. Resolves on success. */
    window.opalPasskeyRegister = async function (name) {
        var options = await postJSON('/api/auth/passkey/register/begin');
        var credential = await navigator.credentials.create({ publicKey: parseCreationOptions(options) });
        return postJSON('/api/auth/passkey/register/complete', {
            name: name || 'Passkey',
            credential: credentialToJSON(credential),
        });
    };
})();
