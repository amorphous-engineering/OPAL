# OPAL Security Audit — v1.4.0 hardening pass

**Branch audited:** `devel` (worktree at `origin/devel`, tip `90627ed`)
**Date:** 2026-07-19
**Threat model:** semi-trusted LAN. OPAL is local-first, binds `0.0.0.0:8080` by default, typically plain HTTP, one project per instance, shared-write among authenticated users by design. In scope: auth bypass, cross-user/cross-project access, privilege escalation, stored XSS between users, file handling, injection, integrity of audited records, dependency CVEs. Out of scope (by product design): per-object ownership between authenticated users of the same instance.

## Method

Seven parallel read-only audit lanes (API authorization, authentication, file handling, web XSS/CSRF, MCP server, SSRF/secrets, dependencies), followed by an adversarial verification pass in which every High/Critical finding was re-read against source before inclusion. Findings below are code-verified with file:line unless explicitly marked *plausible*.

## What is already solid (verified correct)

The foundations are stronger than typical for this stage, and no fix should regress them:

- **Passwords:** argon2id with rehash-on-login; `None` hash never verifies; constant-time dummy-hash on the API login path defeats username-enumeration timing.
- **Sessions/tokens:** 256-bit random session token, only its SHA-256 stored; API tokens likewise; thorough revocation (logout, per-session, revoke-others, revoke-all-on-password-change, revoke-all-on-admin-reset); fresh token minted at every login (no fixation).
- **Authorization spine:** every business API router is mounted behind `Depends(require_user)`; the JSON API does **not** honor exe proxy headers; admin-only actions enforce `RequiredAdmin`; last-admin removal/deactivation blocked; no privilege-escalation-to-admin path via the API. Actor attribution on quality records (dispositions, risk acceptance, sign-offs) is session-sourced on the HTTP path.
- **CSRF:** session cookie is `HttpOnly` + `SameSite=Lax`, and there are no state-changing GET routes, so cross-site forgery cannot ride the session regardless of Origin-header edge cases. CORS never pairs `*` with credentials.
- **Onshape:** webhook HMAC is verified constant-time and fails closed when the secret is unset; the client does not follow redirects; a pasted document URL's host is discarded (no SSRF via paste). `auth_secret` has no weak default (random 32-byte secret generated and persisted `0600`). Secrets are never logged or returned by the API.
- **Injection:** all DB access is SQLAlchemy ORM with bound parameters; no `text()`/raw SQL, no shell, no `eval`/`exec` in the audited surface.

---

## Findings (severity-ranked)

Severities reflect the trusted-LAN model and the **default** deployment (`auth_mode=local`, MCP over stdio).

### C1 — exe-mode trusts spoofable proxy headers with no proxy authentication — **Critical (conditional on `OPAL_AUTH_MODE=exe`)**
`src/opal/api/middleware.py:110-223`. In exe mode, identity comes entirely from client-supplied `X-ExeDev-UserID` / `X-ExeDev-Email` headers (`:116-117`) with no shared secret, no source-IP allowlist, and no mTLS binding the app to the trusted proxy. The middleware then mints a real session cookie (`:144-150`), and the first user ever created becomes admin (`:197,205`). Any client that can reach the port directly (default bind is `0.0.0.0`) sends `curl -H 'X-ExeDev-UserID: 1' -H 'X-ExeDev-Email: x@x'` and is issued a session as that user; against a fresh exe instance, an unused id self-provisions **admin**. Not active in the default `local` mode, but a full compromise wherever exe mode is deployed without a hardened fronting proxy.
**Fix (this branch):** require a configured shared secret (`OPAL_EXE_PROXY_SECRET`) presented by the proxy on every request; fail closed (refuse to honor identity headers) when it is unset or mismatched. Recommend also binding exe deployments to `127.0.0.1` so only the co-located proxy can reach the app.

### H1 — Stored XSS on the dataset detail page — **High**
`src/opal/web/routes.py:3832` builds `data_points_json` with plain `json.dumps(...)`, and `src/opal/web/templates/datasets/detail.html:149` emits it as `const dataPoints = {{ data_points_json | safe }};`. `DataPoint.values` is user-controlled JSON (`POST /api/datasets/{id}/points`). `json.dumps` does not escape `<`/`>`, and `| safe` disables autoescape, so a value containing `</script><script>…</script>` breaks out and runs arbitrary JS on page load for every user (including admin) who opens the dataset. The very next line renders `dataset.schema` correctly via `| tojson`.
**Fix (this branch):** render the payload through Jinja's `tojson` (HTML-safe: escapes `<`,`>`,`&` to `<` etc.), matching the adjacent line.

### H2 — Inventory `PATCH` sets `quantity` directly, bypassing the ledger — **High (integrity)**
`src/opal/api/routes/inventory.py:752-784`: `InventoryUpdate.quantity` (`:44`) is written by a blind `setattr` loop (`:774-776`) with no consumption/production ledger row and no negative/serialized guard — unlike `/adjust` (`:787+`) which validates and writes a traceable delta. `PATCH /api/inventory/{id}` `{"quantity": 999999}` (or negative) rewrites on-hand stock invisibly to `get_opal_history`, defeating the traceability the system exists to provide.
**Fix (this branch):** remove `quantity` from `InventoryUpdate`; quantity changes must go through `/adjust` or `/count`.

### H3 — Passwordless accounts are claimable by any unauthenticated LAN client — **High (needs a product decision for the full fix)**
`src/opal/web/routes.py:420-427` diverts any username whose `password_hash IS NULL` to a set-password form with a signed state token that binds only the target `uid` — not the requester. `login_set_password` (`:442-479`) then sets the password with no proof of ownership. This intersects with admin password reset (`src/opal/api/routes/users.py:300-306` sets `password_hash = None`): from reset until claimed, any unauthenticated LAN peer who submits that username seizes the account. The divert is also a distinguishable response (username-enumeration / claimable-account oracle) and, unlike the failure path, does not `record_failure`, so probing is unmetered.
This is documented as intentional trust-on-first-use, so the **model** (how users receive initial passwords) is a product decision, not a unilateral code change.
**Fix (this branch, defense-in-depth):** rate-limit and meter the divert branch so it can't be probed or abused en masse. **Recommended (owner decision):** replace TOFU with an admin-issued one-time claim token handed to the user out-of-band, and return an identical generic response for unknown vs. claimable usernames to close the oracle.

### H4 — Reachable dependency CVEs — **High**
`uv run --with pip-audit pip-audit --desc` → 24 advisories across 10 packages. Reachable ones:
- **starlette 0.50.0** — PYSEC-2026-161 (Host-header path desync → auth-bypass class; *plausible* reachability via OPAL's `UserSelectionMiddleware` gating on `request.url.path`, not independently reproduced here), PYSEC-2026-249 (urlencoded form-limit bypass, DoS). Fixes land in the **1.x** line — a major bump that must be coordinated with FastAPI; too risky to apply unattended.
- **python-multipart 0.0.21** — PYSEC-2026-3036/3037 quadratic urlencoded parse (DoS), reachable on every form POST including unauthenticated `/login`. Fixed in ≥0.0.30 (minor, safe).
- **cryptography 48.0.0** — GHSA-537c-gmf6-5ccf bundled-OpenSSL advisory (transitive via fido2). Fixed in 48.0.1 (patch, safe).
- MCP CVEs (session hijack/websocket) do **not** apply — the MCP server is stdio-only.
**Fix (this branch):** bump `cryptography`→48.0.1 and `python-multipart`→≥0.0.30; add the interim middleware hardening (match the raw routed path, `request.scope["path"]`, in the exempt check) so the auth-gate does not depend on `request.url` reconstruction.

**Update — the coordinated upgrade is now done on this branch.** `fastapi`→0.139.2 + `starlette`→1.3.1 (the first FastAPI line that accepts Starlette 1.x), clearing PYSEC-2026-161 and -249. Starlette 1.0 dropped the old `TemplateResponse(name, context)` signature that OPAL uses in ~137 places; rather than churn every call site inside a security PR, a small compatibility subclass (`src/opal/web/templating.py`) accepts both forms and translates. The non-reachable transitive advisories were bumped opportunistically too (`mcp`, `pydantic-settings`, `click`, `mako`, `idna`, `pygments`, `python-dotenv`) and `pytest` in dev. `pip-audit` now reports **one** residual — `setuptools` (PYSEC-2026-3447), a build-time-only, macOS-APFS sdist-packaging edge case that does not apply to OPAL's hatchling build or its runtime. Suite: 871 passed. Call sites may migrate to the new `TemplateResponse` signature incrementally; the shim is the only thing keeping the old form alive.

### H5 — MCP server: unauthenticated DB mutation with forgeable actor — **High (capped by stdio-only transport)**
`src/opal/mcp/server.py`. The server is stdio-only (not LAN-listening), which is what keeps this out of Critical. Within that boundary: `call_tool` runs against a raw DB session with no principal (`:2136-2139`); signoff acts trust a caller-supplied `user_id` with no check the caller is that user — `sign_disposition` (`:3004,3006`) doesn't even call `_require_human_user`; routine CUD tools log with a `NULL` actor (violates CLAUDE.md rule 6); and `attach_to_step` reads an arbitrary host `file_path` (`:6238-6241`) into a downloadable attachment (`/etc/passwd`, `~/.ssh/...`).
**Fix (this branch):** make `sign_disposition` require an active human user; confine `attach_to_step` to reject absolute paths and `..` traversal. **Recommended (architectural):** bind an authenticated operator identity to the MCP session and stop trusting `args["user_id"]` for attribution; clamp `list_*` limits; keep destructive ops soft-delete.

---

## Medium findings

Fixed on this branch where the change is small and unambiguous:

- **M1 — `javascript:` URI in supplier website link** (`src/opal/api/routes/suppliers.py:26,40`; rendered as an `href`). No scheme validation → stored, click-to-fire XSS. **Fixed:** allow only `http`/`https` in `SupplierCreate`/`SupplierUpdate`.
- **M2 — Onshape document/config mutation + sync available to non-admins** (`src/opal/api/routes/onshape.py:130,232,268,341,481`). Writes the same `project_config` that `project.py` guards behind admin, and mass-mutates the parts catalog. **Fixed:** `RequiredAdmin` on the mutating/sync/delete endpoints (read endpoints stay open).
- **M3 — `GET /api/users/{id}` leaks email + admin flag** with no admin gate (`src/opal/api/routes/users.py:132-153`), while `list_users` is admin-only. **Fixed:** gate behind `RequiredAdmin`.

Also fixed on this branch (second pass):

- **M4** — `POST /inventory/{id}/count` now writes a reconciling ledger row and enforces the negative/serialized guards.
- **M5** — `POST /inventory/transfer` now joins `Part` and requires `deleted_at IS NULL`.
- **M6** — Procedure step/kit/output child endpoints reject a soft-deleted parent via `_require_live_procedure`.

Still backlog — these need a design decision or a migration (see below):

- **M7** — Login rate limiter is web-password-only and keyed `client_ip:username`; behind a proxy the IP collapses (lockout DoS + attacker indistinguishability); passkey/token paths unthrottled. *(Needs the trusted-proxy config decision.)*
- **M8** — WebAuthn challenge is client-held and not single-use (replay within the 5-minute window; counter check is skipped when the authenticator reports counter 0). *(Needs a server-side challenge store.)*

---

## Hardening backlog (defense-in-depth; not directly exploitable in the default posture)

**Fixed on this branch (second pass):**

- **`/docs`, `/redoc`, `/openapi.json`** — disabled outside `debug`; also unshadows OPAL's own `/docs` page.
- **`onshape_base_url`** — now validated as `https://` on save.
- **Upload size** — now pre-checked against `UploadFile.size` (413) before the body is buffered.
- **CSV export** — leading `= + - @` cells now neutralized; **Content-Disposition** filename ASCII-sanitized. (Also fixed a latent bug that 500'd every export.)
- **`ok.btn` macro** — literals-only contract documented on the macro.
- **OriginCheck** — now rejects `Origin: null` and cross-checks `Referer` when Origin is absent.
- **MCP** — `list_*` limits clamped to 1000; `bulk_*` batches capped at 500.

**Still open (need a decision or a migration):**

- **API tokens never expire** — add optional expiry / idle timeout (needs a small model migration + a TTL default). Surface `last_used_at` in the UI.
- **Session `Secure` flag** derives from `request.url.scheme`, blind to a TLS-terminating proxy (`X-Forwarded-Proto` not honored). *(Ties to a trusted-proxy config concept — see below.)*
- **WebAuthn RP ID** falls back to the client `Host` header when `OPAL_PASSKEY_RP_ID` is unset — pin it for non-localhost deployments.
- **Login rate-limiter keying (M7)** — key on a trusted `X-Forwarded-For` behind a configured proxy, or on username with a separate global/IP cap; throttle the passkey handshake.
- **Uploaded MIME** is trusted from the client `Content-Type` (not sniffed) — sniffing needs a new dependency (`python-magic`/`filetype`); stored-XSS-on-download is already blocked by the forced `attachment` disposition, so this is low-priority.
- **Default bind `0.0.0.0`** — document; consider defaulting to a specific interface.
- **`updater.py:138`** uses `follow_redirects=True` — safe today (fixed URL) but keep the update URL non-attacker-influenced.
- **MCP** architectural auth (see H5): bind an authenticated operator identity to the session.
- **Attachments/datasets** have no per-user access control (flat by design) — if compartmentalization is ever wanted, scope reads and restrict deletes to admin/uploader.

A recurring dependency below is a **trusted-proxy config concept** (e.g. `OPAL_TRUST_PROXY` + trusted-proxy CIDRs): it would let OPAL honor `X-Forwarded-Proto` (Secure flag), `X-Forwarded-For` (rate-limiter keying, M7), and interacts with the exe-proxy work (C1). Worth deciding once, then applying across these items.

---

## Priority for v1.4.0

1. **C1** before any exe-mode deployment (fixed here; also front with a hardened proxy + `127.0.0.1` bind).
2. **H1, H2** — trivially exploitable, fixed here.
3. **H4** — apply the safe dependency bumps now (fixed here); schedule the Starlette 1.x + FastAPI upgrade before GA.
4. **H3** — deploy the metering fix now (fixed here); make the account-claim-model decision before onboarding new clients.
5. **H5 / M1–M3** — MCP hardening + the small Medium gaps, fixed here; the MCP architectural item is a follow-up.
