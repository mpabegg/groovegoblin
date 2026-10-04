import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(projectRoot, process.env.STATIC_ROOT || '.');
const basePath = normalizeBasePath(process.env.BASE_PATH || '/');
const port = Number(process.env.PORT || 5173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/plain', '.svg': 'image/svg+xml', '.json': 'application/json', '.wav': 'audio/wav' };

function normalizeBasePath(path) {
  const normalized = `/${path.split('/').filter(Boolean).join('/')}/`;
  return normalized === '//' ? '/' : normalized;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (basePath !== '/' && pathname === basePath.slice(0, -1)) {
      response.writeHead(308, { Location: `${basePath}${new URL(request.url, 'http://localhost').search}` }).end();
      return;
    }
    if (basePath !== '/' && !pathname.startsWith(basePath)) {
      response.writeHead(404).end('Não encontrado');
      return;
    }
    const relativePath = basePath === '/' ? pathname : pathname.slice(basePath.length);
    const path = resolve(root, `.${relativePath === '' || relativePath === '/' ? '/index.html' : `/${relativePath}`}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const content = await readFile(path);
    const type = types[extname(path)] || 'application/octet-stream';
    const contentType = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml' ? `${type}; charset=utf-8` : type;
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404).end('Não encontrado');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`GrooveGoblin: http://127.0.0.1:${port}${basePath}`));
