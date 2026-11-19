# Mojave Sphinx demo dataset

Demo content for OPAL: a team building a Mojave Sphinx, the liquid bipropellant rocket designed
by Half Cat Rocketry.

## Source and credit

The parts, procedures, photos and design data in this folder are adapted from:

> *Mojave Sphinx Liquid Bipropellant Rocket: Build, Integration, and Launch Guidebook*, HCR-5100,
> Revision 01, 17 Aug 2024. Authored by Austin Sennott and Charles Sharp. Copyright 2024 Half Cat
> Rocketry. <https://halfcatrocketry.com>
>
> Photos taken by Half Cat Rocketry, Julian Rice, Thomas Booska, and Derek Honkawa.

Half Cat Rocketry designed, built, tested and flew this rocket and wrote the guidebook. The
engineering in this folder is theirs.

## This is not the guidebook

This is a modified version, made to show what OPAL does. **Do not build or operate a rocket from
it.** Get the current guidebook from Half Cat Rocketry and read its warning and disclaimer first.
Rockets are dangerous.

What was changed:

- The guidebook's procedures were entered as OPAL procedures, with parts lists, data fields and
  photos attached to steps. Wording was edited only where the record needed it, such as a unit or
  one name for a part. Each procedure file lists its changes under `changes_from_source`.
- The team, its people, dates, purchase orders, work orders and notes are fictional. They are not
  Half Cat Rocketry's records and describe no real build. Serial numbers here are OPAL stock
  serials, not serial numbers from Half Cat Rocketry's list of registered builds.
- A requirement says where it comes from. Statements quoted from the guidebook are marked as
  quotes. The rest were written for this demo.
- The adaptation was made with an AI model (Claude). The guidebook states that it was written by
  humans, not by AI. That statement is about the guidebook, not about this folder.
- Two datasets hold Half Cat Rocketry's own static fire and launch results, from the contents list
  of Section III. They are marked as theirs. Nothing else in the story is.

What was left out, because the guidebook gives it as prose, tables or drawings and not as steps:
static testing (Appendix A), transport (Appendix B), making the printed, laser-cut and machined
parts (Appendices C to E), and the replacement and spares tables of the maintenance schedule
(Section 2.7). The team's made parts are booked into stock without a procedure.

## Licence

GNU General Public License, version 3 or (at your option) any later version: the licence of the
guidebook, per its Appendix K. The text is in `LICENSE`. This folder is licensed separately from
the rest of OPAL, which is MIT.

Appendix K also says: "Any publication of designs, work, or derivative work originated by Half Cat
Rocketry, in part or in whole, must be attributed to Half Cat Rocketry. Furthermore, any
publication of such work must be made freely available under the GNU GPL version 3."

This content is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

## Layout

| Path | Holds |
|---|---|
| `org.yaml` | The organization, project, people, roles, workcenters and suppliers |
| `parts.yaml` | Parts, with the rule for which printed form of a part number is used |
| `procedures/` | One file per procedure, numbered in build order: 01-12 the vehicle, 21-25 the ground support equipment, 31-34 the operations |
| `photos/` | Step images, by guidebook OP or section |
| `requirements.yaml` | Requirements and the parts they are allocated to |
| `datasets.yaml` | Datasets: Half Cat Rocketry's development results as reference, and the team's measurements |
| `story.yaml` | What the team has done so far, in date order: orders, receipts, work orders, issues, risks, evidence |
| `KIT-ROLLUP.md` | Generated: what all the procedures draw for one vehicle and one ground system |
| `COVERAGE.md` | Which OPAL features the dataset shows, and which it does not |

A file refers to a part, person or procedure by its `key`, never by an OPAL number. The loader
(`server/scripts/load-demo.ts`, MIT) enters everything through OPAL's own operations, as the named
person, at the stated time.

A procedure is a `build` or an `op`. A build's work order produces a part: it draws its kit from
stock and ends with a serialized or lot-tracked item. An op's work order acts on hardware that
already exists: it has no product, and carries the roles, sign-offs, recorded data and
contingency paths of the operation.
