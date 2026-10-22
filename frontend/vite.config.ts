import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The FastAPI server serves the built client from src/opal/web_client and
// falls back to index.html for every non-API path (single-page app).
const api = `http://127.0.0.1:${process.env.OPAL_API_PORT ?? '8000'}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({
				pages: '../src/opal/web_client',
				assets: '../src/opal/web_client',
				fallback: 'index.html',
				strict: false
			})
		})
	],
	server: {
		port: Number(process.env.OPAL_WEB_PORT ?? 5173),
		strictPort: true,
		// Keep the browser's Host so the API's same-origin (CSRF) check passes.
		proxy: {
			'/api': { target: api, changeOrigin: false },
			'/oidc': { target: api, changeOrigin: false }
		}
	}
});
