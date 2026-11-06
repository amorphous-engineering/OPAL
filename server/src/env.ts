/**
 * A yes/no environment variable. Unset or empty means `fallback`. Otherwise only 1, true, yes or on
 * turn it on, so `0`, `false`, `off` and a typo all mean off: a misspelled setting never leaves
 * something switched on that the operator meant to switch off.
 */
export function envFlag(name: string, fallback = false): boolean {
	const value = process.env[name]?.trim();
	return value ? /^(1|true|yes|on)$/i.test(value) : fallback;
}
