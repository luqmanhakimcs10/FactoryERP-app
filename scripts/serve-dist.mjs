/**
 * Serve `dist/` the way Vercel will, so the export can be checked before it
 * ships: static file first, and anything that doesn't resolve to a real file
 * falls back to index.html — the same two rules `vercel.json` encodes.
 *
 * This exists because the failure being fixed here was a SERVING failure, not a
 * build failure: the bundle was fine, Vercel just handed visitors the repo's
 * source instead of the built output. A local build alone would not have caught
 * that; serving it the way production does is what proves the fix.
 *
 *   node scripts/serve-dist.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('../dist', import.meta.url)));
const PORT = Number(process.argv[2] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function tryFile(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? p : null;
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // `normalize` + the prefix check stop `../` escaping the output directory.
  const candidate = normalize(join(ROOT, url === '/' ? '/index.html' : url));
  if (!candidate.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const file = (await tryFile(candidate)) ?? (await tryFile(join(ROOT, 'index.html')));
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }

  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} on http://localhost:${PORT} (SPA fallback on)`);
});
