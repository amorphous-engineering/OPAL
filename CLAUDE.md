# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OPAL (Operations, Procedures, Assets, Logistics)** is a local-first ERP system for small teams and hardware projects. Single SQLite database, runs on one machine, accessible over local network. No cloud dependencies.

- **Stack**: Python 3.11+, FastAPI, SQLAlchemy 2.0+, Alembic, HTMX + Jinja2 templates, SQLite
- **Package manager**: [uv](https://astral.sh/uv)

## Commands

```bash
# Setup & run
uv sync                                              # Install dependencies
uv sync --all-extras                                 # Install with dev/tui/app/e2e extras
uv run opal init                                     # Initialize database
uv run opal serve                                    # Start server at http://localhost:8080
uv run opal seed                                     # Seed demo data

# Testing
uv run pytest                                        # Run all tests (in-memory SQLite, with coverage)
uv run pytest --no-cov                               # Fast local run — coverage roughly doubles runtime
uv run pytest tests/unit/test_parts.py               # Run a single test file
uv run pytest tests/unit/test_parts.py::test_name -v # Run a single test

# Linting & formatting
uv run ruff check src/                               # Lint
uv run ruff format src/                              # Format

# Database migrations
uv run opal migrate generate --message "Description" # Autogenerate migration
uv run opal migrate upgrade                          # Apply migrations to head
uv run opal migrate downgrade                        # Rollback one migration

# Build standalone binary
uv run pyinstaller opal.spec                         # Output: dist/opal
```

## Architecture

### Routing layers
- `/api/*` — JSON API via FastAPI route modules in `src/opal/api/routes/`
- `/*` — HTMX web UI, all routes in single file `src/opal/web/routes.py`
- Templates in `src/opal/web/templates/` (Jinja2)

### Code organization
- `src/opal/api/routes/` — FastAPI JSON API endpoints
- `src/opal/core/` — Business logic (audit, inventory, designators, genealogy)
- `src/opal/db/models/` — SQLAlchemy ORM models (19 model files, re-exported from `__init__.py`)
- `src/opal/db/base.py` — `Base` declarative base, `IdMixin`, `TimestampMixin`, `SoftDeleteMixin`
- `src/opal/web/routes.py` — All HTMX web routes (~85KB single file)
- `src/opal/config.py` — Settings via pydantic-settings, all env vars use `OPAL_` prefix
- `src/opal/project.py` — `opal.project.yaml` bootstrap loader (read-once, deprecated as a write target); live project config (tiers, part numbering, categories) is stored in the `app_setting` table under the `project_config` key
- `src/opal/core/lifecycle.py` — demo-database switching (separate throwaway `demo.<name>` file) and factory reset; one instance = one project
- `src/opal/integrations/onshape/` — Onshape CAD integration (client, sync engine, polling). Supports both assembly BOM sync and part studio sync via `element_type` config field.
- `src/opal/mcp/server.py` — MCP server for Claude Code integration
- `src/opal/launcher.py` — Textual TUI desktop launcher
- `src/opal/__main__.py` — CLI entry point (`opal` command)

### Application factory
`opal.api.app:create_app()` builds the FastAPI app, mounts static files and web routes, configures middleware.

### Auth modes (`OPAL_AUTH_MODE`)
- `local` (default): Cookie-based user selection via `/login`
- `exe`: Trust proxy headers `X-ExeDev-UserID` / `X-ExeDev-Email`, auto-provision users

### Test infrastructure
- Fixtures in `tests/conftest.py`: in-memory SQLite engine, per-test rollback transactions
- `client` fixture provides `TestClient` pre-authenticated as an admin service user (Bearer token)
- `auth_headers` fixture provides `{"Authorization": "Bearer <token>"}` for `test_user`; `web_client` adds the session cookie for web-page GETs

## Critical Rules

1. **All schema changes via Alembic migrations** — never raw DDL, never `Base.metadata.create_all` in production code
2. **SQLAlchemy ORM exclusively** — no raw SQL strings
3. **ISO 8601 timestamps everywhere** — never relative times ("2 hours ago"). Exception: dense index rows (e.g. the requirements tree) may show a relative age ("2d") with the full ISO 8601 timestamp in the tooltip.
4. **Published procedure versions are immutable** — editing master never affects published snapshots
5. **Soft deletes** via `deleted_at` field on most entities — don't hard-delete
6. **AuditLog records every CUD** — use `log_create`/`log_update`/`log_delete` from `src/opal/core/audit.py`
7. **Part IDs are system-unique and never reused**

## UI/UX Philosophy (US Graphics Style)

Dense, explicit, functional. Expose state and inner workings. Data tables over cards. Monospace for data-heavy areas (part numbers, IDs, timestamps). No rounded corners, shadows, or gradients. No progressive disclosure — show all relevant information. High-contrast functional color palette (green=good, yellow=warning, red=error).

**One fact, one home.** Every other appearance is a live reference, never a copy. Test: if updating something requires touching two places, the design is wrong — delete one occurrence or derive it. PRs that violate this must argue against it by name.

**The empty-state rule.** Emptiness is information only where content is expected; declared intent decides where it's expected, and data always renders. A part's `procurement` (make | buy | both) declares expectation: BOM expects content on make|both, SUPPLIERS and PO LINES on buy|both, everything else always. An irrelevant empty section is absent — not collapsed, absent — while any section with rows renders regardless of the declaration. An empty relevant section is ONE line — `LABEL — none · + ADD` (`ok.empty_line`) — never a header bar over an empty box, never narration ("No X defined" is banned).

**Structure and register are separate layers.** Structure — panels, header bars, column-headed tables, full-width grids — is the app's shared grammar and may not be deleted by a register pass. Register — row pitch, accent budget, voice, contrast ladder — is where density lives. Data renders in tables: detail rows (`ok.detail_row`) for facts, headed `data-table`s for collections; a register amendment tightens a table's pitch, it does not dissolve the table. The parts list and part page are the reference implementations.

**Voice rules.** Spec prose is rationale for the implementer, never interface copy. (1) No interface copy that explains the interface — absent features are not apologized for. (2) Consequence sentences live only in confirmation dialogs and errors; each such sentence has exactly one home. (3) Labels are nouns, values are facts — no clauses, no narration. (4) Nothing hides behind disclosure: meta fields render always, as detail-row tables; absence is a muted dash, never an omitted row. (5) Width is an information budget — max-width the content or fill the viewport with columns of data, never one stretched sparse column. (6) Context pre-fill: the form never asks what the invoking context already knows. (7) Database ids never render in lists, headers, or titles.

**Register rules.** (1) No emoji or pictographs — state words in state colors carry state. Arrows (→ ←), box-drawing rules (──), and geometric chevrons are typography and stay. (2) State badges only where the state is exceptional or actionable — a state badge on every row is information about nothing. (3) Accent color = identifier + action, never content. (4) Consequence renders where it lands, not where it's filed — a column earns its place by the question the page answers.

## Linting (Ruff)

Configured in `pyproject.toml`: line-length 100, target Python 3.11+, rules E/F/I/UP/B/SIM. Type hints required everywhere.
