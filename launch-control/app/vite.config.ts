import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Launch Control is its own app. It reaches OPAL only through the launch-control plugin,
// at <OPAL>/plugins/launch-control/*. In development Vite proxies that path to a local OPAL.
const opal = process.env.OPAL_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false })
		})
	],
	server: {
		port: Number(process.env.LC_WEB_PORT ?? 5174),
		strictPort: true,
		proxy: { '/plugins/launch-control': { target: opal, changeOrigin: false } }
	}
});
