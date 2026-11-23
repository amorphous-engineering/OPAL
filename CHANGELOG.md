# Changelog

All notable user-visible changes to OPAL. Dates are release dates.

## Unreleased

### Added
- **Work orders name the units they act on.** An OP declares unit slots (a test names the unit under test and its fixture). At run time each slot names a serialized stock record, or borrowed gear as text. The names can be taken back while the OP is workable and are on record once it completes, and a required slot stops its OP. A kit line can install INTO a slot, and a removal takes a component out of a named unit: a serialized one can go back to stock under its own OPAL number. A unit's page lists the work orders that named it and counts the completed ones per procedure. + OTHER HARDWARE names gear no slot asked for.
- **A second sign-off can be waived when one person is there.** Two slots still mean two people: the same person never signs both. The waiver is its own record with a reason, who and when, and the step stamp reads "BL WAIVED 20:00". The slot's role and any hold still apply.
- **A warning callout**, for a person who can be hurt, above caution (hardware or work) and note. 1.x warnings import as warnings.
- **Part numbers in step text link to the part**, in instructions, issue and risk text and notes. Numbers OPAL does not know stay plain text.
- **Role marks on steps.** A step can name the role that does it, shown as the role's letters in its colour beside the step number, on screen and on the traveler. It gates nothing. A role's letters and colour are set on the role, and a published version keeps the mark it was published with.
- **Roles can belong to a project**: crew positions that only that project's procedures offer, managed on the project page. They pass no gate. Settings keeps the organization's roles, which do.
- **Each bulk part says whether its receipts need the supplier's lot**: as its tier says, always (O-rings, adhesives) or never (parts made to print). A serialized part never needs a lot.
- **A new demo dataset, Mojave Sphinx**, adapted from Half Cat Rocketry's HCR-5100 guidebook under the GPL, in `demo/mojave-sphinx/`. `server/scripts/load-demo.ts` loads it into a new data folder through OPAL's own operations: 173 parts, 21 procedures, 35 work orders, purchase orders, issues, risks, requirements and datasets. LOAD DEMO in the app still loads the 1.x seed.

### Changed
- **The template editor shows what a step has, and offers the rest once.** An open step shows its instructions and whatever it holds (callouts, images, parts, data, sign-offs, role, duration). One ADD bank offers the rest. Empty sections are no longer drawn as "none" in edit mode. The formatting toolbar shows only while you type in a box. Every OP has a + STEP key at its foot, and titles are drawn as fields.
- **A new template starts from its details.** + NEW TEMPLATE opens the details with the T-number the template would take. Nothing is created, and no number is used, until CREATE, which goes straight into the editor.
- **A routine step shows no sign-off.** A step anyone may complete no longer reads "Primary buyoff" in the editor or the reader. A declared sign-off reads Sign-off and Second sign-off, with "Any role" when it names none.
- **A data field can use a unit outside OPAL's list**, typed as written; it is never converted. The common units come first in the picker. Only a number field has a unit, and the field's internal key is no longer shown.
- **The Graph tab is now Sequence**, on templates and work orders. Which OPs wait on which, and whether an OP's steps go in order (IN ORDER, formerly SEQ), are set there, not in the document.
- **Every action in the template editor is a key.** Blue text now only links somewhere. Row tools, field tools and the ADD list are banks of small keys.
- **Every new-record form has the same shape.** Projects, workcenters, users, suppliers, issues, risks, requirements, purchases, work orders, stock receipts, datasets, parts and templates: one box, labels over fields, a quiet mark on required fields, and CANCEL then the one primary key at the bottom right. While the primary key is inert it says what it still needs ("Needs project and title"). Blue-text CLEAR, REMOVE and + ADD are keys. Placeholders that looked like values (SUP001, AB1, https://) are gone, and so is copy that explained the form.
- **A new issue, risk, requirement, purchase, work order or stock receipt shows the number it will take.** A batch cut or a receipt of several units shows the range. Nothing is reserved, so leaving the form uses no number.
- **Raising an issue is RAISE, and from a run it asks only for a title.** + ISSUE on a step or work order carries the work order, step, part and person as facts, with type and containment filled in; description, priority, assignee and should-be/is are written on the issue under EDIT. From the issue list or a project the form is one box, with assignee and part beside the other fields.
- **A purchase starts with no supplier chosen.** Pick one from the list, or OTHER to type a name. A blank line destination shows the order's destination it will take.
- **A purchase receipt records the supplier's lot** again, typed on the receive row of a bulk part. A serialized part takes its serial in its own field.
- **A short step is one row with a tick.** A step with a title and nothing else (no instructions, pictures, fields, callouts or declared sign-off) completes from its row, and the traveler prints a run of them as tick rows. Routine steps print a blank for initials instead of "Primary buyoff".
- **Contingency operations are numbered from C901**, so one is never read as a normal OP. Versions published before keep C1, C2, and the version diff treats C1 and C901 as the same step.
- **AFTER OP is said once** on an operation whose steps all wait on the same earlier OP.
- **Every non-conformance takes a disposition**, whether or not it holds a work order. Use as is, rework, repair, scrap, return to supplier or no defect is filled in and signed under EDIT, and signing it starts the work. A non-conformance can no longer close without one. One already started without a disposition stays in work and needs a signed disposition before review.
- **An issue's type can change only until work starts** or a disposition is signed, since the type decides which steps the issue goes through.
- **RETURN sits beside SIGN OFF** on an issue in review, no longer under MORE.
- **The bug issue type is now called anomaly**: something behaved in a way nobody expected, and the cause is still being found. Existing bugs, and bugs imported from 1.x, become anomalies. "Actual behavior" reads "Observed behavior".
- **A record's state sits at the right end of the breadcrumb bar**, in the same place on every record page, no longer after the title.
- **Redlines are written as drafts and released by the disposition signature.** A draft sits dashed above the OP it gates, where it is written, and the floor cannot work it. Signing the issue's rework or repair disposition releases its drafts, so the hold passes straight to the redline gate and the OP never runs free in between. A draft written after the disposition is released on the work order. A released redline is no longer deleted.
- **A redline can use parts and replace lines of the planned kit.** The replaced line reads struck on its step and in the Material tab, with the new part under it. The published procedure version does not change.
- **The issue page shows the rework as a Correction row**, listing each redline with its state and who finished it. WRITE REDLINE replaces SPAWN REDLINE OP. Signing rework or repair without a redline asks once, inline. Review waits until every redline is finished.
- **Corrective action can link a procedure revision.** The issue cannot close until the next version of that procedure is released.
- **Issues beside the work are grouped by when their hold is due**, one line each: blocking now, due by the end of each OP, due by the end of the work order, other open, and closed folded away. The red HELD BY band across the work order is gone.
- **The issue page names the step**: Containment reads STEP 5.4, and Work order reads WO-0002 OP 5.2.
- **The stock list opens on its records**, one row per OPAL number. BY PART is a click away, and a link to low stock still opens by part.
- **A work order's issues show all of them by default.** The toggle narrows them to the OP in focus.
- **Plugin panels and external links moved to the work order's Details tab.**
- **Scroll bars match the page**: a ruled box on a dithered track, in day and night. The page scrolls between the header and the status bar, which stay full width.
- **Wording for any kind of hardware.** A new organization's tier presets are Critical, Standard and Bulk, and examples no longer assume a rocket.

### Fixed
- **The systemd user units start on Ubuntu 24.04.** `contrib/opal.service` and `opal-backup.service` asked for ProtectKernelModules and ProtectKernelLogs, which a user unit cannot apply, so the service failed at every start with status 218. Both lines are gone; the rest of the hardening stays.
- **The Material tab opens on a work order with planned outputs.** A work order whose procedure plans outputs, with nothing produced yet, showed "500 Internal Error" on its Material tab instead of the assembly output form.
- **Demo mode builds its files in the demo folder.** It took its folders from the real data folder, so a seed with attachments would have copied them into the real organization's files. The shipped seed has none, so nothing was written.
- **A long step number keeps its own column**: C903.13 ran into its title on the run view.
- **A number field shows its unit once.**
- **An OP with sub-steps shows its unit slots** on the run view and in the editor.

### Upgrading
- **Seven migrations (0013-0019) run at the first start**, after OPAL copies the database beside it: the anomaly type, redline release, sign-off waivers, units, role marks, project roles and the part lot rule.
- **API: `issueType: "bug"` is refused**; send `"anomaly"`.
- **API: a receipt's serial goes in `serialNumber`.** In beta.2 a one-unit serialized receipt took its serial from `lotNumber`; `lotNumber` is now only the supplier's lot.

## 2.0.0-beta.2

### Added
- **`opal backup <folder> [--keep <n>]`.** Writes a checked backup while OPAL runs: the database, attachments, avatars, plugins and key files. A backup holds secrets, and its files are owner-only. A missing or damaged attachment file is left out and named, so the backup of everything else still finishes, and `--keep` removes no older backup until the file is put back.
- **`opal restore <backup-folder>`.** Restores into an empty data folder, and refuses a folder with anything in it or an incomplete backup.
- **systemd user units in `contrib/`.** `opal.service` runs `opal serve`, and `opal-backup.timer` backs up nightly and keeps 14.
- **Stored secrets are encrypted.** The single sign-on client secret and plugin secrets are encrypted in the database with a key kept outside it: `.opal_secrets_key` in the data folder, or `OPAL_SECRETS_KEY`. Existing secrets are encrypted at the first start. Back up the key with the data, and see [Stored secrets and their key](README.md#stored-secrets-and-their-key) for what happens without it. `opal secrets rotate` changes the key. When a plugin update makes a setting secret, its earlier values are hidden in the audit log, and a new audit entry records that. Onshape settings and API keys from a 1.x database are removed at the first start, since OPAL does not use them. `opal.legacy.db` still holds them.
- **OPAL 2 imports real 1.x databases**, from every release from 1.2.2 through 1.4.0-beta.3. The first start, or `opal import`, brings a private copy forward and imports it. The original stays as `opal.legacy.db`, byte for byte. `import-report.txt` lists every table in the old file and what became of its rows. The import keeps every row or does not happen: one failed row leaves the old database in place, and `opal import --accept-failed-rows` goes on after you have read which rows they are.
- **The import survives a crash, in 1.x or in itself.** An unfinished write from 1.x is undone on the private copy, and the original moves together with its journal. An import stopped at any point leaves the old database working, and a large one is not killed for taking a while.
- **Records with one number all stay.** Work orders, orders and parts that share a number, at any width, stay separate: the later one reads as that number with `-DUP2`, and the report lists each change.
- **What someone signed stays.** A 1.x disposition of `other` still reads `other`, as it was signed. Requirements from `opal.project.yaml` become draft requirements, and part allocations stay with them, verified and waived ones too.
- **A printed sign-in link for databases from before 1.4.** They have no passwords, so the first start prints a link where the administrator sets one.
- **`opal.project.yaml` is read once** for databases from before 1.4, so the project name, tiers and part numbering carry over. `opal import --project` names the file if OPAL cannot find it.

### Security
- **Plugins are confined on Linux.** A plugin reaches only its own `plugin-data/<id>`, its code and system files, using Landlock and a seccomp filter, or a separate OS user when OPAL runs as root. The plugin page shows the result under **Confinement**, and `OPAL_PLUGIN_CONFINEMENT` can require it or turn it off. macOS, Windows and Linux without Landlock are not confined: there a plugin still has shell-level access. A plugin that used `/tmp` or files outside its repository must change, see the SDK README.

### Not carried over
- Extensions, Onshape links and Onshape keys. The report lists them. When keys were left out, the import also warns in the terminal: they are still in plaintext in the old database, so revoke them in Onshape if you no longer need them.
- Free-text part requirement rows from before the requirement register, when no requirement has that number. They stay in the `legacy_row` table, and the report lists them.

### Fixed
- **A revised requirement no longer strands its parts and children.** When a revision baselines, each allocated part gets a new open allocation to verify against the new text, and the old allocation stays as the evidence for the old text. Children move to the new revision and stay STALE until someone reviews them. Revisions superseded before this fix keep their old allocations: allocate the part again from its page.
- **A cancelled draft revision no longer leaves its requirement stuck.** The baseline stays in force, takes new allocations and can be revised again. The cancelled draft stays on record under its own revision number. A baseline with a draft revision open cannot be cancelled until the draft is.
- **A risk can no longer link or unlink a void issue.** A void issue takes only comments, from the risk's page as from its own.

## 2.0.0-beta.1

OPAL 2 is a rewrite in TypeScript: one Bun binary, one SQLite file. The Python 1.x backend is gone, and
extensions and Onshape are postponed. These changes are since `v2.0.0-rc.24`.

### Changed
- **Committed records read like paper.** Pages open for reading, EDIT shows only what is still pencil, and strikes sit under MORE. A placed purchase order is amended with the old value struck beside the new one. `RECORDS.md` lists what each record offers in each state.
- **Routine work stays out of the way.** ABORT is gone: an unstarted work order is voided, and a started one exits through a contingency op or a gated close short with a reason and a linked issue. The notes box is always open on a step, and a typed note saves with COMPLETE or SKIP. A second sign-off must come from a different person.
- **The PAPER look.** Black ink on white paper, or reversed at night, with one meaning for each line, shadow and fill. Day is the default. `STYLE.md` is the new style guide.
- **State by importance.** Stopped and waiting records are filled, in flight is bold, reached states are green words, not started is tan, and finished-with records fall back.
- **Nothing below 12px** on screen, except printed labels and the traveler. Step text can be 14, 16 or 18px per browser.

### Added
- **Connection ticker.** ONLINE, STALE or OFFLINE at the left of the status bar. Any break stays as STALE with its times until pressed, which reloads the page's data.
- **Last action** on the executions list, as a column and the default sort.

### Fixed
- HOLD and HELD were nearly invisible in dark mode.
- Migrations ran with foreign keys on, so a table rebuild could cascade-delete child rows.
- Any user or token could void an issue to release its hold. Releasing a hold now needs the disposition gate.

## 1.4 betas (the 1.x line)

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

#### Notifications
- **Notification system.** A **NOTIFS** control in the menu bar shows your unread count and the eight most recent items; `/notifications` is the full inbox, with category (issues / executions), read-state and sort (recent, priority, unread-first) filters, plus per-item dismiss and MARK ALL READ. Selecting a notification marks it read and takes you to the record it points at.
- **What raises one.** An issue assigned to you; an issue you raised or own being dispositioned, commented on, or closed; and a work order you have worked becoming blocked or unblocked. "Worked" means you started the work order or completed or signed off a step on it — having the page open does not count.
- **Blocked and unblocked report transitions, not events.** Holds are derived, so a second blocking issue on an already-blocked run is silent, and the run reports unblocked only when the last blocker clears — by disposition, closure, downgrade to advisory, or deletion.
- **You are never notified of your own action.** Assigning an issue to yourself or commenting on your own issue puts nothing in your inbox.
- Notifications carry no state of their own: dismissing one never touches the issue or work order it points at. Push delivery stays out of core and is left to a future extension.

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
