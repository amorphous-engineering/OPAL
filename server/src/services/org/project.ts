/**
 * The organization settings: tiers, part numbering scheme, categories. One instance is one
 * organization, so the settings are one JSON value in app_setting under `project_config`.
 *
 * The stored blob may come from the legacy import (snake_case keys). Reads accept both
 * spellings; writes store camelCase. Keys this module does not know (the Onshape block)
 * stay in the blob untouched.
 */
import { FALLBACK_SCHEME, numberCodec, type NumberCodec, OpalError, STORED_DIGITS, type PartNumbering, type OrgSettings, type Tier, type zOrgSettingsInput, notFound } from '@opal/shared';
import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { part } from '../../db/schema/index.ts';
import { getSetting, setSetting } from './settings.ts';

export const PROJECT_CONFIG_KEY = 'project_config';

const DEFAULT_NUMBERING: PartNumbering = {
	prefix: '',
	separator: '-',
	sequenceDigits: 4,
	format: '{prefix}{sep}{tier_code}{sep}{sequence}'
};

/** Semantics a tier gets when its blob predates the fields: the historical level rules. */
export function levelDefaults(level: number): Pick<Tier, 'defaultTracking' | 'requireLot' | 'autoSerial'> {
	return {
		defaultTracking: level <= 2 ? 'serialized' : 'bulk',
		requireLot: level === 1 || level === 2,
		autoSerial: level === 1
	};
}

type Raw = Record<string, unknown>;
const pick = <T>(o: Raw, camel: string, snake: string): T | undefined =>
	(o[camel] ?? o[snake]) as T | undefined;

function readTier(t: Raw): Tier {
	const level = Number(t.level);
	const d = levelDefaults(level);
	return {
		level,
		name: String(t.name ?? ''),
		code: String(t.code ?? ''),
		description: String(t.description ?? ''),
		defaultTracking: pick<Tier['defaultTracking']>(t, 'defaultTracking', 'default_tracking') ?? d.defaultTracking,
		requireLot: pick<boolean>(t, 'requireLot', 'require_lot') ?? d.requireLot,
		autoSerial: pick<boolean>(t, 'autoSerial', 'auto_serial') ?? d.autoSerial
	};
}

function readNumbering(n: Raw | undefined): PartNumbering {
	if (!n) return DEFAULT_NUMBERING;
	return {
		prefix: (n.prefix as string | undefined) ?? DEFAULT_NUMBERING.prefix,
		separator: (n.separator as string | undefined) ?? DEFAULT_NUMBERING.separator,
		sequenceDigits: pick<number>(n, 'sequenceDigits', 'sequence_digits') ?? DEFAULT_NUMBERING.sequenceDigits,
		format: (n.format as string | undefined) ?? DEFAULT_NUMBERING.format
	};
}

function parseBlob(raw: string | null): Raw | null {
	if (raw === null) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? (v as Raw) : null;
	} catch {
		return null;
	}
}

/** The raw stored blob, including keys this module does not own. */
export function readProjectBlob(db: Db): Raw | null {
	return parseBlob(getSetting(db, PROJECT_CONFIG_KEY));
}

/** The organization settings, or null before the organization is set up. */
export function getOrgSettings(db: Db): OrgSettings | null {
	const b = readProjectBlob(db);
	if (!b) return null;
	return {
		name: String(b.name ?? ''),
		description: String(b.description ?? ''),
		tiers: ((b.tiers as Raw[] | undefined) ?? []).map(readTier),
		partNumbering: readNumbering(pick<Raw>(b, 'partNumbering', 'part_numbering')),
		categories: (b.categories as string[] | undefined) ?? [],
		requirements: ((b.requirements as Raw[] | undefined) ?? []).map((r) => ({
			id: String(r.id ?? ''),
			title: String(r.title ?? ''),
			description: String(r.description ?? ''),
			category: String(r.category ?? '')
		})),
		customFields: pick<Record<string, unknown>>(b, 'customFields', 'custom_fields') ?? {}
	};
}

export function getTier(config: OrgSettings | null, level: number): Tier | undefined {
	return config?.tiers.find((t) => t.level === level);
}

/**
 * Render a part number from the scheme. Placeholders: {prefix} {sep} {tier_code}
 * {tier_name} {tier_level} {sequence}; the sequence is zero-padded, never cut.
 */
export function renderPartNumber(config: OrgSettings, tier: Tier, sequence: number): string {
	const n = config.partNumbering;
	const values: Record<string, string> = {
		prefix: n.prefix,
		sep: n.separator,
		tier_code: tier.code,
		tier_name: tier.name,
		tier_level: String(tier.level),
		// Stored at full width; the API shows it at `sequenceDigits`.
		sequence: String(sequence).padStart(STORED_DIGITS, '0')
	};
	return n.format.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/** Part number when no organization is set up: PN-{tier}-{sequence}. */
export function fallbackPartNumber(tierLevel: number, sequence: number): string {
	return `PN-${tierLevel}-${String(sequence).padStart(STORED_DIGITS, '0')}`;
}

const codecs = new WeakMap<Db, { raw: string | null; codec: NumberCodec }>();

/** The number codec for the current settings. Cached until the settings change. */
export function numbersFor(db: Db): NumberCodec {
	const raw = getSetting(db, PROJECT_CONFIG_KEY);
	const hit = codecs.get(db);
	if (hit && hit.raw === raw) return hit.codec;
	const config = getOrgSettings(db);
	const codec = config
		? numberCodec(config.partNumbering.sequenceDigits, {
				prefix: config.partNumbering.prefix,
				separator: config.partNumbering.separator,
				format: config.partNumbering.format,
				tiers: config.tiers
			})
		: numberCodec(DEFAULT_NUMBERING.sequenceDigits, FALLBACK_SCHEME);
	codecs.set(db, { raw, codec });
	return codec;
}

// ---------------------------------------------------------------- write side

type ConfigInput = z.output<typeof zOrgSettingsInput>;

function buildConfig(input: ConfigInput, existing: OrgSettings | null): OrgSettings {
	const prev = new Map((existing?.tiers ?? []).map((t) => [t.level, t]));
	return {
		name: input.name,
		description: input.description,
		tiers: input.tiers.map((t) => {
			const old = prev.get(t.level);
			const d = levelDefaults(t.level);
			return {
				level: t.level,
				name: t.name,
				code: t.code,
				description: t.description,
				defaultTracking: t.defaultTracking ?? old?.defaultTracking ?? d.defaultTracking,
				requireLot: t.requireLot ?? old?.requireLot ?? d.requireLot,
				autoSerial: t.autoSerial ?? old?.autoSerial ?? d.autoSerial
			};
		}),
		partNumbering: input.partNumbering,
		categories: [...new Set(input.categories.map((c) => c.trim()).filter(Boolean))],
		requirements: existing?.requirements ?? [],
		customFields: input.customFields ?? existing?.customFields ?? {}
	};
}

function save(ctx: Ctx, config: OrgSettings): void {
	// Keep keys this module does not own (the Onshape block) exactly as stored.
	const blob = { ...(readProjectBlob(ctx.db) ?? {}) };
	for (const k of ['part_numbering', 'custom_fields']) delete blob[k];
	setSetting(ctx, PROJECT_CONFIG_KEY, JSON.stringify({ ...blob, ...config }));
}

export function createOrgSettings(ctx: Ctx, input: ConfigInput): OrgSettings {
	if (getOrgSettings(ctx.db)) {
		throw new OpalError(400, 'already_configured', 'This organization is already set up; edit its settings instead');
	}
	const config = buildConfig(input, null);
	save(ctx, config);
	return config;
}

export function updateOrgSettings(ctx: Ctx, input: ConfigInput): OrgSettings {
	const existing = getOrgSettings(ctx.db);
	if (!existing) throw notFound('Organization settings');
	// A tier that parts still use cannot go: they would be left with a level the project lacks.
	const keep = new Set(input.tiers.map((t) => t.level));
	const dropped = existing.tiers.filter((t) => !keep.has(t.level));
	if (dropped.length) {
		const used = new Set(
			ctx.db
				.selectDistinct({ tier: part.tier })
				.from(part)
				.where(inArray(part.tier, dropped.map((t) => t.level)))
				.all()
				.map((r) => r.tier)
		);
		const names = dropped.filter((t) => used.has(t.level)).map((t) => `${t.name} (level ${t.level})`);
		if (names.length) {
			throw new OpalError(409, 'tier_in_use', `Parts still use tier ${names.join(', ')}; reassign them before removing it`);
		}
	}
	const config = buildConfig(input, existing);
	save(ctx, config);
	return config;
}

/** Old name, kept for the areas that still import it. */
export const getProjectConfig = getOrgSettings;
