// Arquivos estáticos do app publicado. Allowlist: só o que o build publica
// (index, guia, README, manifesto, ícone, sw, offline-assets e as pastas src/ e
// assets/). local/, server/, tests/, scripts/, evidence/, deploy/, dist/,
// dotfiles e o data dir nunca saem, nem codificados nem por symlink.

import { realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createAssetManifest } from '../scripts/asset-manifest.js';
import { readNoFollow } from './fsutil.js';
import { staticSecurityHeaders } from './http.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/plain', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
export const PUBLIC_FILES = Object.freeze(['index.html', 'guide.html', 'README.md', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'offline-assets.json']);
export const PUBLIC_DIRS = Object.freeze(['src', 'assets']);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// Devolve o caminho relativo permitido ou null. Recusa codificação dupla,
// barra/contrabarra/NUL codificadas, segmentos vazios, ponto inicial e tudo que
// não esteja na allowlist pública.
export function publicRelativePath(rawRelative) {
  if (/%(?:2f|5c|00|25)/i.test(rawRelative) || rawRelative.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    return null;
  }
  if (decoded === '' || decoded === '/') return 'index.html';
  const segments = decoded.replace(/^\//, '').split('/');
  if (segments.some((segment) => !SEGMENT.test(segment))) return null;
  if (segments.length === 1) return PUBLIC_FILES.includes(segments[0]) ? segments[0] : null;
  return PUBLIC_DIRS.includes(segments[0]) ? segments.join('/') : null;
}

export function createStaticHandler({ root, projectRoot, basePath, hsts = false, apiEnabled = false }) {
  const isProjectRoot = root === resolve(projectRoot);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const security = staticSecurityHeaders({ hsts });
  const notFound = (response) => response.writeHead(404, { ...security, 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
  let realRoot = null;

  return async function serveStatic(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...security, Allow: 'GET, HEAD' }).end();
      return;
    }
    const rawPath = url.pathname;
    if (basePath !== '/' && rawPath === basePath.slice(0, -1)) {
      response.writeHead(308, { ...security, Location: `${basePath}${url.search}` }).end();
      return;
    }
    if (!rawPath.startsWith(basePath)) {
      notFound(response);
      return;
    }
    const relative = publicRelativePath(rawPath.slice(basePath.length));
    if (relative === null) {
      notFound(response);
      return;
    }
    const path = resolve(root, relative);
    if (!path.startsWith(rootPrefix)) {
      notFound(response);
      return;
    }
    try {
      let content;
      if (isProjectRoot && relative === 'offline-assets.json') {
        content = JSON.stringify(await createAssetManifest(root));
      } else {
        realRoot ??= await realpath(root);
        const real = await realpath(path);
        if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) throw new Error('fora da raiz');
        content = await readNoFollow(real);
        if (isProjectRoot && relative === 'sw.js') {
          const manifest = await createAssetManifest(root);
          content = content.toString('utf8').replace('__GROOVE_REVISION__', manifest.version);
        }
        // A página entregue pelo servidor diz que a API está ligada: é o único
        // sinal que autoriza o app a consultar `/api/health` na abertura. O site
        // estático (e o modo somente-estático, sem diretório de dados) fica com
        // `off` e não faz requisição nenhuma — nenhum 404 no console.
        if (apiEnabled && relative === 'index.html') {
          content = content.toString('utf8').replace('data-groove-server="off"', 'data-groove-server="on"');
        }
      }
      const type = TYPES[extname(path)] || 'application/octet-stream';
      const contentType = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml' ? `${type}; charset=utf-8` : type;
      response.writeHead(200, { ...security, 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      notFound(response);
    }
  };
}
