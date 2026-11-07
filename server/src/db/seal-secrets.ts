/**
 * Keeps stored secrets sealed: the step that seals what an older version wrote in plaintext, and
 * reseals what an older key sealed. It runs every time a database opens, and does nothing when there
 * is nothing to do, so it also covers an import, a restored copy and a changed key.
 *
 * A data rewrite, not an operation: sealing leaves no audit row. Nothing readable changes, and a row
 * would only record that the server started. Hiding values already in the log does leave one.
 *
 * Sealing a row does not remove the old value from the file. SQLite leaves it in freed space and in
 * the write-ahead log, so a rewrite ends with VACUUM and a truncated log. `user_version` records that
 * this finished, and a sealing transaction clears it, so a VACUUM that failed (a full disk) runs at
 * the next start instead of leaving the old bytes behind for good.
 */
import { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { authSettingScope, isSealed, openSealed, openingKeys, pluginSettingScope, seal } from '../auth/sealed.ts';
import { DEMO_PREFIX } from '../paths.ts';
import { SECRET_AUTH_SETTINGS } from './schema/auth.ts';
import { snapshotPaths } from './snapshot.ts';

const hasTable = (sqlite: Database, name: string) =>
	!!sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

interface Stored {
	/** How the setting is named in a message. Holds no value. */
	label: string;
	scope: string;
	/** Exactly what the column holds. */
	text: string;
	sealed: boolean;
	write: (sealed: string) => void;
}

function storedSecrets(sqlite: Database): Stored[] {
	const out: Stored[] = [];
	if (hasTable(sqlite, 'auth_setting')) {
		const update = sqlite.query('UPDATE auth_setting SET value = ? WHERE id = ?');
		for (const key of SECRET_AUTH_SETTINGS) {
			const row = sqlite.query('SELECT id, value FROM auth_setting WHERE key = ?').get(key) as { id: number; value: string | null } | null;
			if (!row?.value) continue;
			out.push({
				label: key,
				scope: authSettingScope(key),
				text: row.value,
				sealed: isSealed(row.value),
				write: (sealed) => update.run(sealed, row.id)
			});
		}
	}
	if (hasTable(sqlite, 'plugin_setting') && hasTable(sqlite, 'plugin')) {
		const rows = sqlite
			.query('SELECT s.id, s.key, s.value, s.secret, p.key AS plugin, p.manifest FROM plugin_setting s JOIN plugin p ON p.id = s.plugin_id')
			.all() as { id: number; key: string; value: string | null; secret: number; plugin: string; manifest: string }[];
		const update = sqlite.query('UPDATE plugin_setting SET value = ?, secret = 1 WHERE id = ?');
		for (const row of rows) {
			// The flag could fall behind the manifest: an older server kept it when a plugin update made a setting secret.
			const declared = (JSON.parse(row.manifest) as { settings?: { key: string; type: string }[] }).settings?.some((d) => d.key === row.key && d.type === 'secret');
			if (!row.secret && !declared) continue;
			if (row.value === null) continue;
			const value = JSON.parse(row.value) as unknown;
			// An empty secret has nothing to hide, but one that just became secret may have history to hide.
			if (value === '' && row.secret) continue;
			const sealed = !!row.secret && isSealed(value);
			out.push({
				label: `plugin ${row.plugin}: ${row.key}`,
				scope: pluginSettingScope(row.plugin, row.key),
				text: sealed ? value : row.value,
				sealed,
				write: (next) => {
					update.run(JSON.stringify(next), row.id);
					if (!row.secret) hideAuditedValue(sqlite, row.id);
				}
			});
		}
	}
	return out;
}

/** The stored secrets no key here opens, named for a message. */
export function unreadableSecrets(sqlite: Database): string[] {
	const keys = openingKeys();
	return storedSecrets(sqlite)
		.filter((s) => s.sealed && !openSealed(s.text, s.scope, keys))
		.map((s) => s.label);
}

/** Who hid the values. At a start, nobody did: the server found them. */
export interface HiddenBy {
	op: string;
	invocation?: string | null;
	actorUserId?: number | null;
	actorTokenId?: number | null;
}

/**
 * A setting that became secret: what the audit log kept while it was not, it hides now, because a copy
 * of the database must not reveal it. The log is the record of last resort, so changing it leaves a
 * row of its own. The audit screen shows field changes, not the reason, so the row carries both.
 */
export function hideAuditedValue(sqlite: Database, settingId: number, by: HiddenBy = { op: 'secrets.seal' }): void {
	const { changes } = sqlite
		.query(
			`UPDATE audit_log SET
				"before" = CASE WHEN json_type("before", '$.value') NOT IN ('null') THEN json_set("before", '$.value', '[redacted]') ELSE "before" END,
				"after" = CASE WHEN json_type("after", '$.value') NOT IN ('null') THEN json_set("after", '$.value', '[redacted]') ELSE "after" END
			WHERE entity = 'plugin_setting' AND entity_id = ? AND (
				(json_type("before", '$.value') NOT IN ('null') AND json_extract("before", '$.value') IS NOT '[redacted]')
				OR (json_type("after", '$.value') NOT IN ('null') AND json_extract("after", '$.value') IS NOT '[redacted]')
			)`
		)
		.run(settingId);
	if (!changes) return;
	sqlite
		.query(
			`INSERT INTO audit_log (at, entity, entity_id, action, op, invocation, actor_user_id, actor_token_id, "before", "after", reason)
			VALUES (?, 'plugin_setting', ?, 'update', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			now(),
			settingId,
			by.op,
			by.invocation ?? null,
			by.actorUserId ?? null,
			by.actorTokenId ?? null,
			JSON.stringify({ earlierValues: 'in the log' }),
			JSON.stringify({ earlierValues: '[redacted]' }),
			'Earlier values hidden: this setting became secret'
		);
}

export interface SealOutcome {
	/** Rows written. */
	changed: number;
	/** Secrets no key opens. */
	unreadable: string[];
	/** Secrets in plaintext that were left that way. */
	plaintext: number;
}

function sealRows(sqlite: Database, sealPlaintext: boolean): SealOutcome {
	const outcome: SealOutcome = { changed: 0, unreadable: [], plaintext: 0 };
	const items = storedSecrets(sqlite);
	if (!items.length) return outcome;
	const keys = openingKeys();
	const run = sqlite.transaction(() => {
		for (const item of items) {
			if (!item.sealed) {
				if (!sealPlaintext) {
					outcome.plaintext++;
					continue;
				}
				item.write(seal(item.text, item.scope));
				outcome.changed++;
				continue;
			}
			const opened = openSealed(item.text, item.scope, keys);
			if (!opened) {
				outcome.unreadable.push(item.label);
			} else if (!opened.current) {
				item.write(seal(opened.plain, item.scope));
				outcome.changed++;
			}
		}
		if (outcome.changed) markOldBytes(sqlite);
	});
	run();
	return outcome;
}

/** Inside the transaction that replaced a value: the next start removes what it left behind in the file. */
export function markOldBytes(sqlite: Database): void {
	sqlite.run('PRAGMA user_version = 0');
}

function removeResidue(sqlite: Database, inWal: boolean): void {
	sqlite.run('VACUUM');
	sqlite.run('PRAGMA user_version = 1');
	if (inWal) sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * True when an existing database holds a secret an older version wrote in plaintext. This runs before
 * the migrations, on whatever schema the file has, so a shape it does not know reads as "no": only the
 * extra copy depends on it, and sealing runs after the migrations regardless.
 */
export function holdsPlaintextSecret(sqlite: Database): boolean {
	try {
		return storedSecrets(sqlite).some((s) => !s.sealed);
	} catch {
		return false;
	}
}

/** Seals a live database. A new one has nothing to scrub. */
export function sealDatabase(sqlite: Database, isNew = false): SealOutcome {
	const outcome = sealRows(sqlite, true);
	const version = (sqlite.query('PRAGMA user_version').get() as { user_version: number }).user_version;
	if (version !== 1) {
		if (isNew) sqlite.run('PRAGMA user_version = 1');
		else removeResidue(sqlite, true);
	}
	if (outcome.unreadable.length) {
		console.error(
			`These stored secrets cannot be read with the current key, so they are treated as not set: ${outcome.unreadable.join(', ')}. ` +
				'Restore the key from a backup (OPAL_SECRETS_KEY or the .opal_secrets_key file in the data folder), or enter them again in Settings. ' +
				'For single sign-on, OPAL_OIDC_CLIENT_SECRET also works.'
		);
	}
	return outcome;
}

function sealCopy(path: string, sealPlaintext: boolean): SealOutcome {
	const sqlite = new Database(path, { strict: true });
	try {
		const outcome = sealRows(sqlite, sealPlaintext);
		if (outcome.changed) removeResidue(sqlite, false);
		return outcome;
	} finally {
		sqlite.close();
	}
}

/**
 * The other databases next to the live one. A copy taken before an upgrade stays in plaintext, because
 * it is the way back to a version that cannot read a sealed value: it gets a warning until someone
 * removes it. What a newer key replaced is resealed, so a copy keeps working after a rotation. A demo
 * left by a crash is nobody's way back, so it is sealed outright.
 *
 * Trouble here is a warning and does not stop the server. The return value says whether all went well.
 */
export function sweepCopies(dbPath: string): boolean {
	const dir = dirname(dbPath);
	const demo = join(dir, `${DEMO_PREFIX}${basename(dbPath)}`);
	const targets: { path: string; sealPlaintext: boolean }[] = [
		...snapshotPaths(dbPath).map((path) => ({ path, sealPlaintext: false })),
		...(existsSync(demo) ? [{ path: demo, sealPlaintext: true }] : []),
		...snapshotPaths(demo).map((path) => ({ path, sealPlaintext: true }))
	];
	const plaintext: string[] = [];
	let ok = true;
	for (const { path, sealPlaintext } of targets) {
		try {
			if (sealCopy(path, sealPlaintext).plaintext) plaintext.push(basename(path));
		} catch (e) {
			ok = false;
			console.warn(`Could not check the secrets in ${path}: ${(e as Error).message}`);
		}
	}
	if (plaintext.length) {
		console.warn(
			`Secrets are still in plaintext in these copies in ${dir}: ${plaintext.join(', ')}. They are the way back to a version from before secrets were encrypted. Delete them when you no longer need that.`
		);
	}
	return ok;
}
