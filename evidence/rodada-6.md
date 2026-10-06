# Rodada 6 — servidor pessoal e gerador de estudos

Formato das rodadas anteriores. Capturas com dados fictícios (`tests/fixtures/course/`,
formulários de exemplo), em 1440×900 e 1280×800. Nada de conteúdo real de curso nem de
identificador de infraestrutura entra neste arquivo: só contagens e caminhos do repositório.

`npm test` e `npm run check` passam ao fim de cada etapa; os números abaixo são da `main`
depois de cada merge e push.

## Etapas

| Etapa | Commit | `npm test` | `npm run check` |
| --- | --- | --- | --- |
| 1 — limite de 128 compassos e correções do conversor | `2f98106` | 928 (927 passam, 1 ignorado) | 194 módulos |
| 2 — motor de geração (`src/study-generator.js`) | `46a862d` | 957 (956 passam, 1 ignorado) | 198 módulos |
| 3 — formas de dedilhado | `8169a0d` | 979 (978 passam, 1 ignorado) | 202 módulos |
| 4 — interface do gerador e variações | `50f75b0` | 1027 (1026 passam, 1 ignorado) | 209 módulos |
| 5 — catálogo no curso, aula e sessão de hoje | `1903c21` | 1088 (1087 passam, 1 ignorado) | 214 módulos |
| 6 — servidor e segurança | (esta etapa) | 1146 (1145 passam, 1 ignorado) | 234 módulos |

O teste ignorado é o de amostra física da rodada 1 (`physical sample`), ignorado por desenho.

## Etapa 4 — interface do gerador (A4)

Módulos novos: `src/study-recipe.js` (controles ↔ receita, presets, avisos acionáveis, 12
tonalidades), `src/study-controller.js` (diálogo, prévia, criação, variação), `src/study-view.js`
(DOM do diálogo), `src/study-session.js` (receita → sessão v5 + metadata) e `src/study.css`.
Ligação em `src/library-view.js` (botão "Novo estudo", "Gerar variação", vínculos no cartão) e
`index.html` (`./src/study.css`). A receita vive em `metadata.study`, **fora** da sessão; a sessão
continua v5 e o documento da sessão não ganhou campo nenhum.

### Critério 8 — diálogo com no máximo 14 controles, prévia ao vivo e avisos com ação

Contagem medida no navegador (Chromium próprio, CDP, viewport 1440×900), com o app servido pelo
servidor estático do próprio repositório:

| Estado | Controles visíveis |
| --- | --- |
| repouso, presets de ciclo (arpejo/linha contínua) | 9 |
| repouso, progressão "lista" (aparece "Nas 12 tonalidades") | 10 |
| "Mais opções" aberto — grupos Progressão / Figura / Duração | 9 cada |
| "Mais opções" aberto — grupos Forma / Região | 6 e 7 |
| pior caso (painel aberto + "Nas 12 tonalidades" + 4 botões de aviso, 1 por motivo) | 14 |

O painel avançado tem um seletor de grupo e mostra no máximo 4 campos do grupo escolhido, reusando
os MESMOS nós de campo (nenhum valor se perde: o formulário inteiro é lido no commit). Os campos
primários viram a linha de contexto quando o painel abre.

Prévia ao vivo (tablatura + partitura com cifras) medida no mesmo navegador:

- preset "Arpejo pelo ciclo de quartas": `25 compassos · 12 acordes · 12 blocos · 37 notas · casas 1–5 · cordas 1,2,3,4`;
- preset "Linha contínua numa região": `13 compassos · 12 acordes · 12 blocos · 49 notas · casas 1–5 · cordas 1,2,3,4`.

### Critério 4 — aviso do percurso com o mínimo necessário, e a ação resolve

No diálogo, percurso "sobe e desce", baixo de **5 cordas**, região 1–12, 1 compasso por bloco,
lista C–Am–Dm7–G7: o motor avisa que a figura precisa de **6** compassos por bloco e a única ação
oferecida leva a receita a esse tamanho; aplicada, a lista de avisos fica **vazia** e o "Criar
exercício" continua habilitado (`25 compassos · 4 acordes · 4 blocos · 75 notas · casas 1–12 ·
cordas 1,2,3,4,5` com o bloco em 6). Nada é truncado: as notas do primeiro acorde continuam todas.

### Regressão do teto de 128 compassos (corrigida na etapa 2 → 4)

Quartas em arpejo, `compassos = 2`, `voltas = 12` no diálogo: **um** aviso, o do teto
("o ciclo pede 289 compassos e o teto é 128" → "Reduzir para 5 voltas"), sem o aviso contraditório
de "aumentar compassos". Aplicada a redução, aparece o aviso de total que é legítimo: a receita
pede 2 compassos e o estudo precisa de **121** (o compasso final conta), com a ação "Aumentar para
121 compassos". A guarda é `shortTotal = !capped && …` em `src/study-generator.js`.

### Critério 9 — variação e 12 tonalidades

- "Gerar variação" num estudo salvo abre o diálogo preenchido; mudar a tonalidade cria um exercício
  **novo** ligado ao original (`metadata.study.origin`) e o original fica **byte a byte igual**
  (comparação do documento no armazenamento do navegador antes/depois).
- "Nas 12 tonalidades" numa lista I–vi–ii–V: **12** exercícios no MESMO grupo (`Nas 12 tonalidades ·
  C`), com as 12 fundamentais distintas (`chords[0].root` = 0..11) e nomes distintos por tonalidade
  (C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B). Quando a base já existe na Biblioteca, ela é REUSADA
  (só as outras 11 são criadas), entra no mesmo grupo e a sessão, a receita e o histórico dela ficam
  intactos. Um ciclo (quartas/quintas/cromática) não mostra o botão: já percorre as 12 fundamentais.

### Biblioteca

Barra de ferramentas da Biblioteca em repouso: **7** controles (Novo exercício, **Novo estudo**,
Buscar, Instrumento, Etiqueta, Ordenar, Arquivo), dentro do teto de 22 da rodada 5. Medição no
navegador com dois exercícios fictícios na lista: 19 controles visíveis no total (incluindo as abas
do app e as ações dos cartões), sem rolagem vertical em 1440×900.

### Consertos de integração desta etapa

1. `src/study-session.js` traduz o perfil **mínimo** da receita (`{type, strings}`) para o perfil
   completo da sessão (afinação e nomes das notas) — sem isso o commit do estudo lançava "perfil do
   instrumento inválido".
2. `src/study-recipe.js` rotula a ação `expandir-regiao` (a chave do rótulo é o `kind` da AÇÃO do
   motor, não o motivo agrupado) — sem isso "Ampliar a região" não existia e o botão não aparecia.
3. `src/study-recipe.js` aceita a receita vinda do documento do CURSO (etapa 5): a lista de acordes
   em TEXTO volta ao campo e `shapeLabel` (chave que o motor não conhece) é descartada — sem isso
   "Ajustar no Estúdio de estudo" numa sugestão de aula lançaria na frente do usuário.
4. `src/exercise-library.js`: a importação de backup não colapsa duas entradas de conteúdo igual do
   MESMO arquivo (nada do backup é descartado) e continua não duplicando nada ao reimportar.
5. `src/study-controller.js`: a base já existente entra no grupo das 12 (só o rótulo do grupo muda;
   sessão, receita e histórico ficam intactos) — sem isso as 11 irmãs ficariam agrupadas e a base não.

### Privacidade

Auditoria dos 14 arquivos preparados para o commit desta etapa contra a lista privada (mapa e
catálogo reais + termos explícitos): **0** ocorrências. A varredura cobre o texto preparado
(arquivo:linha), pulando imagens e áudio.

## Etapa 5 — catálogo no curso, aula e sessão de hoje (A5/A6)

Módulos novos: `src/course-catalog.js` (receita do catálogo pela tradução do MOTOR), 
`src/course-shape-binding.js` (vínculo rótulo → forma escolhida, lembrado entre aulas) e
`src/course-shape-chooser.js` (diálogo). Endurecidos: `course-format.js` (documento v2 com
`catalog`, leitura do v1), `course-store.js` (reconciliação por URL, lápides),
`course-attachments.js`, `course-progress.js`, `course-lesson.js`, `course-view.js`,
`today-courses.js`, `today-store.js`, `today-view.js`, `scripts/convert-course-map.js`.
A ligação compartilhada ficou em `src/library-view.js` (workspace de cursos recebe o MESMO
controlador de estudo, as formas/vínculos e os ganchos opcionais).

### Critério 10 — conversor num mapa fictício

`node scripts/convert-course-map.js tests/fixtures/course/map-repairs.json --com-progresso
--catalogo tests/fixtures/course/catalog-example.json --output …` (fixtures fictícios, curso
"Curso de Reparos"):

- saída: `Seções 1 · aulas 3 · materiais 4 (2 mesclado(s)) · exercícios 2 · vínculos 2 · descartados 2`;
- **ids numéricos preservados** como texto: aulas `0`, `25`, `26` (o zero inclusive);
- progresso em objeto lido: `progress.watchedLessonIds = ["0","25"]` (2 aulas assistidas);
- o material que aparece em `anexos` e em `backing_tracks` vira **um** item (2 mesclados) e o
  pacote de 6 cordas é descartado sem derrubar o exercício que o cita como alternativa;
- avisos **agrupados** por código e caminho genérico (8 tipos, 16 ocorrências), sem título nem
  nome de arquivo.

### Critério 12 — catálogo na aula e "Gerar" (navegador próprio, 1440×900)

Curso fictício importado pela própria vista Cursos; a aula `0` mostrou 3 sugestões com receita
(uma delas a variação de 5 cordas) e a aula `26` mostrou a sugestão sem receita (mantendo
"Criar no Estúdio"). Em "Gerar":

1. o diálogo do catálogo aparece pedindo a forma do rótulo ("O curso indica a forma major ·
   fundamental · baixo de 4 cordas") com as formas genéricas de exemplo e a caixa
   "Lembrar esta forma para as próximas aulas";
2. escolhida a forma, o exercício nasce com **notas** (`25 compassos`, `37 notas`), vinculado à
   aula (`study.origin = { id: "0", name: "Aula com identificador zero", kind: "course",
   private: true }`) e **marcado** como conteúdo de curso (`metadata.courseContent === true`);
3. o vínculo lembrado dispensou o diálogo na segunda vez (mesmo rótulo) — a escolha é reaproveitada.

### Critério 14 — Praticar e Assistir independentes

Coberto pelos testes dos módulos (`tests/today-courses.test.js`, `tests/today-store.test.js`,
`tests/today-view.test.js`): a fila de prática sai das aulas **assistidas** (mais antigas primeiro)
e a lista de "Assistir" é calculada pelo tempo indicado, recolhida por padrão; assistir três aulas
hoje só aumenta a fila de prática dos dias seguintes. A verificação no navegador desta etapa ficou
para a etapa 10 (prova final de todos os critérios).

### Critério 11 — reimportação com ids novos

Coberto pelos testes de `course-store` (reconciliação por URL, senão seção+título; lápides que
ressuscitam com id novo) e pela prova de estado no navegador: antes da reimportação, a aula `0`
tinha `watched: true`, a anotação fictícia e os vínculos (`linkedExerciseIds`, 
`generatedSuggestionIds`). A reimportação do MESMO curso com ids derivados do título (variante
`mapa → ids string`, mesmos URLs) ficou pendente de confirmação no navegador nesta etapa — os
testes de módulo provam a reconciliação; a prova de UI entra na etapa 10.

### Consertos de integração desta etapa

1. `src/library-view.js`: o workspace de cursos recebe o MESMO `createStudyController`, as
   formas (`choicesFor`/`shape`), a loja compartilhada de vínculos e os ganchos opcionais
   (`openFretboard`, `openMaterial`, `serverImport`) — sem isso "Gerar" ficaria desabilitado.
   `openFretboard` depende de uma linha em `main.js` (que está no teto de 530 linhas): fica
   desligado até a etapa 8 liberar espaço, e o diálogo da forma simplesmente não mostra o atalho.
2. `src/exercise-library.js`: a metadata passou a guardar `courseContent` (só `true` marca) e a
   marca entra na chave de conteúdo. Sem isso o `taintCourseContent` do vínculo manual era
   descartado na gravação e a barreira B6 perderia a marca no navegador.
3. `src/study-recipe.js` (etapa 4) aceita a receita do documento do curso (cifras em texto,
   `shapeLabel` descartado) — ver a etapa 4.

## Etapa 6 — servidor e segurança (B2/B3)

`server.js` passou a ler o ambiente e subir o processo; o backend nativo ficou em `server/`
(onze módulos: `config`, `store`, `fsutil`, `http`, `auth`, `static`, `blobs`, `backup`, `api`,
`app`, `restore`), tudo com módulos nativos do Node 22 e **zero dependências** novas. Sem
`GROOVE_DATA_DIR` o comportamento é o de sempre (só estático, `/api/*` → 404); com ele, a API
liga em `dev` (loopback, sem identidade) ou `tailscale` (identidade do Serve conferida contra
lista, bind obrigatório em `127.0.0.1`).

### Critério 16 — autenticação e recusa de subida

Testes `tests/server-config.test.js` e `tests/server-auth.test.js`, mais o smoke HTTP real
abaixo: recusa subir em `tailscale` sem lista, sem origem canônica ou com host fora do loopback;
em `dev`, recusa host fora do loopback, origem pública e cabeçalho de proxy (`X-Forwarded-*`);
`Host` estranho → 403; identidade ausente → 401 `identity_required`, fora da lista → 401
`identity_forbidden`, repetida → 400, permitida → 200; escrita sem `Origin` da própria origem →
403 `origin_forbidden`.

### Critérios 17 e 20 — escrita condicional e blobs

`PUT` sem precondição → 428; `If-None-Match: *` sobre doc vivo → 412 com a revisão atual no
`ETag` e `X-Groove-Rev`; `If-Match` velho → 412 `precondition_failed` com `current`; doc
individual devolve `X-Groove-Rev` também no 304, no `PUT`, no `DELETE` e na lápide (listas e
feed seguem com a revisão **por registro no corpo**, sem cabeçalho singular). Blobs: `PUT`
confere o sha no fluxo (hash errado → 400, nada gravado), reenvio → 200 `created:false`, `HEAD`
com `Accept-Ranges`/`ETag`, `Range: bytes=0-99` → 206 com `Content-Range`, faixa insatisfazível
→ 416, tipo e disposição vêm da **assinatura** (PDF e áudio `inline`, HTML/desconhecido viram
anexo opaco com CSP `sandbox`), `DELETE` libera o espaço.

### Critério 22 e consertos de fronteira — backup autocontido, tetos e estado ausente

O backup diário é NDJSON gzip v2 **autocontido** (leva os bytes de cada blob em pedaços de até
1 MiB, além de documentos e privados), com `header` e `footer` conferidos, mantendo os 14 mais
novos; a rotação plantando 20 diários antigos + um novo manteve exatamente 14. A restauração por
CLI exige o servidor parado, valida tudo antes de tocar no estado, grava
`backups/pre-restore-*.ndjson.gz` (completo), repõe os blobs apagados, transforma em lápide o
que nasceu depois, preserva blob vivo fora do arquivo e dá **revisões novas** aos documentos
(o feed anuncia a restauração). Consertos de fronteira desta etapa:

- `POST /api/courses/convert`: `map` e `catalog` são medidos **antes** de qualquer gravação de
  privado — acima de 16 MiB (o teto de registro, não o do envelope de 32 MiB) → 413 e o privado
  anterior fica byte a byte intacto (um pedido com `map` pequeno e catálogo grande **não** grava
  o mapa);
- o escritor do backup recusa (`backup_invalid`) uma linha acima de
  `MAX_LINE_BYTES = MAX_RECORD_BYTES (16 MiB) + 512`, então ele nunca emite um arquivo que o
  leitor recusaria (o leitor recusava linhas > 32 MiB e o escritor não conferia);
- `state.json` ausente **com documentos ou privados no disco** → recusa subir (`state_corrupt`)
  sem criar lock, sem sintetizar estado e sem apagar nada;
- `PUT` de blob em fluxo (`Transfer-Encoding: chunked`, sem `Content-Length`) reserva o teto
  inteiro antes de gravar (507 honesto em vez de furar `GROOVE_MIN_FREE_BYTES`);
- os fallbacks 400/404 do app passam a sair com o mesmo conjunto de cabeçalhos de segurança do
  estático (uma só CSP em `staticSecurityHeaders({hsts})`).

Ajuste de integração (marcador de estado): `hasStoredData` conta **objetos e privados**, não
blobs. Blob é endereçado por conteúdo, não entra no manifesto e nunca é coletado; um data dir
que só recebeu blobs (upload antes do primeiro commit) é legítimo, então continua subindo — só
documentos ou privados órfãos caracterizam manifesto perdido. Regressão em
`tests/server-crash.test.js` (só blob → sobe e o blob continua servido).

### Smoke HTTP real (dados fictícios em diretório temporário, fora do repositório)

Servidor de verdade em processos filhos, 90 verificações, 90 aprovadas:

| Grupo | Verificações |
| --- | --- |
| subida e recusas (modos, host, data dir, marcador, só-blob) | 12 |
| `dev`: cabeçalhos/segurança, Host/proxy/origem, docs/ETag/`X-Groove-Rev`/412/428/405/413/415, cursor, travessia | 27 |
| blobs: bytes, `HEAD`, `Range`/416, assinatura, CSP, auth, `DELETE` | 10 |
| privados (`map`/`catalog`) e convert (413 de 16 MiB, 409) | 7 |
| backup: criação diária, rotação para 14, NDJSON v2 com bytes de blob, privado | 7 |
| restauração: dry-run, pre-restore, lápide, blob do backup reposto, blob vivo preservado, data dir vazio | 11 |
| `tailscale`: 401/400/200, `Host` loopback e alheio, `Origin` correto/ausente/alheio, HSTS, blob/privado/backup sem identidade | 12 |
| estático sem data dir: `/api` 404, app 200, escrita 405, 404 do app com cabeçalhos | 4 |

Conferido também: nenhuma resposta de erro cita caminho, login ou corpo; a saída do CLI de
restauração só traz contagens; o log do servidor traz `api <MÉTODO> <rota-modelo> <status> <ms>`,
sem id, login, IP nem corpo.

### Interface publicada para as próximas etapas

- `receiveBlob(request, { tmpDir, maxBytes, reserveSpace })` — o gancho que a etapa 8 (intake)
  reusa para reservar espaço antes de gravar;
- `store.reserveSpace(bytes)` → `release()`, contando reservas em voo;
- `server/backup.js` exporta `MAX_RECORD_BYTES`, `RECORD_OVERHEAD_BYTES` e `MAX_LINE_BYTES`;
- `server/http.js` exporta `staticSecurityHeaders({ hsts })`;
- `api.LIMITS.course/private = MAX_RECORD_BYTES` (16 MiB), fonte única com o backup;
- `X-Groove-Rev` no documento individual (o adaptador da etapa 7 já prefere esse cabeçalho).

### Privacidade

Nenhum identificador de curso ou de infraestrutura nos arquivos desta etapa: o smoke usa
`usuario@example.org`, `https://groove.exemplo.ts.net` e fixtures fictícios em diretório
temporário; a auditoria dos arquivos preparados (`local/round6-private-audit.json`) saiu com
0 ocorrências.

