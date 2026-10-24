/**
 * inventory_record, inventory_consumption, inventory_production, stock_transfer,
 * assembly_component, test_template, stock_test_result.
 *
 * A stock record keeps its id and OPAL number. Its quantity becomes a ledger of stock_move
 * rows built from the old movement rows. Where the old quantity and the ledger sum differ, one
 * more move closes the gap (see the rules below).
 */
import { ADJUST_REASONS, STOCK_SOURCES, STOCK_TEST_RESULTS, STOCK_TEST_TYPES } from '@opal/shared';
import { stockMove, stockRecord, stockTestResult, testTemplate } from '../db/schema/index.ts';
import {
	type ImportCtx,
	type Row,
	bool,
	dateOnly,
	derived,
	fail,
	insertRows,
	keep,
	keepLegacyRow,
	legacyQty,
	oneOf,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

interface Move {
	/** Order key among moves of equal time: receives and produces first. */
	rank: number;
	seq: number;
	stockId: number;
	kind: 'receive' | 'consume' | 'produce' | 'adjust' | 'count' | 'transfer';
	qty: number;
	reason: string | null;
	notes: string | null;
	actor: number | null;
	at: string;
	fromLocation?: string | null;
	toLocation?: string | null;
	fromLot?: string | null;
	toLot?: string | null;
	counterpart?: number;
	purchaseLineId?: number | null;
	intoStockId?: number | null;
	/** A reference to the row it came from, for the report and for the execution links. */
	origin?: string;
}

const RANK = { receive: 0, produce: 1, transfer: 2, adjust: 3, count: 3, consume: 4 } as const;
const PREFIX = /^\[([a-z_]+)\]\s*(.*)$/s;

/** '[damage] dropped' to ['damage', 'dropped']. */
function splitReason(note: unknown): [string | null, string | null] {
	const n = str(note);
	if (!n) return [null, null];
	const m = PREFIX.exec(n);
	return m ? [m[1]!, m[2]!.trim() || null] : [null, n];
}

export interface InventoryLinks {
	/** Legacy consumption id to the stock_move id it became. */
	consumptionMove: Map<number, number>;
	/** Legacy production id to its produce move id. */
	productionMove: Map<number, number>;
}

export function importInventory(c: ImportCtx): InventoryLinks {
	const records = readTable(c, 'inventory_record', ['id', 'part_id', 'quantity', 'location', 'lot_number', 'last_counted_at', 'expiration_date', 'last_calibrated_at', 'calibration_due_at', 'opal_number', 'alias', 'source_type', 'source_purchase_line_id', 'source_production_id', 'created_at', 'updated_at']);
	const consumptions = readTable(c, 'inventory_consumption', ['id', 'inventory_record_id', 'quantity', 'consumption_type', 'usage_type', 'notes', 'consumed_by_id', 'created_at', 'procedure_instance_id', 'step_execution_id']);
	const productions = readTable(c, 'inventory_production', ['id', 'inventory_record_id', 'quantity', 'procedure_instance_id', 'serial_number', 'status', 'notes', 'produced_by_id', 'created_at']);
	const transfers = readTable(c, 'stock_transfer', ['id', 'source_inventory_id', 'target_inventory_id', 'quantity', 'source_location', 'target_location', 'source_lot_number', 'target_lot_number', 'status', 'notes', 'transferred_by_id', 'transferred_at', 'created_at']);
	const components = readTable(c, 'assembly_component', ['id', 'production_id', 'consumption_id']);

	const tracking = new Map((c.src.query('SELECT id, tracking_type FROM part').all() as Row[]).map((p) => [Number(p.id), String(p.tracking_type)]));
	const productionById = new Map(productions.map((p) => [Number(p.id), p]));

	// ---- stock records
	let opalMax = 0;
	for (const r of records) opalMax = Math.max(opalMax, Number(/^OPAL-(\d+)$/.exec(String(r.opal_number ?? ''))?.[1] ?? 0));
	const seen = new Set<string>();
	const recordRows: Record<string, unknown>[] = [];
	const lineIds = c.ids.purchase_line ?? new Set<number>();
	for (const r of records) {
		const id = Number(r.id);
		if (!c.ids.part!.has(Number(r.part_id))) {
			fail(c, 'inventory_record', id, `part ${Number(r.part_id)} is not imported`);
			continue;
		}
		let opal = str(r.opal_number);
		if (!opal || seen.has(opal)) {
			opal = `OPAL-${String(++opalMax).padStart(5, '0')}`;
			warn(c, `inventory_record ${id}: OPAL number ${str(r.opal_number) ?? 'missing'} unusable, given ${opal}`);
		}
		seen.add(opal);
		const production = r.source_production_id ? productionById.get(Number(r.source_production_id)) : undefined;
		let lot = str(r.lot_number);
		let serial: string | null = null;
		if (tracking.get(Number(r.part_id)) === 'serialized') {
			if (production?.serial_number) serial = String(production.serial_number);
			else if (lot) {
				serial = lot;
				lot = null;
			}
		}
		const declared = r.source_type ? String(r.source_type).toLowerCase() : null;
		const sourceType = declared && (STOCK_SOURCES as readonly string[]).includes(declared)
			? (declared as (typeof STOCK_SOURCES)[number])
			: r.source_production_id ? 'production' : r.source_purchase_line_id ? 'purchase' : 'manual';
		recordRows.push({
			id,
			partId: Number(r.part_id),
			opalNumber: opal,
			location: String(r.location),
			lotNumber: lot,
			serialNumber: serial,
			alias: str(r.alias),
			sourceType,
			expirationDate: dateOnly(r.expiration_date),
			lastCalibratedAt: ts(r.last_calibrated_at),
			calibrationDueAt: ts(r.calibration_due_at),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		});
	}
	track(c, 'stock_record', insertRows(c, 'inventory_record', stockRecord, recordRows));
	const byId = new Map(records.map((r) => [Number(r.id), r]));
	const recordType = new Map(recordRows.map((r) => [r.id as number, r.sourceType as string]));

	// ---- moves
	const moves: Move[] = [];
	let seq = 0;
	const add = (m: Omit<Move, 'rank' | 'seq'>) => {
		moves.push({ ...m, rank: RANK[m.kind], seq: seq++ });
		return seq - 1;
	};
	const live = (id: unknown) => c.ids.stock_record!.has(Number(id));

	for (const r of consumptions) {
		const id = Number(r.id);
		if (!live(r.inventory_record_id)) {
			fail(c, 'inventory_consumption', id, `stock record ${Number(r.inventory_record_id)} is not imported`);
			continue;
		}
		const q = legacyQty(r.quantity) ?? 0;
		const base = { stockId: Number(r.inventory_record_id), actor: ref(c, 'user', r.consumed_by_id, `inventory_consumption ${id} consumed_by_id`), at: tsReq(r.created_at), origin: `consumption:${id}` };
		if (String(r.usage_type) === 'tooling') {
			add({ ...base, kind: 'consume', qty: 0, reason: 'tooling', notes: str(r.notes) });
			continue;
		}
		const type = String(r.consumption_type);
		if (type === 'scrap' || type === 'adjustment') {
			const [reason, notes] = splitReason(r.notes);
			if (reason === 'cycle_count') add({ ...base, kind: 'count', qty: -q, reason: 'cycle_count', notes });
			else {
				const valid = reason && (ADJUST_REASONS as readonly string[]).includes(reason) ? reason : type === 'scrap' ? 'scrap' : 'correction';
				add({ ...base, kind: 'adjust', qty: -q, reason: valid, notes: reason && valid !== reason ? str(r.notes) : notes });
			}
			continue;
		}
		add({ ...base, kind: 'consume', qty: -q, reason: null, notes: str(r.notes) });
	}

	for (const p of productions) {
		const id = Number(p.id);
		if (!live(p.inventory_record_id)) {
			fail(c, 'inventory_production', id, `stock record ${Number(p.inventory_record_id)} is not imported`);
			continue;
		}
		const q = legacyQty(p.quantity) ?? 0;
		const base = { stockId: Number(p.inventory_record_id), actor: ref(c, 'user', p.produced_by_id, `inventory_production ${id} produced_by_id`), at: tsReq(p.created_at), origin: `production:${id}` };
		if (!p.procedure_instance_id) {
			const [reason, notes] = splitReason(p.notes);
			if (q <= 0) {
				warn(c, `inventory_production ${id}: quantity ${String(p.quantity)} makes no move`);
				continue;
			}
			if (reason === 'cycle_count') add({ ...base, kind: 'count', qty: q, reason: 'cycle_count', notes });
			else {
				const valid = reason && (ADJUST_REASONS as readonly string[]).includes(reason) ? reason : 'found';
				add({ ...base, kind: 'adjust', qty: q, reason: valid, notes: reason && valid !== reason ? str(p.notes) : notes });
			}
		} else if (String(p.status) === 'completed') {
			if (q <= 0) {
				warn(c, `inventory_production ${id}: quantity ${String(p.quantity)} makes no move`);
				continue;
			}
			add({ ...base, kind: 'produce', qty: q, reason: null, notes: str(p.notes) });
		}
	}

	for (const t of transfers) {
		const id = Number(t.id);
		if (String(t.status) !== 'completed') {
			keepLegacyRow(c, 'stock_transfer', t, `status ${String(t.status)} moves no stock`);
			continue;
		}
		const q = legacyQty(t.quantity) ?? 0;
		const source = live(t.source_inventory_id) ? Number(t.source_inventory_id) : null;
		const target = live(t.target_inventory_id) ? Number(t.target_inventory_id) : null;
		if (!source && !target) {
			fail(c, 'stock_transfer', id, 'neither stock record is imported');
			continue;
		}
		const at = tsReq(t.transferred_at ?? t.created_at);
		const actor = ref(c, 'user', t.transferred_by_id, `stock_transfer ${id} transferred_by_id`);
		const common = { reason: null, notes: str(t.notes), actor, at, fromLocation: str(t.source_location), toLocation: str(t.target_location), fromLot: str(t.source_lot_number), toLot: str(t.target_lot_number), origin: `transfer:${id}` };
		if (source && (source === target || !target)) {
			if (!target) warn(c, `stock_transfer ${id}: target record is gone, only the source side is written`);
			add({ ...common, stockId: source, kind: 'transfer', qty: source === target ? 0 : -q });
		} else if (!source && target) {
			warn(c, `stock_transfer ${id}: source record is gone, only the target side is written`);
			add({ ...common, stockId: target, kind: 'transfer', qty: q });
		} else {
			const out = add({ ...common, stockId: source!, kind: 'transfer', qty: -q });
			const into = add({ ...common, stockId: target!, kind: 'transfer', qty: q, counterpart: out });
			moves[out]!.counterpart = into;
		}
	}

	// ---- component links: a consume move names the assembly it went into
	const consumeOrigin = new Map(moves.map((m) => [m.origin, m]));
	for (const ac of components) {
		const id = Number(ac.id);
		const prod = productionById.get(Number(ac.production_id));
		const move = consumeOrigin.get(`consumption:${Number(ac.consumption_id)}`);
		if (!prod || !move || move.kind !== 'consume' || !live(prod.inventory_record_id)) {
			fail(c, 'assembly_component', id, 'production or consume move is missing');
			continue;
		}
		move.intoStockId = Number(prod.inventory_record_id);
		c.report.tables.assembly_component!.imported++;
	}

	// ---- last count: a record keeps its last counted time as a count move
	const lastCount = new Map<number, string>();
	for (const m of moves) if (m.kind === 'count' && m.at > (lastCount.get(m.stockId) ?? '')) lastCount.set(m.stockId, m.at);
	for (const r of records) {
		if (r.last_counted_at && live(r.id) && (lastCount.get(Number(r.id)) ?? '') < tsReq(r.last_counted_at)) {
			add({ stockId: Number(r.id), kind: 'count', qty: 0, reason: 'cycle_count', notes: null, actor: null, at: tsReq(r.last_counted_at), origin: `count:${Number(r.id)}` });
		}
	}

	// ---- the gap between the old quantity and the ledger
	const sum = new Map<number, number>();
	for (const m of moves) sum.set(m.stockId, (sum.get(m.stockId) ?? 0) + m.qty);
	for (const r of recordRows) {
		const id = r.id as number;
		const old = byId.get(id)!;
		const want = legacyQty(old.quantity) ?? 0;
		const have = sum.get(id) ?? 0;
		const diff = want - have;
		if (diff === 0) continue;
		const at = r.createdAt as string;
		const source = recordType.get(id);
		const line = old.source_purchase_line_id && lineIds.has(Number(old.source_purchase_line_id)) ? Number(old.source_purchase_line_id) : null;
		if (diff > 0 && (source === 'purchase' || source === 'manual')) {
			add({ stockId: id, kind: 'receive', qty: diff, reason: null, notes: null, actor: null, at, purchaseLineId: source === 'purchase' ? line : null, origin: `receive:${id}` });
			derived(c, 'stock_move_receive_from_quantity', 1);
		} else {
			add({ stockId: id, kind: 'adjust', qty: diff, reason: 'import', notes: `Legacy quantity ${String(old.quantity)}, movements ${have / 10000}`, actor: null, at, origin: `import:${id}` });
			c.report.stockDifferences.push({
				stockId: id,
				opalNumber: r.opalNumber as string,
				partId: r.partId as number,
				legacyQuantity: want,
				ledgerSum: have,
				difference: diff,
				move: 'adjust import'
			});
		}
	}

	// ---- write, in time order, with explicit ids
	moves.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank || a.seq - b.seq));
	const idOfSeq = new Map(moves.map((m, i) => [m.seq, i + 1]));
	const links: InventoryLinks = { consumptionMove: new Map(), productionMove: new Map() };
	const rows = moves.map((m, i) => {
		const id = i + 1;
		const [type, legacy] = (m.origin ?? '').split(':');
		if (type === 'consumption') links.consumptionMove.set(Number(legacy), id);
		if (type === 'production') links.productionMove.set(Number(legacy), id);
		return {
			id,
			stockId: m.stockId,
			kind: m.kind,
			qty: m.qty,
			reason: m.reason,
			notes: m.notes,
			actorUserId: m.actor,
			at: m.at,
			fromLocation: m.fromLocation ?? null,
			toLocation: m.toLocation ?? null,
			fromLot: m.fromLot ?? null,
			toLot: m.toLot ?? null,
			counterpartId: m.counterpart === undefined ? null : idOfSeq.get(m.counterpart)!,
			intoStockId: m.intoStockId ?? null,
			purchaseLineId: m.purchaseLineId ?? null
		};
	});
	const written = new Set(insertRows(c, 'inventory_consumption', stockMove, rows, { count: false }));
	for (const [k, v] of [...links.consumptionMove]) if (!written.has(v)) links.consumptionMove.delete(k);
	for (const [k, v] of [...links.productionMove]) if (!written.has(v)) links.productionMove.delete(k);
	const failedIn = (t: string) => c.report.failedRows.filter((f) => f.table === t).length;
	c.report.tables.inventory_consumption!.imported = consumptions.length - failedIn('inventory_consumption');
	c.report.tables.inventory_production!.imported = productions.length - failedIn('inventory_production');
	c.report.tables.stock_transfer!.imported = transfers.filter((t) => String(t.status) === 'completed').length - failedIn('stock_transfer');
	derived(c, 'stock_move', written.size);
	track(c, 'stock_move', written);

	// ---- tests
	const templates = readTable(c, 'test_template', ['id', 'part_id', 'name', 'description', 'required', 'test_type', 'min_value', 'max_value', 'unit', 'sort_order', 'created_at', 'updated_at']);
	track(c, 'test_template', insertRows(c, 'test_template', testTemplate, keep(c, 'test_template', templates, (r) => (c.ids.part!.has(Number(r.part_id)) ? null : 'part is not imported'))
		.map((r) => ({
			id: Number(r.id),
			partId: Number(r.part_id),
			name: String(r.name),
			description: str(r.description),
			required: bool(r.required),
			testType: oneOf(c, r.test_type, STOCK_TEST_TYPES, 'boolean', `test_template ${Number(r.id)} test_type`),
			minValue: legacyQty(r.min_value),
			maxValue: legacyQty(r.max_value),
			unit: str(r.unit),
			sortOrder: Number(r.sort_order),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		}))));
	const results = readTable(c, 'stock_test_result', ['id', 'inventory_record_id', 'template_id', 'test_name', 'result', 'value', 'notes', 'tested_at', 'tested_by_id', 'created_at', 'updated_at']);
	insertRows(c, 'stock_test_result', stockTestResult, keep(c, 'stock_test_result', results, (r) => (live(r.inventory_record_id) ? null : 'stock record is not imported'))
		.map((r) => ({
			id: Number(r.id),
			stockId: Number(r.inventory_record_id),
			templateId: ref(c, 'test_template', r.template_id, `stock_test_result ${Number(r.id)} template_id`),
			testName: String(r.test_name),
			result: oneOf(c, r.result, STOCK_TEST_RESULTS, 'pending', `stock_test_result ${Number(r.id)} result`),
			value: str(r.value),
			notes: str(r.notes),
			testedAt: ts(r.tested_at),
			testedById: ref(c, 'user', r.tested_by_id, `stock_test_result ${Number(r.id)} tested_by_id`),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		})));
	return links;
}
