# Records

What each record offers in each state. `CLAUDE.md` has the rules. This table applies them. When a record gains a state or an action, change this file in the same commit.

"Primary" is the one prominent action, shown only to someone who can use it. When the next step is blocked, it shows inert with the reason. "EDIT" lists what is still pencil. "MORE" holds exceptional acts. Anything not listed is absent, and the server refuses it.

A reason is required where this file says so. Elsewhere it is optional, and nobody is forced to fill it in.

## Attachments

A file follows the pencil of its record. Removing a file, or changing its kind or note, is open while the record is pencil and refused afterwards. There is no strike for a file: a wrong one gets a note beside it.

| Record | Files can change | New files |
|---|---|---|
| Purchase order | Draft | Every state |
| Issue | Pending, and In work for a file added after the signature | Every state except Void |
| Requirement | Draft, Preliminary | Draft, Preliminary, Baselined |
| Risk | Open, if never accepted or realized | Open, Accepted |
| Stock record | Never | Every state |
| Procedure template | Draft, Released | Draft, Released |
| Execution, step, note | See Execution | See Execution |

## Purchase order

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Draft | Is this ready to send? | PLACE ORDER | | Everything: supplier, reference, dates, destination, notes, lines | DISCARD (deletes, because nothing refers to a draft) |
| Ordered | What is coming and when? | RECEIVE (blank receive rows on the page) | Add note, attachment, charge | Supplier reference, promised date, destination | AMEND LINE, ADD LINE, CANCEL LINE, PUT ON HOLD, CANCEL ORDER |
| Partial | What is still outstanding? | RECEIVE | Add note, attachment, charge | Supplier reference, promised date, destination | AMEND LINE, ADD LINE, CANCEL LINE (outstanding quantity only), PUT ON HOLD, CLOSE SHORT |
| On hold | Why is it held, and is it still coming? | RESUME | Add note, attachment | | CANCEL ORDER or CLOSE SHORT |
| Received | What did we get and what did it cost? | | Add note, attachment, charge | | COPY TO NEW DRAFT |
| Closed short, Cancelled | What happened to it? | | Add note, attachment, charge if anything arrived | | COPY TO NEW DRAFT |

- AMEND LINE and CANCEL LINE keep the old value on the line, struck through, with the new value, who, when and why. A reason is required.
- The supplier never changes after placing. Cancel and copy to a new draft.
- An order never returns to draft after placing. Its placing date never clears.
- Cancelling every open line does not make an order Received. It closes short, or cancels if nothing arrived.
- Header changes after placing show old and new in History on the page.

## Issue

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Pending, holding work | What is wrong, what is held, what do we do? | DISPOSITION (needs `issue.disposition`) | Add comment, attachment | Title, description, should be, is, type, priority, assignee, links, widen containment | NARROW CONTAINMENT (needs `issue.disposition`, note required), VOID (needs `issue.disposition`, reason required) |
| Pending, advisory | What is it, and who has it? | START WORK | Add comment, attachment | As above | VOID (reason required) |
| In work | What is being done? | SUBMIT FOR REVIEW | Add comment, attachment | Root cause, corrective action, priority, assignee | VOID, while no disposition is signed |
| In review | Is this finished? | SIGN OFF (needs `issue.approve`) | RETURN (reason required), add comment, attachment | | |
| Done | What happened, and who signed? | | Add comment, attachment | | REOPEN (needs `issue.approve`, reason required) |
| Void | Why was this struck? | | Add comment | | |

- Raising needs only a title. Everything else can be filled in later, and an issue raised from a step carries its run, step and person.
- A signed disposition freezes the observation and the disposition. A signed or done issue cannot be voided.
- Moving the boundary of a hold off an unfinished step releases that step, so it takes what narrowing takes. Setting a first boundary adds a hold and stays open.
- A void issue shows its title struck through and its reason at the top. It has no controls except a comment.
- Disposition fields sit behind EDIT until someone opens them. View mode shows a draft as facts.

## Execution (work order)

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Cut | What do I do first? | COMPLETE or SIGN OFF on the current step | Clock in, add note | Project, priority, dates | VOID (reason required) |
| In work | Where are we, and what is next? | COMPLETE or SIGN OFF on the current step | Clock in or out, note, + ISSUE (new tab), + REDLINE, SKIP (reason required) | Project, priority, dates | CLOSE SHORT (needs `execution.closeShort`, reason and linked issue required) |
| In work, held | What is stopping us? | The issue that holds the step | Note, + ISSUE, comment | Project, priority, dates | CLOSE SHORT |
| Completed | What was done, by whom? | REPORT | Add note, comment | | |
| Void, Closed short | Why did it stop, and where? | REPORT | Add comment | | |

- A step with no declared sign-off has one action: COMPLETE. No dialog, no signature row. The row then shows the title struck through with initials and time.
- A step with declared sign-offs shows a slot for each. Pressing SIGN OFF is the attestation, with no dialog. Two slots need two different people.
- Only the current step of the current operation is open by default. Others are one click away. SKIP and + ISSUE appear on the open step.
- SKIP on a step with required data or a declared sign-off needs `execution.skipRequired`, or every role its slots name. Once the work is done and waits on sign-off, or a slot is signed, SKIP is gone: sign it, or close the work order short.
- Completed steps never reopen. A correction is a note or a redline.
- Capture fields are editable while a step is workable and read-only afterwards.
- Every quantity on the material tab shows its unit. Source is a search over stock of that part with stock on hand, defaulting to the oldest.

## Procedure template

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Draft, never published | What does this say so far? | EDIT, then PUBLISH inside edit mode | | Everything | DELETE |
| Released | What is the current released procedure? | START EXECUTION | Print, compare versions | EDIT DRAFT opens the draft with a visible DRAFT banner. PUBLISH lives there | OBSOLETE (reason required), CLONE |
| Obsolete | What was this, and why is it retired? | | Print, compare versions | | REINSTATE (reason required), CLONE |
| Version | What exactly did this version say? | START EXECUTION if current | Print, compare | | RESTORE TO DRAFT |

- Opening a template never opens an editor. Row tools (move, duplicate, delete) exist only in edit mode.
- Publishing an obsolete template is refused. Reinstating is a separate, deliberate act.
- Delete is offered only while no version exists.

## Requirement

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Draft, Preliminary | Is this ready to baseline? | BASELINE, inert with the reason until ready | Lint results, flow-down | All fields, parent, allocations | DELETE (if unreferenced), CANCEL (reason required) |
| Baselined | What is required, and is it verified? | REVISE | Record verification per allocation, which adds an entry with who and when | | CANCEL (reason required) |
| Superseded, Cancelled | What replaced this, or why was it dropped? | Link to the current revision | | | |

- A requirement with a baselined revision stays in its project, including through a draft of its next revision.
- A verification stays until someone takes it back with WITHDRAW VERIFICATION (a person, reason required). The allocation shows who verified, who withdrew, when and why.
- A verified allocation cannot be removed, nor can one with a withdrawn verification. Mark it not applicable.

## Risk

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Open | What could go wrong, and what are we doing? | MARK REVIEWED | Link issues, add references | All fields, including score and disposition | ACCEPT (rationale required), CLOSE (reason required), DELETE if never accepted or realized |
| Accepted | Who accepted what, and is that still true? | MARK REVIEWED | Link issues, add references | Owner, narrative | WITHDRAW ACCEPTANCE (reason required, human only), CLOSE (reason required, human only) |
| Realized | What did we forecast, and what happened? | Link to the issue | + NEW RISK for residual exposure | | CORRECT RECORD (reason required, logged) |
| Closed | Why did this close? | | | | REOPEN (reason required, human only if it was ever accepted) |

- History on the page shows every change to score, disposition or statement: old, new, who, when, and the note if one was given.
- A score change never withdraws an acceptance as a side effect. Withdraw first, then change the score.
- Realizing a risk is a commit, so it takes a person. An agent may prepare it by linking the issue. Realizing an accepted risk also needs a reason.
- Reopening a closed risk that was accepted voids that acceptance, the same as withdrawing it. The stamps stay as the last acceptance, and accepting again is a new signature.
- Whether a realized risk should be editable at all is the owner's call, not a standard's. NASA and DoD guidance hands a realized risk to the issue process and is silent on editing. This table locks it by default and leaves a deliberate way out.

## Part

| State | The page answers | Primary | Also | EDIT | MORE |
|---|---|---|---|---|---|
| Draft | What is this, and can it activate? | ACTIVATE, inert with blockers until ready | Print label | Everything, including tier and number | DELETE (if unreferenced) |
| Active | What is it, where is it, what uses it? | | Print label, receive stock, order, variant | Description, category, reorder point, BOM | OBSOLETE (reason required) |
| Obsolete | What was this, and where was it used? | | Print label | | REINSTATE (reason required) |

- The part tag with QR stays at the top. Stock, procedure use and consumption all show on the part page.
- BOM changes on an active part are the one open question. See the sweep report.
- The unit of measure stops changing once stock or a purchase order line counts in it. A different unit is a new part.

## Stock record

| State | The page answers | Primary | Also | MORE |
|---|---|---|---|---|
| On hand | What is this, where, how many, and what happened to it? | | Label, count, adjust, move, record calibration (human only) | CORRECT lot, serial or expiry (reason required), SCRAP (reason required) |
| Empty | Where did it go? | | Label | |

- The ledger is append-only. Corrections show in the ledger with old and new values.
- A move keeps the lot of a record that has one. A record with no lot can take one on a move, which fills in a blank. Any other lot change is a CORRECT.

## Reference data

Supplier, workcenter, project, user, dataset definition. These are directory entries, not commitments. They open for reading, and EDIT reveals the fields. Delete sits under MORE and only appears when nothing refers to the entry. A data point captured in a dataset is struck with a reason, not deleted.
