# OPAL

Local-first system for hardware teams: parts, stock, purchasing, procedures and their
execution, issues, risks, requirements. One binary, one SQLite file, served on the local network.

The backend is TypeScript. The Python 1.x backend is gone from the tree (git history before the
cutover commit has it). `src/import` reads 1.x databases once. Extensions and Onshape are
postponed until the extension system is redesigned.

One instance is one organization. Risks, requirements, issues, procedures, executions and datasets
each belong to a required project. Parts, stock, purchasing, users and settings are
organization-wide.

## Layout

- `packages/shared` — zod schemas, enums, operation contracts, `Qty`, the typed client. The only home for API types.
- `server` — Bun + Hono. `src/db/schema/<area>.ts` (tables), `src/services` (business rules), `src/ops` (handlers bound to contracts), `src/auth`, `src/mcp`, `src/import` (legacy import), `src/supervisor`.
- `frontend` — SvelteKit SPA (Svelte 5 runes, shadcn-svelte, Tailwind 4). Builds to `frontend/build`, which the server embeds.

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
node frontend/scripts/check-records.mjs <port> <user> <pass>   # committed records open for reading (on an imported seed)
node frontend/scripts/check-markdown.mjs <port> <user> <pass>  # record text renders as formatting only (adds comments to the first issue)
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
14. Sequence numbers (part numbers, OPAL-, PO-, T-, WO-, IT-, RISK-, REQ-) follow the rules in the next section. Serials (`001`) do not.

## Sequence numbers

The database stores every sequence number with a fixed 10-digit sequence: `WO-0000000004`,
`SPX-F-0000000132`. People see the width the organization sets in `partNumbering.sequenceDigits`
(default 4): `WO-0004`. The width is display only. A change to the setting changes every number on
screen, in links, in exports and in MCP, and moves no stored row.

- Generate numbers with `nextDesignator` (`server/src/services/designators.ts`), `nextReference`
  (PO) or `nextPartNumber`. Never pad a number yourself.
- Services, SQL and stored JSON see only the 10-digit form.
- `runOp` converts at the API boundary (`server/src/numbers.ts`). Output: every string, error
  message and error field goes through `codec.display`. Input: the fields in `NUMBER_KEYS` go
  through `codec.canonical`, so `WO-4`, `WO-0004` and `WO-00004` name the same record. `q` goes
  through `codec.search`, which also finds a partial number.
- Text that leaves the server outside `runOp` (raw routes, SSE, files) must call
  `numbersFor(db).display()`. A number from a person in a field outside `NUMBER_KEYS` must go through
  `numbersFor(db).canonical()` in the service.
- The UI shows numbers as the API sends them and builds links from those values. It never pads,
  strips or parses a number.
- Tests through the API expect the display width. Tests that call a service or read the database
  expect the 10-digit form.
- Older databases and 1.x imports are converted once at startup (`server/src/db/full-width-numbers.ts`).

## Tests

- Never run the server against the default data folder. It holds the user's real database. Set `OPAL_DATA_DIR` to a temp folder.
- `bun test`. Each test opens `openDb(':memory:')` and calls the app with `app.request()`. No server process.
- Name tests after the business rule they check.
- Every operation needs at least one HTTP-level test (`test:ops` checks it).
- Real data for screen checks: copy `server/assets/demo-seed.db` (a 1.x demo database) into a temp `OPAL_DATA_DIR` as `opal.db`. The first start imports it. Sign in as `build` / `kestrel-demo`.

## Records

A record is a form. Before its commit moment it is pencil: edit it, delete it. After that it is pen.

**The paper test: if you could not do it to a paper form with a pen, without ripping up the page, the app does not offer it and the server refuses it.** Follow the spirit. The test keeps records honest. It is not a reason to add ceremony.

**What pen can do:** add (a note, attachment, charge, receipt, ledger row), fill in a blank left for later, correct (strike the old value and write the new one beside it, with who, when and why, and the old value stays on the page), stamp a state, sign, strike the whole form (void, cancel: a reason is required and the record stays legible), or file a new form (a revision, a copy).

**What pen cannot do:** overwrite without a trace, remove a line, go back to pencil, change who or when, or withdraw someone's signature as a side effect of another edit.

Commit moments: a purchase order is placed, an issue is raised (its observation), a disposition is signed, a procedure version is published, a work order is cut, a step is completed, a requirement is baselined, a risk is accepted or realized, stock is received. `RECORDS.md` lists what each record offers in each state.

Routing is not the record. Assignee and priority may change while a record is open, and the change is logged. Directory data (a supplier's address, a workcenter's name) is not a commitment. It still opens for reading.

### What a page presents

1. Decide what question the page answers in this state, for the person holding it. Show what that takes and no more. A fact appears once.
2. Pages open for reading. The only inputs on open are the blank this state is waiting on from this person: receive rows on a placed PO, capture fields and the notes box on the current step.
3. EDIT reveals what is still pencil. DONE returns. A record with nothing left in pencil has no EDIT.
4. One primary action: the move the record is waiting on. Everything else is quiet. Strikes go under MORE, never in red beside the title. Red marks errors and the consequence inside a confirmation.
5. Offer only what will work. A control the server would refuse is absent. The exception is the expected next step when it is blocked: show it inert, looking disabled, with the reason.
6. A reader sees that a value changed. Prior values show where the value is read, or in a History section on the page. The audit log alone is not enough. A terminal record looks terminal.

### Work on the floor

7. Routine work is implicit. Completing a step needs no signature and no dialog. The system stamps who and when, and the step row shows them with the title struck through.
8. A sign-off means something: a person attests to a stated act. Authors declare sign-offs on the steps that need them, and there are few. The default step has none. Two slots mean two different people.
9. No modals during work. Confirm only what is hard to reverse, and inline where possible. Raising an issue opens the issue form in a new tab, carries the run, step and person with it, and asks only for a title. The rest can come later.
10. Warnings stay short and sit with the step they govern, in the order warning, caution, note. They hold no action steps. Compact by default, because overuse trains people to skip them. Compact means no box, never smaller than the step's own text.
11. Every quantity shows its unit. A picker that can outgrow a screen is searchable, with a sensible default (oldest stock first).
12. Work does not abort. An operation exits through a contingency op or its own exit criteria. A work order nobody has started can be voided. A started one that truly cannot finish is closed short: gated, with a reason and a linked issue, and it stays legible.

### Authority

13. No side doors. An act with the same effect as a gated act needs the same gate. Anything that releases a hold needs the disposition gate: signing, voiding, narrowing containment.
14. Signatures and strikes are `humanOnly`. Agents prepare, people commit.
15. Undo is for pencil. It never reverses a commit, a stamp, a signature or a strike. Reopening accepted work voids its acceptance on the spot, so the sign-off has to happen again.
16. Trust the people using this. Do not explain the interface, ask "are you sure" for something reversible, or force a field that can be filled in later. Add a role check only where the act needs one.

## UI

`STYLE.md` is the style guide: type, marks, the importance ladder for state, keys and pages. Read it before changing anything on screen.

- `frontend/src/lib/components/ui/` is vendored shadcn-svelte. Do not edit or reformat it. `pnpm test` fails when the Marks block stops matching it.
- Client imports use subpath aliases with extensions: `#lib/api.js`.

## Style

- TypeScript strict. Prettier and ESLint as configured in `frontend/`.
- Comments say why, not what. Match the comment density of the file you edit.
