// web/index.html は ES モジュールを import するため file:// では開けない
// (CORS でブロックされる)。この静的サーバ経由で開く。
//
//   node tools/serve.js  →  http://localhost:8080/web/

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.v': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/web/index.html';
  if (path.endsWith('/')) path += 'index.html';

  const full = join(ROOT, normalize(path));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}/web/`);
});
