# OPAL

Local-first system for hardware teams: parts, stock, purchasing, procedures and their
execution, issues, risks, requirements. One binary, one SQLite file, served on the local network.

The backend is TypeScript. `legacy/` holds the old Python backend as a reference for business
rules and as the source of the one-time import. It is frozen and is deleted at cutover. Do not
add features to it. Extensions and Onshape are postponed until the extension system is redesigned.

One instance is one organization. Risks, requirements, issues, procedures, executions and datasets
each belong to a required project. Parts, stock, purchasing, users and settings are
organization-wide.

## Layout

- `packages/shared` — zod schemas, enums, operation contracts, `Qty`, the typed client. The only home for API types.
- `server` — Bun + Hono. `src/db/schema/<area>.ts` (tables), `src/services` (business rules), `src/ops` (handlers bound to contracts), `src/auth`, `src/mcp`, `src/import` (legacy import), `src/supervisor`.
- `frontend` — SvelteKit SPA (Svelte 5 runes, shadcn-svelte, Tailwind 4). Builds to `frontend/build`, which the server embeds.
- `legacy` — the Python backend. Run it with `uv` from inside `legacy/`.

## Commands

```bash
pnpm install                       # all workspaces
pnpm --filter @opal/server dev     # API on :8080, data in notes/dev-data-ts, restarts on change
OPAL_DEV_SCHEMA=1 OPAL_DATA_DIR=$(mktemp -d) bun src/cli.ts serve   # in server/: fresh db from schema.ts, no migrations
pnpm --filter frontend dev         # Vite on :5173, proxies /api and /mcp
pnpm test                          # bun test in every package
pnpm check                         # tsc, svelte-check
pnpm --filter @opal/server test:ops     # fails when an operation has no test
pnpm --filter @opal/server db:generate   # migration from schema.ts changes; review the SQL
node frontend/scripts/check-screens.mjs <port> <dir> <user> <pass> <paths...>   # screenshots + errors per screen
pnpm build                         # client, then every binary into server/dist/
```

## How the backend works

1. An operation contract in `packages/shared/src/domains/<area>.ts` defines name, method, path, input, output, access and `mcp`.
2. `server/src/ops/<area>.ts` binds a handler to the contract with `implement()`.
3. `server/src/registry.ts` mounts every contract as `/api<path>` and runs it: input check, access check, a transaction for writes, output check.
4. `server/src/mcp` exposes every contract with `mcp: true` as an MCP tool, through the same `runOp`.
5. The client calls `api.<area>.<op>(input)`, typed from the same contract.

Handlers are thin. Business rules live in `server/src/services`.

## Rules

1. Every action is an operation contract. Do not add a route by hand.
2. Handlers and MCP tools never touch the database. Services do.
3. Services write only through `insert`, `update` and `remove` in `server/src/write.ts`. These write the audit row.
4. One fact, one home. A derived value is a query or a view, not a stored copy. If a change must touch two places, the design is wrong.
5. Quantities are `Qty`: integers scaled by 10,000 in the database, decimal strings on the wire. Never floats.
6. Timestamps are ISO 8601 UTC text with `Z`, from `now()` in shared.
7. A record that other records reference is never deleted. It moves to a terminal state. Only unreferenced drafts are hard-deleted.
8. Published procedure versions never change and never reference mutable data.
9. Part numbers and OPAL numbers are never reused. Tables use `AUTOINCREMENT`.
10. Schema changes go in `src/db/schema/<area>.ts`, then `db:generate`. Read the generated SQL before you commit it.
11. No SQL built from strings. Use Drizzle or its `sql` template.
12. No request header gives identity. Identity comes from the session cookie or a bearer API token. Token actors cannot do `humanOnly` operations.
13. Working docs, audits and scratch notes go in `notes/` (gitignored). The repo is public.

## Tests

- Never run the server against the default data folder. It holds the user's real database. Set `OPAL_DATA_DIR` to a temp folder.
- `bun test`. Each test opens `openDb(':memory:')` and calls the app with `app.request()`. No server process.
- Name tests after the business rule they check.
- `legacy/tests` is the list of rules to port. It does not test the new server.
- Every operation needs at least one HTTP-level test (`test:ops` checks it).
- Real data for screen checks: copy `notes/fixtures/legacy-seed.db` (local) or `server/assets/demo-seed.db` into a temp `OPAL_DATA_DIR` as `opal.db`. The first start imports it. Sign in as `build` / `kestrel-demo`.

## UI

- Dense and explicit. Data in tables: detail rows for facts, headed tables for collections. Mono for IDs, numbers and timestamps.
- Small radii, no shadows or gradients. State colours: ok, warn, error, info. No emoji.
- Labels are nouns. No copy that explains the interface. Consequence text only in confirmations and errors.
- Absolute timestamps. Dense rows may show a relative age with the full time in the tooltip.
- Never show database IDs.
- An empty section that applies shows its header and one line that says it is empty. A section that does not apply is absent.
- Do not hide fields behind toggles. Tabs may split a large page.
- `frontend/src/lib/components/ui/` is vendored shadcn-svelte. Do not edit or reformat it.
- Client imports use subpath aliases with extensions: `#lib/api.js`.
- Render authored markdown only through `markdown()` in `#lib/markdown.js`.

## Style

- TypeScript strict. Prettier and ESLint as configured in `frontend/`.
- Comments say why, not what. Match the comment density of the file you edit.
