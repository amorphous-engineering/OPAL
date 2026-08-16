# Changelog

All notable user-visible changes to OPAL. Dates are release dates.

## Unreleased

### Added
- **OpenID Connect single sign-on.** OPAL can now federate with any spec-compliant OIDC provider — Pocket ID, Authentik, Keycloak, Auth0, Entra ID — using the OAuth 2.0 authorization-code flow with PKCE. Configure it at **Settings → Authentication**: issuer URL, client id, optional client secret, scopes, and the group claim that grants admin. A **TEST DISCOVERY** button fetches the provider's metadata and reports the endpoints it advertises, and the page shows the exact callback URL to register with the provider.
- **Group-mapped admin rights.** Membership in `OPAL_OIDC_ADMIN_GROUP` grants admin on every sign-in, and losing it revokes admin. Leave the field blank to manage admin rights entirely inside OPAL.
- **Account linking.** An existing password account whose email matches a verified OIDC identity adopts single sign-on on first use, keeping its history, sign-offs and API tokens. Thereafter the account is matched on the provider's stable subject, so an email change never orphans it.
- **Independent sign-in toggles.** Password, passkey and OIDC sign-in are now switched on and off separately rather than chosen between. Password sign-in can only be disabled once OIDC is configured — OPAL refuses the change that would leave nobody able to reach the web UI.

#### Extensions
- **Extension system.** An extension is a directory with an `opal-ext.yaml` manifest. **Settings → EXTENSIONS** lists what is installed, what state each one is in, and what it provides; each extension has its own page with its manifest, its content, and its enable/disable switch.
- **Install from a ZIP archive.** Admins upload an archive on the extensions page. Archives may contain procedure and dataset templates; the manifest declares them under `provides:`. Reinstalling the same id upgrades it in place. Uninstall deletes the extension's files and registry entry — content already imported from it stays, because it became project data at import.
- **Declarative content, imported explicitly.** Procedure templates import as draft master procedures; dataset templates import as datasets. Nothing is written to the project until an admin presses IMPORT.
- **Installed extensions do not run code.** An uploaded archive declaring a `code:` entry point is refused at install with an explanation, not ignored. Only extensions bundled with OPAL run Python. Archives are also refused when oversized, manifest-less, incompatible with this OPAL version, shadowing a bundled id, or containing members that would write outside their own directory.
- **Onshape is now a bundled extension** (`opal.onshape`). Its panel moved from the main settings page to **Settings → EXTENSIONS → opal.onshape**, which is also where it is switched on and off. Disabling stops polling and hides the panel; credentials are kept, so re-enabling resumes where it left off. All Onshape URLs and API endpoints are unchanged.
- Extension installs, state changes, and uninstalls are audited with the acting user.

### Removed
- **exe-proxy authentication.** The `exe` auth mode, which trusted `X-ExeDev-UserID` / `X-ExeDev-Email` headers from a reverse proxy, is gone along with the `OPAL_AUTH_MODE` and `OPAL_EXE_PROXY_SECRET` settings and the `user.exe_user_id` column. No request header confers identity any more; every sign-in method mints a real session. Deployments running exe mode fall back to password sign-in on upgrade — configure OIDC and have users sign in once to re-link their accounts, or issue password-claim links from the Users page.

### Changed
- First-run setup no longer asks for an auth mode. It creates the first admin account, which is always credentialed so an unreachable identity provider can never lock an instance out. When OIDC is pre-configured by environment, setup also offers a sign-in button and the first identity to use it becomes admin.
- Signing out ends the OPAL session only, leaving the identity provider's own session alone — a per-app sign-out button should not sign you out of every federated application.

## 1.3.0 — 2026-05-17

First major release under the **amorphous engineering** org.

### Added

#### Execution viewer
- **Tabbed execution detail UI.** `/executions/{id}` is split into six focused tabs — Meta, Operations, Data, BOM, Issue Tickets, Kitting — replacing the long stacked-panel page. Tab switching is an HTMX partial-swap so URL state (`?tab=<slug>&op=<order>`), back/forward, and scroll position are all preserved.
- **Per-operation focus in the Operations tab.** The right pane renders only the selected op's steps; the sidebar lists every op with name (truncated), `OP <n>` + progress + status, and the global StepExecution ID. Sidebar clicks swap just the op block.
- **Captured-data audit table.** The Data tab shows a flat audit-style table (step / field / value / by / at) of every `data_captured` value across the run. Multi-photo fields render as `N image(s) (#id, #id, …)`.
- **Issues badge.** The Issues tab label shows the linked-issue count; the old red full-page alert banner is gone.
- **NC step-hold.** Logging a non-conformance against a step automatically puts the step into `ON_HOLD` and shows a banner across the top of the step content listing the open NCs. START/COMPLETE/SKIP are suppressed. The step auto-resumes to `IN_PROGRESS` the moment every linked NC reaches a terminal disposition (`disposition_approved` or `closed`).
- **Execution gating** from the version snapshot. Ops whose prerequisite ops aren't all in a terminal status surface a yellow `PENDING` chip in the sidebar and `PENDING — waiting on OP X, Y` in the main pane; the START API also refuses the transition.

#### Procedure-template editor
- **Tabbed editor shell** at `/procedures/{id}` — Meta / Operations / Flow / Kit / Outputs / Versions. Mirrors the execution viewer's HTMX-driven tab pattern.
- **Inline step editor.** Each step row in the Operations tab expands to a full editor (title, instructions, duration, sign-off / contingency flags, step-parts table, data-capture schema builder) — no more separate `/steps/{id}/edit` page. The legacy URL redirects to the inline view with the right step pre-expanded.
- **Drag-to-reorder.** Sidebar ops and main-pane sub-steps are drag-reorderable. On drop the API runs the reorder and the OP / sub-step *display numbers* renumber to match (`OP 1`, `OP 2`, …, contingency ops as `C1`, `C2`, …, sub-steps as `<parent>.<n>`).
- **Flow tab — operation dependency graph.** Resolve-style node graph: each op is a node auto-laid-out by longest-path topological depth; drag from a node's right-edge output port to another's left-edge input port to add a dependency; hover an edge to surface a red X to remove it. Cycle and self-loop are rejected with clear errors.
- **Data-capture `photo` field type.** Single or multi-image per field — operators upload during execution (mobile triggers the camera natively); thumbnails render inline with a REMOVE button; the schema builder offers an "Allow multiple photos" toggle.
- **Inline images in step instructions.** Drag-drop an image onto the instructions textarea or click `INSERT IMAGE`; the helper uploads to `/api/attachments/upload` (scoped to the procedure for cascade cleanup), then splices `![filename](/api/attachments/N/download)` at the caret. The markdown renders the image inline in both the editor's preview and during execution.

### Changed
- Tab strip styled to match `.nav-dropdown-btn` (transparent → orange-bordered active state) so the new chrome reads as the same family as the top nav.
- Status footer is now `position: sticky; bottom: 0` — stays visible at the viewport bottom on long pages.
- Sub-step headers in the Operations tab render `op#.step#` (e.g. `8.5 Verify Charge Continuity`) even when the version snapshot only stores the sub-step part.
- **Textareas auto-grow with content.** Resize handles removed app-wide; CSS `field-sizing: content` powers modern browsers, a small JS handler covers the rest.
- **Mono/sans rule applied consistently.** Sans for prose (op titles, step titles, login subtitles, narrative); mono retained for chrome and data (IDs, timestamps, status pills, table data).
- **JetBrains Mono and IBM Plex Sans are self-hosted.** One variable-axis woff2 per family (latin subset), served under `/static/fonts/`. No external CDN dependency; visual experience is now identical across macOS / Windows / Linux.
- Repo migrated to the `amorphous-engineering/OPAL` GitHub org; all install scripts, auto-updater URLs, and CI references updated.
- Single source of truth for `__version__` — derived from `pyproject.toml` via `importlib.metadata`; the release workflow writes the tag-derived version into the binary at build time.

### Fixed
- **Auto-updater crash on Textual app thread** (regression in 1.2.1). `_apply_update` no longer wraps its UI callback in `call_from_thread`, which Textual rejects on the app's own thread. Affected installs on ≤1.2.4 need a manual binary swap to escape; 1.2.5+ updates cleanly.
- Windows installer now auto-adds the install location to PATH.
- Updater silently dropped malformed release tags (returned `None` with no log) — now logs a warning when a tag fails to parse.
- Updater raised a bare `OSError` when the running binary lived at a write-protected path (e.g. `/usr/local/bin/opal`) — now raises a clear `RuntimeError` naming the path and pointing to permissions.
- MCP server's startup-time `print(..., file=sys.stderr)` calls replaced with `logging` so MCP logs format consistently with the rest of the app.
- Procedure ops in the editor are now sorted by `order` (the field the reorder API updates) instead of by their display step-number label, so drag-reorder is actually reflected on the next render.
- `/api/attachments/upload` FK fields (`procedure_instance_id`, `step_execution_id`, `issue_id`) are now read from the multipart form body via `Form()`. They were silently dropped before — uploads from the JS layer were never linking to their parent record.
- Sidebar drag-reorder works on `<a href>` rows by suppressing native link-drag and text-selection so the pointer-event handler can actually run.

### Known limitations
- **Inline images in published versions can 404 after the procedure is deleted.** Soft-deleting a procedure cascades attachment rows, so markdown stored in a `ProcedureVersion.content` snapshot referencing those images will render broken thumbnails. Versions are supposed to be immutable; this is a real gap that will be addressed in a follow-up (likely by promoting "delete with versions" to "archive" or by copying image bytes into the snapshot).
- **Sidebar drag-reorder is mouse-only.** Touch / pen pointer support is on the 1.3.x list.
- **`OPAL_manual.md` predates the 1.3.0 UI rewrites.** A docs-only point release will bring it up to date.

### Internal
- Ruff pass + reformat across `src/`.
- Release CI builds binaries for macOS arm64, macOS x86_64, Linux x86_64, and Windows x86_64.
- Two Alembic migrations: `bb285af00e88` (step_dependency table) and `eb217417d6d2` (attachment.procedure_id column).
