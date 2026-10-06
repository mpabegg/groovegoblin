// Autenticação de toda rota /api/*.
//
// dev: só loopback, sem identidade. Host precisa ser loopback (anti DNS
// rebinding) e qualquer cabeçalho de proxy/identidade recusa a chamada: dev
// nunca deve ficar atrás do Serve.
// tailscale: o Serve local remove Tailscale-User-Login forjado e preenche o
// verdadeiro; como o servidor só escuta em 127.0.0.1, o cabeçalho é confiável e
// precisa bater EXATAMENTE com a lista. Dispositivo com tag chega sem cabeçalho
// e é recusado.
// Escritas: Origin exato e Sec-Fetch-Site same-origin quando presente.

import { HttpError, headerCount, singleHeader } from './http.js';

const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-app-capabilities', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];
const WRITE_METHODS = new Set(['PUT', 'POST', 'DELETE', 'PATCH']);

export function createAuthContext({ mode, port, allowedLogins = [], publicOrigin = null }) {
  const loopbackHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const loopbackOrigins = loopbackHosts.map((host) => `http://${host}`);
  return {
    mode,
    hosts: new Set(mode === 'tailscale' ? [publicOrigin.host, ...loopbackHosts] : loopbackHosts),
    origins: new Set(mode === 'tailscale' ? [publicOrigin.origin] : loopbackOrigins),
    logins: new Set(allowedLogins),
  };
}

// Lança HttpError quando a chamada não pode seguir. Devolve a identidade
// aceita (string) no modo tailscale ou null no dev — só para uso interno, nunca log.
export function authenticate(request, auth) {
  const host = singleHeader(request, 'host');
  if (host === null || !auth.hosts.has(host.toLowerCase())) {
    throw new HttpError(403, 'host_forbidden', 'Host não autorizado para a API.');
  }
  let identity = null;
  if (auth.mode === 'dev') {
    if (PROXY_HEADERS.some((name) => headerCount(request, name) > 0)) {
      throw new HttpError(403, 'proxied_request_refused', 'O modo dev só aceita chamadas diretas em loopback; atrás do Serve use GROOVE_AUTH=tailscale.');
    }
  } else {
    const count = headerCount(request, 'tailscale-user-login');
    if (count === 0) throw new HttpError(401, 'identity_required', 'Identidade do Tailscale ausente (dispositivos com tag não têm identidade).');
    if (count > 1) throw new HttpError(400, 'identity_ambiguous', 'Cabeçalho de identidade repetido.');
    identity = request.headers['tailscale-user-login'];
    // B3: sem cabeçalho OU login fora da lista = 401 (não autenticado para este servidor).
    if (!auth.logins.has(identity)) throw new HttpError(401, 'identity_forbidden', 'Este login não está autorizado neste servidor.');
  }
  if (WRITE_METHODS.has(request.method)) {
    const origin = singleHeader(request, 'origin');
    if (origin === null || !auth.origins.has(origin)) {
      throw new HttpError(403, 'origin_forbidden', 'Escrita sem Origin autorizado (no terminal, envie o cabeçalho Origin explicitamente).');
    }
    const site = singleHeader(request, 'sec-fetch-site');
    if (site !== null && site !== 'same-origin') {
      throw new HttpError(403, 'fetch_site_forbidden', 'Escrita só a partir do próprio app.');
    }
  }
  return identity;
}
