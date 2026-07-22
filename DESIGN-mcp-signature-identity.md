# Design note — MCP signature & operator identity

Status: **open thought problem** (deferred out of the v1.4.0 security pass)
Origin: security audit finding **H5**. See `SECURITY-AUDIT-v1.4.0.md`.
Tracked as risk: **#76**.

## Problem

MCP tools are called by an agent (Claude), but many of them write records that
are supposed to attribute to — and be authorized by — a **real human**:
disposition sign-offs, risk acceptance/review, part activation, requirement
baselines. Today the agent supplies `user_id` as a tool argument and the server
stamps it (`_require_human_user`, `server.py`), so the agent can attribute an
authoritative action to any active user, including an admin. A "signature" today
is a plain attribution (`dispositioned_by_id` FK + timestamp + rationale) — not a
cryptographic signature and not bound to the record's content.

## The fundamental constraint

A signature must be **unforgeable by the agent**. The agent is the process making
the calls. Therefore:

> Any signature the agent can produce on its own is a signature the agent can forge.

Per-action human authority is therefore **fundamentally incompatible with the
agent acting autonomously**. Binding a real human to a specific sign-off requires
a human action through a channel the agent does not control (the web UI, a
hardware key, a CLI confirm). No key scheme removes the human gesture — it only
makes the gesture cryptographic. The design question is *which actions require an
out-of-band human gesture, and how heavy that gesture is.*

## The ladder

| Level | Mechanism | Agent can forge? | Proves human saw *this* record? | Cost |
|-------|-----------|------------------|--------------------------------|------|
| 0 (today) | agent passes `user_id` | **yes** | no | none |
| 1 | authoritative tools **refuse** for the agent; agent may only draft/prepare | no (can't do it at all) | n/a — human commits in OPAL | ~zero |
| 2 | agent creates a *pending* record; a human approves it in the web UI under their own login | no | **yes** | async; human must be at the UI |
| 3 | human signs a hash of the record with a private key; server verifies vs. their public key | no | **yes**, + non-repudiable + tamper-evident | Level 2 handoff **+** a key gesture |

Notes:
- **Level 1 is not "delegation."** An earlier proposal (bind one operator identity
  to the session, let the agent sign as it) was rejected: that still lets the agent
  sign in place of a human. The product rule is that the agent must **never**
  complete an authoritative sign-off. Drafts are fine; commits are human-only.
- **Level 3 already has its primitive in OPAL.** FIDO2 passkeys
  (`PasskeyCredential.public_key`) are per-user keypairs and WebAuthn assertions
  carry a challenge. Make the challenge a hash of the record and store the
  assertion as the signature → non-repudiable e-signature. The gesture still routes
  through a browser/secure context, so Level 3 ≈ Level 2's handoff plus crypto.

## Decision (2026-07-22)

- **Level 2+ is the target norm.** The agent proposes/drafts; a human approves.
- **Hard rule, effective now:** the agent must not be capable of signing off in
  place of a human at any time. Immutable hardware/quality changes are human-only.
- **Ship now (Level 1):** the authoritative MCP tools refuse to execute for the
  agent and direct it to prepare a draft for human approval in OPAL.
- **Deferred thought problem:** Level 2 (propose→approve) and Level 3 (crypto
  e-signature), plus the open strategy question — *which* actions an agent may ever
  be granted authority over, and under what conditions. Flagged as a genuinely
  interesting future direction, not committed.

## Tool classification (for Level 1)

Handlers currently gated by `_require_human_user`:

**Human-only — agent blocked (immutable / sign-off):**
`sign_disposition`, `accept_risk`, `set_risk_disposition`, `stamp_risk_review`,
`activate_part`, `bulk_activate_parts`, `baseline_batch`, `reaffirm_requirement`.

**Agent-OK — ephemeral session/cursor state, not a sign-off:**
`join_execution`, `focus_step`.

**Gray — decide under the deferred thought problem:**
`complete_step` (records human work + may emit immutable genealogy/output;
high-frequency in agent-assisted execution), `bind_issue_hold` (operational
containment).

## Open questions for the thought problem

- What is the smallest set of actions an agent may *ever* be authorized to commit,
  and what would authorize it (a standing human policy? a signed capability grant?)?
- Does `complete_step` count as an immutable hardware change, or as routine
  attribution? (It emits genealogy/output.)
- Level 2 mechanics: pending-approval queue in the web UI, notifications, expiry,
  and how the agent observes completion.
- Level 3: WebAuthn assertion over a canonical record hash; how to canonicalize
  the record; how to store/verify the assertion; behavior when a passkey is absent.
