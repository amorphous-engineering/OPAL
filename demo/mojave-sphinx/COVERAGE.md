# What the dataset shows

Where each OPAL feature appears once the dataset is loaded, and what is not shown yet. Record
keys are the ones in `story.yaml`; the loader prints the number OPAL gives each.

## Shown

| Area | Feature | Where |
|---|---|---|
| Organization | Tiers, part numbering, roles, gates, workcenters, suppliers, one project | `org.yaml` |
| Parts | Bought and made parts, units other than each, tooling, categories | `parts.yaml`: 173 parts |
| Parts | Supplier catalog numbers and prices | every bought part with a supplier |
| Parts | Bills of material, several levels deep | each build's product, down from `mojave-sphinx` |
| Parts | Serialized products with genealogy | every work order's product and what it consumed |
| Purchasing | Orders placed, received in full, received in part, still open | `po-mcmaster-aft` (two receipts), `po-sendcutsend-second` (one line still to come) |
| Stock | Receipts by lot, made lots, consumption, tooling use | every `receive`, `make` and `build` event |
| Procedures | Build procedures with kits, outputs, pictures, cautions and data fields | `procedures/01` to `24` |
| Procedures | Operating procedures with roles, sign-offs, warnings, contingency operations and short steps | `33-launch-operations`, `31-vehicle-preparation`, `32-gse-setup`, `25-gse-transmitter-setup`, `34-inspections-after-firing` |
| Procedures | Role marks on steps (who does the step; gates nothing) | `33-launch-operations` OP 6 Load and Go: Launch Operator (LO), Launch Director (LD); project roles of SPX, set in `org.yaml` |
| Procedures | Dependencies between operations | `23-gse-system`, `32-gse-setup` |
| Procedures | Published and unpublished | all published by the end of the story |
| Work orders | Completed, with notes and recorded values | `wo-tank-casing`, `wo-tank-assembly` |
| Work orders | A value out of range, a non-conformance that holds the step, scrap disposition, work resumed, issue closed | `wo-oxidizer-bulkhead`, `nc-short-tube` |
| Work orders | In work, held by an open non-conformance | `wo-tank-assembly-2`, `nc-piston-deep` |
| Work orders | Held, reworked and finished | `wo-propulsion`, `nc-captured-nut` |
| Work orders | An operating work order on an existing unit: the vehicle and ground equipment named in slots, parts recorded as going into the vehicle and coming out of it | `wo-vehicle-prep`, `wo-vehicle-prep-2` and `-3` (old O-rings removed), `wo-launch-1` to `-3` |
| Work orders | A launch run to the end, with a second sign-off and an operation sign-off | `wo-launch-2` |
| Work orders | Contingency operations worked; a started work order closed short, citing its issue | `wo-launch-1`: C901, C902, C904, then closed short on `an-no-ignition` |
| Work orders | Open issues due at different points of one work order: blocking now, by a step, by the end of an operation, by the end of the work order, and holding nothing | `wo-launch-3`: `an-controllers-unchecked`, `task-range-brief`, `nc-rail-guide`, `an-camera-footage`, `improve-camera-battery` |
| Work orders | An inspection run after a flight, held and released on the day | `wo-inspect-1`, `nc-fin-fasteners` |
| Work orders | The same procedure run several times | four valves, four fin brackets |
| Issues | Non-conformance, anomaly, task, improvement; comments; a link to a part; assignee | 20 issues: `nc-*`, `an-*`, `task-*`, `improve-*` |
| Issues | Dispositions: scrap, rework, use as is; an anomaly that holds a work order; tickets in work, in review and closed | `nc-short-tube`, `nc-piston-stuck`, `nc-nose-tip`, `an-no-ignition`, `task-flange-plates`, `task-ground-test` |
| Risks | Open for research with a linked issue; accepted with a rationale; watched, then realized as an issue; mitigated by a linked task | `risk-closure-margin`, `risk-unrated-fittings`, `risk-oring-swell` (realized as `nc-piston-stuck`), `risk-main-binding` |
| Requirements | A tree, quoted statements, verification methods, allocation to parts | `requirements.yaml`: 24 requirements |
| Requirements | Baseline in one batch; drafts held back by lint or by an open question (TBR) | `closure-margin`, `valve-coupling`, `recovery-anchor` stay in draft |
| Requirements | Evidence on an open allocation; verified allocations | `evidence` and `verify` events |
| Requirements | A requirement written during the story, then revised after a failure; a requirement added as corrective action and verified by a test | `fuel-contact` (two revisions), `ejection-test` |
| Datasets | Reference data with a chart; points tied to work order steps | `datasets.yaml` |

## Not shown yet

| Feature | Why not |
|---|---|
| Redlines on a running work order, skipped steps, a voided work order | Not in the story. |
| A second version of a procedure | No procedure has been revised. The dataset does not add steps the guidebook lacks. |
| A cancelled or reaffirmed requirement; a stale baseline | Not in the story. |
| A risk review stamp; risk references | Not in the story. |
| A team dataset of its own launches | The two launches are on their work orders only. The launch dataset is Half Cat's history, for reference. |
| Stock transfers, adjustments, test results, calibration and expiry dates | Nothing in the guidebook calls for them. |
| Part revisions | No part has changed. |
| Attachments on work orders, issues and parts | Only step pictures are loaded. |
| Labels, notifications, API tokens, plugins | Outside the dataset. |
| Firings or flights counted per serial | OPAL has no such count, so the replacement schedule (Table 2.9) has nowhere to live. |
