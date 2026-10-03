# GrooveGoblin

Aplicação web estática para compor e treinar frases rítmicas em 4/4. Usa JavaScript ESM, CSS e SVG nativos: sem framework, dependências de runtime ou backend. Guia completo da interface, notação, biblioteca, geração, avaliação e privacidade: [guide.html](./guide.html) — também acessível pelo app.

## Desenvolvimento local

Requer Node.js 22 ou posterior e navegador moderno com Web Audio; não é necessário `npm install`.

```sh
npm start
```

Abra <http://127.0.0.1:5173>. O servidor local serve somente arquivos estáticos em loopback; não recebe nem processa frases. Porta alternativa: `PORT=5174 npm start`. Pare com Ctrl+C. `file://` não é suportado por causa dos módulos ES.

## Build e preview

`npm run build` recria `dist/` sem bundler e copia somente o app, módulos `src/`, `guide.html`, este README e `.nojekyll`. Testes, evidências e scripts de desenvolvimento não são publicados.

```sh
npm run build
npm run preview
```

Abra <http://127.0.0.1:5173/groovegoblin/>. O preview serve o artefato real `dist/` sob o prefixo de caminho de um repositório GitHub Pages. O servidor redireciona o prefixo sem a barra final para preservar URLs relativas. É possível trocar prefixo e porta: `STATIC_ROOT=dist BASE_PATH=/meu-projeto/ PORT=5174 node server.js`.

## GitHub Pages

O workflow [`.github/workflows/pages.yml`](./.github/workflows/pages.yml), acionado por push à branch `main` ou manualmente, executa testes e checagem sintática, constrói e envia `dist/` como artefato Pages e então faz o deploy. Ao configurar um repositório GitHub, selecione **Settings → Pages → Build and deployment → Source: GitHub Actions**.

O deploy GitHub real ainda está pendente: não há repositório remoto e nenhuma Action/publicação foi executada. A origem publicada terá armazenamento de navegador separado de `localhost` e de outras origens. Phrase/BPM/compassos e preferências ficam no `localStorage` do dispositivo; não há serviço de aplicação nem upload automático. Os links compartilhados carregam os dados da frase no fragmento da própria URL.

## Verificações locais

```sh
npm test
npm run check
npm run build
```

`npm test` executa os testes Node; `npm run check` checa a sintaxe dos módulos, servidor e construtor; `npm run build` valida a produção estática. Para confirmar o preview de projeto, confira respostas HTML, CSS, JavaScript e guia em `/groovegoblin/`. Esses checks locais não executam o workflow do GitHub nem substituem teste real no navegador.
