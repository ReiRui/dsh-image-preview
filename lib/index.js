/**
 * dsh-image-preview — local image hosting for DeepSeek Harness.
 *
 * What it does
 * ------------
 * 1. Registers a `prefix` route (default `/preview/*`) on the web profile's own
 *    HTTP server (`ctx.webServer`) that serves image files from one directory
 *    (default `$DSH_HOME/preview`, i.e. `~/.dsh/preview`). Because the route
 *    lives on the same origin as the chat page, `http://127.0.0.1:<port>/preview/<name>`
 *    URLs render inline in messages with no mixed-content or CORS issues.
 * 2. Registers the `preview_image` model tool: give it the absolute path of an
 *    existing image (a screenshot, a downloaded file, a rendered preview); it
 *    copies the file into the served directory (unless already inside) under a
 *    unique name and returns the URL to embed. Only files explicitly handed to
 *    the tool are ever served — the route never lists directories and rejects
 *    traversal or non-image extensions.
 *
 * Security posture (self-audit, matching the global plugin-install rules)
 * ----------------------------------------------------------------------
 * - No install-time scripts; no dependencies at all (only node builtins +
 *   `ctx`). Nothing is fetched, no credentials are read, no child processes
 *   are spawned, no eval.
 * - Path containment: every served path is realpath-resolved and must stay
 *   under the realpath of the configured root; `..`, backslashes, and NUL are
 *   rejected before resolution.
 * - Extension whitelist: png / jpg / jpeg / webp / gif / avif / bmp only;
 *   everything else answers 415.
 * - No directory listing; unknown paths answer 404.
 * - The tool only copies an explicitly provided file — it cannot read out
 *   arbitrary paths, so nothing outside the preview root is ever exposed.
 *
 * @module dsh-image-preview
 */
import { readFileSync, readFile, realpathSync, stat, copyFile, mkdirSync, promises } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, extname, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const name = 'image-preview';

/**
 * Required services: Cordis applies this plugin only after both exist, which
 * is the correct ordering for route/tool registration (reading them with
 * `ctx.get` in `apply` would race the provider rows and silently skip
 * registration). This plugin targets the web profile, which always mounts
 * both.
 */
const inject = ['webServer', 'tools'];

/** Whitelisted raster content types by extension. */
const CONTENT_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp'
};
const ALLOWED_EXT = new Set(Object.keys(CONTENT_TYPES));

/** Default served root: `$DSH_HOME/preview`, falling back to `~/.dsh/preview`. */
function defaultRoot() {
	const home = process.env.DSH_HOME || join(homedir(), '.dsh');
	return join(home, 'preview');
}

/** True when the real path is inside the real root (or equal to it). */
function underRoot(realPath, realRoot) {
	return realPath === realRoot || realPath.startsWith(realRoot + sep);
}

/** Render one tool outcome to model-visible text. */
function renderOutcome(value) {
	if (value.ok) return `Image is now viewable in chat: ${value.url}`;
	return `preview_image failed: ${value.error ?? 'unknown error'}`;
}

function apply(ctx, config = {}) {
	const disposers = [];
	const root = typeof config.root === 'string' && config.root.length > 0 ? config.root : defaultRoot();
	const prefix = typeof config.prefix === 'string' && config.prefix.startsWith('/')
		? config.prefix.replace(/\/+$/, '')
		: '/preview';

	// Create and pin the served root once at mount time.
	mkdirSync(root, { recursive: true });
	const realRoot = realpathSync(root);

	// 1. Static route on the existing web server (same origin as the chat page).
	const server = ctx.webServer;
	disposers.push(server.register({
			kind: 'prefix',
			path: prefix,
			handler: (req, res) => {
				let pathname;
				try {
					pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
				} catch {
					res.writeHead(400);
					res.end('bad request');
					return;
				}
				const rel = pathname.slice(prefix.length).replace(/^\/+/, '');
				if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
					res.writeHead(400);
					res.end('bad request');
					return;
				}
				const file = resolve(root, rel);
				try {
					const real = realpathSync(file);
					if (!underRoot(real, realRoot)) {
						res.writeHead(403);
						res.end();
						return;
					}
					const type = CONTENT_TYPES[extname(real).toLowerCase()];
					if (!type) {
						res.writeHead(415);
						res.end('unsupported type');
						return;
					}
					const data = readFileSync(real);
					res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
					res.end(data);
				} catch {
					res.writeHead(404);
					res.end('not found');
				}
			}
		}));

	// 2. Model tool: stage one existing image into the served root and return
	// its URL.
	const tools = ctx.tools;
	disposers.push(tools.register({
			name: 'preview_image',
			description: 'Stage an existing local image file into the served preview directory and return the ONE valid URL to embed in your reply. Pass the absolute path of the image (png/jpg/jpeg/webp/gif/avif/bmp). Use it whenever the user should see an image inline in the chat (e.g. a screenshot you just took or downloaded). Do NOT copy files into ~/.dsh/preview yourself (the session file sandbox blocks writes outside the workspace) and do NOT construct or guess preview URLs — use the returned url verbatim in the reply as ![alt](url). If the file does not exist yet, create or download it first, then call this tool.',
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Absolute path to an existing image file (png / jpg / jpeg / webp / gif / avif / bmp).'
					}
				},
				required: ['file_path']
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						url: { type: 'string' },
						path: { type: 'string' },
						error: { type: 'string' }
					},
					required: ['ok'],
					additionalProperties: false
				},
				render: (args, value) => [{ type: 'text', text: renderOutcome(value) }]
			},
			isConcurrencySafe: () => true,
			execute: async (args) => {
				const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
				const src = resolve(filePath);
				let st;
				try {
					st = await promises.stat(src);
				} catch (error) {
					return { ok: false, error: `file not found: ${filePath} (${error instanceof Error ? error.code ?? error.message : String(error)})` };
				}
				if (!st.isFile()) return { ok: false, error: `not a regular file: ${filePath}` };
				const ext = extname(src).toLowerCase();
				if (!ALLOWED_EXT.has(ext)) {
					return { ok: false, error: `unsupported image type "${ext}"; use png / jpg / jpeg / webp / gif / avif / bmp` };
				}
				let name;
				try {
					const realSrc = realpathSync(src);
					if (underRoot(realSrc, realRoot)) {
						name = basename(realSrc);
					} else {
						name = `${randomUUID().slice(0, 8)}-${basename(realSrc).replace(/[^A-Za-z0-9._-]/g, '_')}`;
						await promises.copyFile(realSrc, join(root, name));
					}
				} catch (error) {
					return { ok: false, error: `failed to stage image: ${error instanceof Error ? error.message : String(error)}` };
				}
				const url = `http://127.0.0.1:${server.port}${prefix}/${encodeURIComponent(name)}`;
				return { ok: true, url, path: name };
			}
		}));

	// Combined disposer: unregister the route and the tool on teardown/HMR.
	return () => {
		for (const dispose of disposers) {
			try {
				dispose();
			} catch {
				// teardown containment: one failed disposer must not stop the rest
			}
		}
	};
}

export { apply, inject, name };
