/** Open a URL in the default browser. */

export function hasDisplay(platform: string = process.platform, env = process.env): boolean {
	if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
	return true;
}

export function openCommand(url: string, platform: string = process.platform): string[] {
	if (platform === 'darwin') return ['open', url];
	if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
	return ['xdg-open', url];
}

export function openBrowser(url: string): void {
	try {
		Bun.spawn(openCommand(url), { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref();
	} catch {
		// The URL is printed anyway.
	}
}
