/** Parts CSV import: parse and check, then create draft parts row by row. */
import { OpalError, formatQty, parseQty, PROCUREMENT, TRACKING_TYPES } from '@opal/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { zImportPreview, zImportResult } from '@opal/shared';
import type { Ctx } from '../../context.ts';
import { part } from '../../db/schema/index.ts';
import { getProjectConfig } from '../org/project.ts';
import { createRow, type PartCreateInput } from './index.ts';

export const MAX_IMPORT_ROWS = 5000;

const ALIASES: Record<string, string> = {
	name: 'name',
	part_name: 'name',
	external_pn: 'externalPn',
	external_part_number: 'externalPn',
	part_number: 'externalPn',
	manufacturer_pn: 'externalPn',
	description: 'description',
	category: 'category',
	tier: 'tier',
	unit_of_measure: 'unitOfMeasure',
	unit: 'unitOfMeasure',
	uom: 'unitOfMeasure',
	tracking_type: 'trackingType',
	tracking: 'trackingType',
	procurement: 'procurement',
	reorder_point: 'reorderPoint'
};

/** Columns of this app's own export: ignored, not an error. */
const IGNORED = new Set([
	'id',
	'internal_pn',
	'internal_part_number',
	'total_quantity',
	'locations',
	'stock_qty',
	'created_at',
	'updated_at'
]);

const normalizeHeader = (h: string): string | null => {
	const key = h.trim().toLowerCase().replace(/\s+/g, '_');
	return IGNORED.has(key) ? null : (ALIASES[key] ?? null);
};

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
	const src = text.replace(/^﻿/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && src[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
		} else field += c;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

type Preview = z.output<typeof zImportPreview>;
type Result = z.output<typeof zImportResult>;

function existing(ctx: Ctx) {
	const rows = ctx.db.select({ name: part.name, externalPn: part.externalPn }).from(part).all();
	return {
		names: new Set(rows.map((r) => r.name.toLowerCase())),
		external: new Set(rows.flatMap((r) => (r.externalPn ? [r.externalPn.toLowerCase()] : [])))
	};
}

export function preview(ctx: Ctx, csv: string): Preview {
	const table = parseCsv(csv);
	const header = table.shift();
	if (!header) throw new OpalError(400, 'invalid_csv', 'CSV file has no headers');
	const columns = header.map(normalizeHeader);
	const headersFound = columns.filter((c): c is string => c !== null);
	if (!headersFound.includes('name')) throw new OpalError(400, 'invalid_csv', "CSV must have a 'Name' column");

	const have = existing(ctx);
	const config = getProjectConfig(ctx.db);
	const validTiers = config ? config.tiers.map((t) => t.level) : [1, 2, 3, 4, 5];
	const lowest = Math.min(...validTiers);

	const rows = table.slice(0, MAX_IMPORT_ROWS).map((cells, i): Preview['rows'][number] => {
		const d: Record<string, string> = {};
		columns.forEach((key, n) => {
			if (key) d[key] = (cells[n] ?? '').trim();
		});
		const errors: string[] = [];
		const warnings: string[] = [];
		const out: Preview['rows'][number] = {
			rowNumber: i + 1,
			name: d.name || null,
			externalPn: d.externalPn || null,
			tier: null,
			category: d.category || null,
			unitOfMeasure: d.unitOfMeasure || null,
			trackingType: d.trackingType?.toLowerCase() || null,
			procurement: d.procurement?.toLowerCase() || null,
			description: d.description || null,
			reorderPoint: null,
			errors,
			warnings,
			valid: true
		};
		if (d.tier) {
			if (/^\d+$/.test(d.tier)) out.tier = Number(d.tier);
			else errors.push(`Invalid tier: '${d.tier}'`);
		} else out.tier = lowest;
		if (d.reorderPoint) {
			try {
				const q = parseQty(d.reorderPoint);
				if (q < 0) errors.push(`Reorder point cannot be negative, got '${d.reorderPoint}'`);
				else out.reorderPoint = formatQty(q);
			} catch {
				errors.push(`Invalid reorder_point: '${d.reorderPoint}'`);
			}
		}
		if (!out.name) errors.push('Name is required');
		if (out.tier !== null && !validTiers.includes(out.tier)) {
			errors.push(`Tier must be one of ${[...validTiers].sort((a, b) => a - b).join(', ')}, got ${out.tier}`);
		}
		if (out.trackingType && !(TRACKING_TYPES as readonly string[]).includes(out.trackingType)) {
			errors.push(`Tracking type must be 'bulk' or 'serialized', got '${out.trackingType}'`);
		}
		if (out.procurement && !(PROCUREMENT as readonly string[]).includes(out.procurement)) {
			errors.push(`Procurement must be 'make', 'buy', or 'both', got '${out.procurement}'`);
		}
		if (out.name && have.names.has(out.name.toLowerCase())) warnings.push(`Part with name '${out.name}' already exists`);
		if (out.externalPn && have.external.has(out.externalPn.toLowerCase())) {
			warnings.push(`Part with external PN '${out.externalPn}' already exists`);
		}
		out.valid = errors.length === 0;
		return out;
	});
	return {
		totalRows: rows.length,
		validRows: rows.filter((r) => r.valid).length,
		errorRows: rows.filter((r) => !r.valid).length,
		warningRows: rows.filter((r) => r.warnings.length).length,
		rows,
		headersFound
	};
}

/** Create the rows. Each row has its own savepoint: a bad row never takes the batch down. */
export function importRows(ctx: Ctx, rows: PartCreateInput[], skipDuplicates: boolean): Result {
	const have = existing(ctx);
	let created = 0;
	let skipped = 0;
	let firstPn: string | null = null;
	let lastPn: string | null = null;
	const errors: string[] = [];
	rows.forEach((input, i) => {
		if (
			skipDuplicates &&
			(have.names.has(input.name.toLowerCase()) ||
				(input.externalPn && have.external.has(input.externalPn.toLowerCase())))
		) {
			skipped++;
			return;
		}
		ctx.db.run(sql`SAVEPOINT import_row`);
		try {
			const row = createRow(ctx, input);
			ctx.db.run(sql`RELEASE import_row`);
			have.names.add(input.name.toLowerCase());
			if (input.externalPn) have.external.add(input.externalPn.toLowerCase());
			created++;
			firstPn ??= row.internalPn;
			lastPn = row.internalPn;
		} catch (e) {
			ctx.db.run(sql`ROLLBACK TO import_row`);
			ctx.db.run(sql`RELEASE import_row`);
			errors.push(`Row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
		}
	});
	return { created, skipped, errors, firstPn, lastPn };
}
