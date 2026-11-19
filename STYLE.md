# OPAL style guide

OPAL is read off a laptop in bad light by someone in the middle of work. The look is a printed form:
black ink on white paper, on a grey desk. Night is the same form reversed. Everything on screen has a
purpose, and a clean screen never costs the operator anything.

The look lives in Tailwind tokens in `frontend/src/routes/layout.css`, plus one short Marks block for
what a token cannot reach inside the vendored components. Everything else is a utility class at the
call site. No per-component CSS, no overrides outside the layers. `frontend/src/lib/components/ui/` is
vendored and stays as shipped.

## Type

- IBM Plex Sans for words, IBM Plex Mono for IDs, numbers, timestamps and state words.
- Nothing below 12px. Printed labels and the print traveler are the only exceptions.
- Authored sentences, such as a requirement statement, are sans. Mono is not emphasis.
- Step text is 14px by default, with 14, 16 and 18 as a per-browser setting.

## Marks

Each mark has one meaning.

| Mark | Meaning |
|---|---|
| Solid line | Section boundary |
| Dotted line | Row in a section |
| Dashed box | Not committed yet: a blank, a typed value, every section of a draft record |
| Hard 2px shadow, no blur | A key you can press, and the menu it opens. Never a panel |
| Black fill | You are here: the current nav item, step or tab, and the active choice of a toggle |
| Yellow edge, 4px, on an OP card | A contingency OP that someone has entered. Before that it is quiet: its number (C901, C902, in a series of its own) and the word CONTINGENCY |
| Hazard stripe | A person can be hurt. Only as a tab beside the WARNING word, whose black fill it sets apart from you-are-here |
| Role mark | The role that does a step: its letters (LD, LO) in a square filled with the role's colour, between the step number and the title. Outlined when the role no longer exists |

No rounded corners, gradients or emoji. The hazard stripe is a pattern, not a gradient.

## Importance sets contrast

Decide how much the reader needs a value right now, then give it that much contrast. The ladder runs
from most to least important.

| Level | Mark | Words |
|---|---|---|
| Stopped | Red fill. Red word in a dense column | HOLD, BLOCKED, OVERDUE, CRITICAL, REALIZED |
| Waiting on a person | Amber fill | AWAITING SIGN-OFF, CAUTION |
| In flight | Bold ink | IN WORK, IN REVIEW, PARTIAL, HIGH |
| Reached a good state | Green word | COMPLETED, RECEIVED, BASELINED, VERIFIED, DONE, PASS |
| At rest | Plain ink | ACTIVE, RELEASED, PLACED, OPEN, MEDIUM |
| Not started, still pencil | Tan word. DRAFT also gets the dashed box | CUT, PENDING, PRELIMINARY, DRAFT |
| Over, or empty | Quiet | VOID, CLOSED SHORT, OBSOLETE, LOW, a dash |

- Fills are for what someone must act on. A word is enough for where a record stands.
- Green goes on a state someone reached. A state a record merely sits in stays plain, so a list of 180
  active parts is not a wall of green.
- The word always carries the meaning. Colour adds to it and must survive being lost to glare.
- Secondary columns (project code, a date that is not the sort key, a dash) sit at quiet, so the column
  the page exists for stands out.
- No tints, because they are the first thing glare removes. The risk matrix is the one exception, because its
  bands are the information.
- Accent blue marks identifiers and links, never content.
- Role marks are the one use of colour that is not state. Their palette (purple, teal, brown, magenta,
  slate) stays clear of red, amber, green, blue and yellow, and the letters carry the role.

Every colour clears 4.5:1 on the background it sits on. Quiet stays at about 7:1 in day and night,
because it still has to be read.

## Connection

The left end of the status bar always shows one small fill:

| Fill | Meaning |
|---|---|
| Green ONLINE | The server answers and live updates are connected, and nothing has broken since the last check |
| Amber STALE | Anything short of a consistent connection |
| Red OFFLINE | No server, or the browser is offline, right now |

STALE latches. Even one short drop stays on the ticker with its times, because what is on screen may
have missed something. Pressing it reloads the page's data and clears it. A failed health check while
the server still answers also shows as STALE, with the reason beside it. A healthy connection stays
visible, because a missing indicator proves nothing.

## Keys and actions

Every action is a box. Blue text goes somewhere: a record number, a link to another page. It never
changes anything. Controls must look different from text (FAA HF-STD-001B, 8.13.1.2), and a blue
action reads like the record numbers beside it.

| Weight | Component | Used for |
|---|---|---|
| Primary key | `Button`, filled | The move the record is waiting on. One per page |
| Key | `Button` outline, 24px or 28px, 12px type | Page and structure actions: + OP, + STEP, DONE |
| Bank | `KeyBank` of `BankKey`s, one border and one shadow | Related small actions in a row or section: ADD, REMOVE, move |
| Quiet bank | `KeyBank quiet` | Row tools. Flat and grey until the row is hovered or holds the focus |

- An inert key is flat and readable, with no shadow and no half-faded blue.
- A red key appears only as the commit inside a confirmation.
- `ActionLink` is being retired: the template editor no longer uses it, and the other pages follow.
- Strikes (void, cancel, deactivate) go under MORE.

## Forms

- One box per form, titled with the record (Issue, Risk). A form with a table or a preview keeps its
  boxes side by side, and its keys still sit under them.
- `Field`: the label over its control, as a noun. Required fields carry a quiet `*`, never red.
- `FormKeys` ends every form: the error, then CANCEL and the one primary key, at the right. Under a
  create page's boxes; inside the box for an editor in a record's section.
- The primary key names the act: CREATE for pencil, the commit word where creating is the commit
  (RAISE, RECEIVE, CUT WORK ORDER). While it is inert it says what it needs: "Needs project and
  title".
- A placeholder never looks like a value. It may show a value the field inherits when left blank (a
  line's destination from its order). Hints are for the grammar of the record (a risk statement's
  parts), not for the interface.
- An empty choice is `—`, not "None" or "Select …".

## Pages

- Dense and explicit. Detail rows for facts, headed tables for collections.
- A record's state word sits at the right end of the breadcrumb bar: the same spot on every record
  page, whatever the title.
- Filters and search are solid, because they are not part of a record. Fields in a form are dashed.
- An empty section that applies shows its header and one line saying it is empty. A section that does
  not apply is absent.
- In edit mode an empty section is absent, the way a dark cockpit leaves a normal system unlit. What
  can be added is offered once, in an ADD bank. A reader still sees the empty line, because it
  says the section was looked at.
- Do not hide facts behind toggles. Tabs may split a large page. Editors stay behind EDIT.
- Absolute timestamps. Dense rows may show a relative age with the full time in the tooltip.
- Labels are nouns. No copy that explains the interface. Consequence text only in confirmations and
  errors.
- Never show database IDs.
- Render authored markdown only through `markdown()` in `#lib/markdown.js`.

What a record offers in each state is a separate matter: see Records in `CLAUDE.md` and `RECORDS.md`.
