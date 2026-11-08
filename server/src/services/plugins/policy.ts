/**
 * `required`: a plugin that cannot be confined does not start. `off`: never confine.
 * Anything else that is not `auto` counts as `required`, so a typo does not lower the protection.
 * Its own module, so the data-folder hardening can read it without loading the launcher.
 */
export function confinementPolicy(): 'auto' | 'required' | 'off' {
	const value = process.env.OPAL_PLUGIN_CONFINEMENT?.trim().toLowerCase();
	if (!value || value === 'auto') return 'auto';
	return value === 'off' ? 'off' : 'required';
}
