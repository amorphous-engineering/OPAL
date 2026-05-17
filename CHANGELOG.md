# Changelog

All notable user-visible changes to OPAL. Dates are release dates.

## 1.3.0 — 2026-05-17

First major release under the **amorphous engineering** org.

### Added
- **Tabbed execution detail UI.** `/executions/{id}` is split into six focused tabs — Meta, Operations, Data, BOM, Issue Tickets, Kitting — replacing the long stacked-panel page. Tab switching is an HTMX partial-swap so URL state (`?tab=<slug>&op=<order>`), back/forward, and scroll position are all preserved.
- **Per-operation focus in the Operations tab.** The right pane renders only the selected op's steps; the sidebar lists every op with name (truncated), `OP <n>` + progress + status, and the global StepExecution ID. Sidebar clicks swap just the op block.
- **Captured-data audit table.** The Data tab shows a flat audit-style table (step / field / value / by / at) of every `data_captured` value across the run.
- **Issues badge.** The Issues tab label shows the linked-issue count; the old red full-page alert banner is gone.

### Changed
- Tab strip styled to match `.nav-dropdown-btn` (transparent → orange-bordered active state) so the new chrome reads as the same family as the top nav.
- Status footer is now `position: sticky; bottom: 0` — stays visible at the viewport bottom on long pages.
- Sub-step headers in the Operations tab render `op#.step#` (e.g. `8.5 Verify Charge Continuity`) even when the version snapshot only stores the sub-step part.
- Repo migrated to the `amorphous-engineering/OPAL` GitHub org; all install scripts, auto-updater URLs, and CI references updated.
- Single source of truth for `__version__` — derived from `pyproject.toml` via `importlib.metadata`; the release workflow writes the tag-derived version into the binary at build time.

### Fixed
- **Auto-updater crash on Textual app thread** (regression in 1.2.1). `_apply_update` no longer wraps its UI callback in `call_from_thread`, which Textual rejects on the app's own thread. Affected installs on ≤1.2.4 need a manual binary swap to escape; 1.2.5+ updates cleanly.
- Windows installer now auto-adds the install location to PATH.
- Updater silently dropped malformed release tags (returned `None` with no log) — now logs a warning when a tag fails to parse.
- Updater raised a bare `OSError` when the running binary lived at a write-protected path (e.g. `/usr/local/bin/opal`) — now raises a clear `RuntimeError` naming the path and pointing to permissions.
- MCP server's startup-time `print(..., file=sys.stderr)` calls replaced with `logging` so MCP logs format consistently with the rest of the app.

### Internal
- Ruff pass + reformat across `src/`.
- Release CI builds binaries for macOS arm64, macOS x86_64, Linux x86_64, and Windows x86_64.
