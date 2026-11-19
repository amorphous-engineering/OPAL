/**
 * Unit slots: the existing units an operation names when it runs (a launch names its rocket and
 * ground equipment). Declared on OPs, keyed procedure-wide so a step kit line can install into
 * one. A build makes its unit and declares none.
 */
import { type ProcedureSnapshot, type UnitSlot, conflict, notFound } from '@opal/shared';
import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { part } from '../../db/schema/index.ts';
import { stepRows } from './draft.ts';
import { invalid } from './steps.ts';

/** Check a step's new slots: an OP, keys unique in the procedure, serialized parts. */
export function checkUnits(db: Db, procedureId: number, step: { id: number; parentStepId: number | null }, units: UnitSlot[]): UnitSlot[] | null {
	if (!units.length) return null;
	if (step.parentStepId !== null) throw invalid('units_on_op', 'Units are named on an OP, not on a sub-step', { units: 'OPs only' });
	const taken = new Set(
		stepRows(db, procedureId)
			.filter((s) => s.id !== step.id)
			.flatMap((s) => (s.units ?? []).map((u) => u.key))
	);
	const seen = new Set<string>();
	for (const u of units) {
		if (seen.has(u.key) || taken.has(u.key)) {
			throw invalid('duplicate_slot', `Slot key '${u.key}' is already used in this procedure`, { units: `duplicate key ${u.key}` });
		}
		seen.add(u.key);
	}
	const ids = [...new Set(units.map((u) => u.partId))];
	const parts = new Map(db.select().from(part).where(inArray(part.id, ids)).all().map((p) => [p.id, p]));
	for (const u of units) {
		const p = parts.get(u.partId);
		if (!p) throw notFound(`Part ${u.partId}`);
		if (p.trackingType !== 'serialized') {
			throw invalid('slot_not_serialized', `${p.internalPn} is not serialized: a slot names one unit`, { units: `${u.label}: not serialized` });
		}
	}
	return units.map((u) => ({ key: u.key, label: u.label, partId: u.partId, required: u.required }));
}

/** Every slot key the draft declares. */
export function slotKeys(db: Db, procedureId: number): Set<string> {
	return new Set(stepRows(db, procedureId).flatMap((s) => (s.units ?? []).map((u) => u.key)));
}

/** A kit line may install into a declared slot, and only when it consumes. */
export function checkInto(db: Db, procedureId: number, into: string | null, usage: 'consume' | 'tooling'): string | null {
	if (into === null) return null;
	if (usage !== 'consume') throw invalid('into_tooling', 'Tooling is returned; only consumed material is installed', { into: 'consume lines only' });
	if (!slotKeys(db, procedureId).has(into)) throw invalid('unknown_slot', `No unit slot '${into}' in this procedure`, { into: 'unknown slot' });
	return into;
}

/**
 * What publishing refuses: slots on a build, a line installing into a slot that is gone, and a
 * part that is both a unit slot and a tooling line (one unit, recorded one way).
 */
export function checkSnapshotUnits(snap: ProcedureSnapshot): void {
	const slots = snap.steps.flatMap((s) => s.units ?? []);
	if (snap.procedure.procedureType === 'build' && slots.length) {
		throw conflict('build_units', 'A build makes its unit; it does not name existing ones. Remove the unit slots or make it an OP');
	}
	const keys = new Set(slots.map((u) => u.key));
	for (const s of snap.steps) {
		for (const k of s.kit) {
			if (k.into !== undefined && !keys.has(k.into)) {
				throw conflict('unknown_slot', `Step ${s.number} installs into '${k.into}', which no OP declares`);
			}
		}
	}
	const slotParts = new Set(slots.map((u) => u.partId));
	for (const s of snap.steps) {
		for (const k of s.kit) {
			if (k.usage === 'tooling' && slotParts.has(k.partId)) {
				throw conflict('slot_and_tooling', `Step ${s.number} lists a unit-slot part as tooling: name it in the slot only`);
			}
		}
	}
}
