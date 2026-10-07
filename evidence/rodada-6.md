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
| 6 — servidor e segurança | `c302592` | 1146 (1145 passam, 1 ignorado) | 234 módulos |
| 7 — sincronização no app | `d2e42f3` | 1222 (1220 passam, 2 ignorados) | 253 módulos |
| 8 — conteúdo do curso no app e barreiras | `580223d` | 1347 (1345 passam, 2 ignorados) | 276 módulos |
| 9 — deploy no Pi, HTTPS e contexto seguro | `cf83473` | 1355 (1353 passam, 2 ignorados) | 277 módulos |
| 10 — integração final, UI nativa, auditoria e publicação | (esta etapa) | 1359 (1357 passam, 2 ignorados) | 277 módulos |

O teste ignorado é o de amostra física da rodada 1 (`physical sample`), ignorado por desenho.

### Critérios das etapas 1–3 (Trilha A) — provas preservadas

Observadas nas etapas 1–3 e ainda válidas na pilha final (nenhuma etapa posterior mudou o motor,
os limites nem o conversor nesses pontos).

- **Critério 1 — sessão de 128 compassos (criar, editar, tocar, treinar, exportar e reimportar).**
  A fixture pública `tests/fixtures/session-128-bars.json` (128 compassos, 128 acordes C/Am/F/G)
  abre, edita, exporta e reimporta pelo arquivo e pelo link. Tocar a sessão inteira levou **101,8 s**
  e treiná-la **102,9 s** no navegador próprio, sem perder nota nem compasso. `MAX_BARS` e
  `MAX_CHORDS` passaram a 128 (`src/model.js`, `src/session.js`); 129 compassos são recusados
  ("1 a 128 compassos"). O teto aparece no Estúdio, na partitura (32 sistemas), no treino, no
  resultado, na exportação e no link.
- **Critério 2 — arpejo T-3-5 pelo ciclo de quartas, tríades maiores, 2 compassos por acorde, com
  acorde final.** **25 compassos**, **37 notas**; ritmo "semínima, semínima, mínima | mínima ligada,
  pausa de mínima" (o padrão `q q h | h(lig) pausa_h`) e cada acorde na posição mais grave em que
  a forma cabe nas casas 1–12.
- **Critério 3 — linha contínua de 4 notas na região 1–5, ciclo de quartas, 1 compasso por acorde.**
  **13 compassos**, **49 notas**; toda transição obedece à regra da próxima nota do acorde vigente
  na direção do movimento, com inversão na borda da região (2.208 de 2.208 transições conferidas no
  catálogo real).
- **Critério 5 — "até fechar o período".** Termina quando o estado (nota inicial e direção) se
  repete no começo de uma volta. Uma volta inteira cabe no teto: **120 compassos e 480 notas**;
  o que passaria de 128 vira aviso em vez de truncar (`shortTotal = !capped && …` em
  `src/study-generator.js`).
- **Critério 6 — a mesma receita em 5 cordas.** A corda **Si** entra como a mais grave, a região é
  mantida e o autor aumenta os compassos por acorde em vez de truncar (exercícios de até 97
  compassos nas versões de 5 cordas).
- **Critério 7 — formas.** Criar uma forma no Braço (qualidade, ordem dos graus, notas clicadas,
  nome), usá-la no gerador e vê-la no painel "Braço" sobre o acorde atual; uma forma de 4 cordas
  reaparece no baixo de 5, deslocada para a corda Si quando cabe. "Gerar variação" cria um
  exercício **novo** ligado ao original e o original fica **byte a byte igual**; "Nas 12
  tonalidades" cria as outras 11 agrupadas. As três formas de exemplo (maior, menor, oitava) são
  genéricas, sem associação a curso.
- **Critério 13 — conferência privada do catálogo real.** `scripts/check-study-generator.js` sobre
  o catálogo real (`local/`): **321 de 335** receitas são geráveis e **14** ficam manuais — 8 por
  cifra provisória (placeholder) e 6 por regra ausente. O conferidor cobre os **335**: **216
  limpos**, **113 divergentes** e **6 inverificáveis**; **204** comparações de grau ficam como
  informação (a forma única não alega casas/cordas sem uma forma vinculada). A evidência guarda só
  contagens por família e motivo, nunca títulos nem nomes de arquivo.

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

### Critério 14 — Praticar e Assistir independentes (navegador próprio, 1440×900) — etapa 10

Prova de UI feita na etapa 10 (preparação) sobre a prévia estática da etapa 5, aba própria no
Chromium do pai (CDP 9532, `127.0.0.1:5404`), curso fictício `Curso de Reparos`:

- **antes de assistir**: `Praticar` com `1 item(ns) · ≈ 0 min de 20 min orçados · 1 avulso(s) na
  folga` (nenhum exercício de curso) e `Assistir (opcional)` com `3 aula(s) cabem em 20 min` e as três
  aulas listadas — duas partes na mesma tela, com orçamentos e ações separados;
- **assistindo três aulas** pela própria tela (caixa **Assistida** nas aulas `0`, `25` e `26`):
  `Praticar` passou a `3 item(ns)` (os dois vínculos da aula `0` + o avulso) com as ofertas
  `Gerar os 2 sugeridos de “Aula com identificador zero”` / `… vinte e cinco`, e `Assistir` ficou em
  `Nenhuma aula pendente cabe neste tempo.`;
- **fila do dia**: `Usar a prática na fila` → `Fila de hoje: 3 item(ns) · meta 15 min`;
- **dia seguinte** (relógio da página em 2026-10-07, data real 2026-10-06, conferido por
  `CDP Runtime.evaluate`): a fila continuou e `Praticar` passou a `4 item(ns)`, incluindo o exercício
  gerado a partir de uma das aulas assistidas no dia anterior (`Movimento grave–agudo–grave · C
  maior`), confirmando que assistir alimenta a prática dos dias seguintes.

Detalhes, comandos e limites: `local://round6-final-A-proof.md` §4.

### Critério 11 — reimportação com ids novos (navegador próprio, 1440×900) — etapa 10

Prova de UI feita na etapa 10 (preparação), mesmo ambiente do critério 14, com a saída **real** do
conversor (`tests/fixtures/course/map-repairs.json` + `catalog-example.json`) e uma variante de ids
derivados do título do mesmo curso. Antes da reimportação a aula `0` tinha `watched: true`, a
anotação fictícia, dois vínculos, a sugestão gerada (`generatedSuggestionIds: ["cat-exemplo-1"]`) e um
anexo criado pela própria tela (PDF fictício de 614 B na linha `apostila-reparos-4-cordas.pdf`).

- reimportar com **ids antigos** e voltar aos **ids numéricos** preservou tudo nas duas direções —
  estado por aula, anotação, os mesmos ids de vínculo, a sugestão já gerada e a referência do anexo
  (mesma chave de arquivo, mesmo `sha256` e mesmo tamanho), com o aviso
  `2 aula(s) com estado preservado … 1 anexo(s) realinhado(s)`;
- a aula com `url` foi reconhecida **pela URL**: com o título trocado na variante antiga, o estado
  dela seguiu mesmo assim;
- **sugestões geradas**: o id da sugestão vem do id da entrada do catálogo
  (`slug(catalogId)`, único dentro da aula) e não do id da aula; o conversor real produziu ids
  idênticos em duas execuções e a tela continuou mostrando `já gerado` e `Gerar todos (2)` depois de
  reimportar com ids de aula diferentes — nenhuma sugestão já gerada voltou como nova.

Detalhes, tabelas de estado e o único limite observado (o marcador é por id de sugestão; trocar o
**arquivo de catálogo** troca o id e o `catalog.id` do curso): `local://round6-final-A-proof.md` §2.
Nenhum defeito foi encontrado: nenhuma fonte foi alterada nesta prova.

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

## Etapa 7 — sincronização no app (B4)

Módulos novos: `src/server-client.js`, `src/sync-outbox.js`, `src/sync-store.js`,
`src/sync-adapters.js`, `src/sync-engine.js`, `src/sync-status.js`, `src/sync-wire.js`,
`src/course-convert-server.js`, `src/app-services.js` e `src/sync.css`. Patches cirúrgicos em
`src/exercise-library.js` (entradas + aplicação/remoção remotas), `src/course-attachments.js`
(referência com `size`/`kind`, adoção sem bytes e liberação), `src/today-store.js` +
`src/today-view.js` (loja compartilhada), `src/course-view.js` (gancho da conversão),
`src/main.js` (três linhas trocadas, ainda 530 linhas), `index.html` (`sync.css` e
`data-groove-server="off"`), `server/static.js` + `server/app.js` (marcador com data dir) e
`sw.js` (`/api/` fora do Cache Storage).

Oito coleções: `exercises`, `courses`, `courseStates`, `courseAttachments`, `todayQueues`,
`routines`, `forms` (`shapes` e `bindings`) e `preferences` (allowlist explícito). Duas
superfícies: uma linha em "Ajuda e app" (sempre) e um indicador no cabeçalho só com problema.

### Defeitos reais encontrados ao exercitar (corrigidos nesta etapa)

1. **A varredura de remoção apagava o documento vizinho da MESMA coleção.** `forms` tem dois
   documentos com donos distintos (`shapes`, `bindings`) em portos separados; a varredura de
   cada porto percorria todas as revisões da coleção, e o documento que o outro porto listava
   não estava no `seen` dele — o resultado era `PUT` dos dois seguido de `DELETE` dos dois. A
   varredura agora respeita `owns(id)` (regressão: "varredura normal não apaga o documento
   vizinho da MESMA coleção", que falha sem o conserto).
2. **Documento que subia para sempre.** O documento carregava id e carimbos de tempo de CADA
   navegador (id/`createdAt`/`updatedAt` da fila, id/carimbos da rotina, `createdAt`/
   `updatedAt` do estado do curso e de cada aula) e a fusão reescrevia os locais, então o mesmo
   conteúdo virava bytes diferentes nas duas máquinas: cada ciclo subia três documentos novos
   (`courseStates`, `todayQueues`, `routines`), sem nenhuma mudança de conteúdo. O documento
   passou a levar só o conteúdo portátil (itens da fila; nome + itens da rotina; progresso,
   lápides, intervalos, aula ativa e preferências do estado do curso). Medido no navegador:
   com o defeito, quatro sincronizações somavam 12 revisões novas; corrigido, a revisão do
   servidor não muda mais entre ciclos. Regressões: "dois navegadores convergem" (motor, com
   a loja de Hoje de verdade) e "o documento do outro navegador não muda os nossos bytes"
   (adaptadores).
3. **Anexo com os mesmos bytes nunca convergia.** Com o mesmo `sha256` dos dois lados, a
   aplicação não fazia nada (`existing && localFileSha(...) === entry.sha256 → continue`) e o
   `addedAt` de cada máquina ficava diferente: o documento de anexos subia a cada ciclo. Agora,
   quando os bytes são os mesmos, os campos do documento (nome, tipo, tamanho, `addedAt`) são
   adotados do servidor — sem baixar nem liberar bytes (regressão própria).

### Critério 18 — servidor vazio → envio; dois lados → mesclagem sem perda

Dois perfis de navegador independentes (Chromium próprio, TLS de teste confiado, sem
`ignore-certificate-errors`), servidor de verdade em loopback com identidade fictícia.
Primeira conexão com dados locais e servidor vazio: a oferta é só "Enviar meus dados para o
servidor" + "Agora não" e **nada sobe sem consentimento**; aceito, o servidor recebe as oito
coleções (11 documentos, incluindo o blob do anexo por hash, `HEAD` 404 → `PUT` 201). No
segundo perfil: oferta de mesclagem, fusão sem perda (os dois lados ficam com o mesmo
conteúdo; o exercício criado só no segundo perfil sobe) e nenhum conflito espúrio.

### Critério 19 — fila offline, recarga no meio e volta

Rede cortada no segundo perfil (`offline`), edição de exercício (BPM 100 → 90): a operação
entra na fila durável (`groovegoblin.sync.outbox.v1`), a linha diz "Servidor: sem conexão" e a
edição **sobrevive à recarga** com a fila intacta. Ao voltar a rede, "Sincronizar agora" drena
a fila e o servidor passa a ter o BPM 90 (revisão nova); a fila volta a zero.

### Critério 17 — 412 com as duas escolhas e cópias baixáveis

Duas direções, exercitadas nos dois perfis: (a) o segundo perfil grava e escolhe "Ficar com
esta" — a versão dele sobe e a do servidor fica nas cópias; (b) o primeiro perfil grava e
escolhe "Ficar com a do servidor" — a do servidor fica e a dele vai para as cópias. Nos dois
casos o painel mostra "1 conflito para resolver" com as duas ações, e a versão descartada
continua guardada (conferida no estado: `recovered` com o corpo descartado), disponível em
"Baixar cópias guardadas".

### Critério 20 — anexo por hash, ida e volta e liberação

O PDF fictício (193 B) sobe por `HEAD` + `PUT /api/blobs/:sha256` e o arquivo no servidor tem
exatamente o `sha256` do arquivo local. Marcado "manter offline", os bytes **ficam** no
navegador mesmo depois da confirmação; ao deixar de manter offline e sincronizar, os bytes
locais são liberados e a referência continua no documento com nome, tipo e tamanho (o
documento de anexos não muda ao liberar).

### Critério 21 — conversão no servidor com mapa e catálogo fictícios

No segundo perfil, mapa + catálogo fictícios vão para a área privada do servidor (nada é
publicado); o id já existe, então a resposta é 409 e a interface oferece "Atualizar o curso
existente". Confirmando, a estrutura é atualizada com `expectedRev` e o progresso local
(`lesson-1` assistida) é preservado.

### Critério 15 — sem servidor

Página servida por um servidor estático comum (sem backend, marcador `off`): **zero**
requisições a `/api/`, console limpo e a única linha é "Sem servidor (dados só neste
navegador)". O site estático e o GitHub Pages continuam funcionando como antes.

### Verificação executada

- `npm test` na etapa: **1222 testes, 1220 passam, 0 falham, 2 ignorados** (amostra física e o
  teste contra o servidor real, que roda por flag).
- `npm run check`: **253 módulos, 0 falhas**.
- `GROOVE_SYNC_REAL_SERVER=1 node --test tests/sync-real-server.test.js`: **1/1 passa** contra o
  servidor de verdade (saúde, `PUT` 201, 412, `GET`/304, feed, blob por hash ida e volta,
  conversão gravando `groovegoblin-course`).
- Navegador (dois perfis, dados fictícios, 1440×900 e 1280×800): capturas em
  `evidence/sync-1440x900.png` e `evidence/sync-1280x800.png`.

### Interface publicada para as próximas etapas

- Chave de host `serverImport` (função que devolve nós) de `appImportNodes` em
  `src/app-services.js` → host da Biblioteca → `course-view` (a etapa 8 liga o painel de
  material, que esta etapa não abre).
- `index.html` mantém `data-groove-server="off"` e o `<link>` de `src/sync.css`; o servidor só
  troca o marcador para `on` com data dir (`SERVER_MARKER_ATTR` em `src/sync-engine.js`).
- `courseAttachments/<courseId>` = `{ refs: { "<refKey>": { sha256, size, kind, name, addedAt } } }`;
  os bytes vivem só em `/api/blobs/:sha256`. `receiveBlob(request, { reserveSpace })` continua
  sendo a interface de reserva.
- `preferences/default`: só `practice.{objective,routine}` e `transport.{countInBars,accelerator}`.
- `forms`: dois documentos com donos distintos (`shapes`, `bindings`); a lápide remota nunca
  apaga formas/vínculos locais.
- Documentos sincronizados levam **conteúdo portátil**: fila = itens; rotinas = nome + itens;
  estado do curso = progresso/lápides/intervalos/aula ativa/preferências, **sem** os carimbos de
  tempo locais. Qualquer coleção nova que carregue id/carimbo do navegador no corpo volta a
  subir a cada ciclo — a regressão "dois navegadores convergem" cobre isso.

### Privacidade

Perfis e fixtures só com dados fictícios (`example.invalid`, `groove.exemplo.ts.net`,
`usuario@example.org`, o curso de exemplo do repositório e um PDF de 193 B). Nenhum
identificador real de curso ou de infraestrutura: a auditoria privada desta etapa saiu com 0
ocorrências e nada de `local/` foi para o commit.

## Etapa 8 — conteúdo do curso no app e barreiras contra vazamento (B4b/B6)

Servidor local fictício (`GROOVE_DATA_DIR` fora do repositório, modo `dev` em `127.0.0.1`),
curso **fictício** criado por mim (`example.invalid`) e material **autogerado** (PDFs próprios,
MP3 sintetizado com ffmpeg, ZIP com PDF dentro). Nenhum dado real de curso foi usado, lido ou
impresso; nenhum perfil de navegador do usuário foi tocado (Chromium próprio, perfil novo).

### Critério 23b — pasta de entrada, casamento e relatório

Curso importado pela própria interface no fluxo "Converter no servidor" (mapa + catálogo
fictícios). Pasta `entrada/<id>/` com **5 arquivos**: as duas apostilas fictícias, uma **cópia
renomeada** da primeira (`Apostila Exemplo 4 Cordas (1).PDF`), a faixa MP3 e um `nao casado.pdf`
distinto. Resultado observado na página do curso:

- **"3 de 3 materiais disponíveis"**; "Pasta de entrada: 5 arquivo(s), 42 KB"; **Faltando (0)**;
  **Não casaram (1)**: `nao casado.pdf` (`reason: no-material`).
- **Deduplicação por conteúdo:** as duas cópias da mesma apostila (nome e caixa diferentes)
  viraram **um** blob — o diretório de dados ficou com exatamente 3 blobs (`0dae5563…`,
  `d03f0cc8…`, `e417a8db…`), um por conteúdo, e 3 vínculos.
- O relatório é leitura (`GET`); casar a pasta e gravar vínculos é escrita da própria origem
  (`POST .../materials/scan`) — a cola HTTP cobre o 403 sem `Origin`/cross-site.

### Critério 23c — apostila e faixa dentro do app

- **Catálogo aponta a SEGUNDA apostila:** a sugestão da aula tem `pdfPage: 3` e
  `material.names = ["Apostila Exemplo 5 Cordas.pdf", …]` com `resourceId` do **segundo** PDF.
  Clicar em **"Ver na apostila (página 3)"** abriu o painel único com
  `/api/blobs/d03f0cc891992d0b82a388b6d23ab740c4530dfaf57535cdb5468feae61fbdac#page=3`
  (`application/pdf`) — o **segundo** PDF, **não** o primeiro nem "sem página"; o visualizador
  nativo do Chromium renderizou o documento dentro do app (captura conferida).
- **UM painel só:** em todo o percurso existe **um** `<iframe>`; a página da aula usa a mesma
  instância do Estúdio/Biblioteca.
- **Exercício gerado:** "Gerar" (com a forma escolhida no diálogo) criou o exercício com
  `metadata.courseContent: true` e
  `metadata.study.origin.material = { name: "Apostila Exemplo 5 Cordas.pdf", lessonId: "1",
  resourceId: "apostila-exemplo-5-cordas-pdf", page: 3 }` (25 compassos, 37 notas).
- **Recarga DIRETA no Estúdio:** sem visitar Cursos antes, a linha de origem já mostra
  "Ver na apostila (página 3)"; clicar abre o **mesmo** PDF e a **mesma** página. A linha da
  **Biblioteca** mostra a mesma ação e abre o mesmo material.
- **Vídeo:** zero `<video>` e nenhuma requisição de vídeo; a aula mantém só o link externo.
- **Faixa com `Range`:** `Range: bytes=100-599` → **206**, `Content-Range: bytes 100-599/36720`,
  `Accept-Ranges: bytes`, `audio/mpeg`, e os 500 bytes conferem byte a byte com o arquivo
  completo; no player, `duration` 3 s e `currentTime` avançando (1,377 s em 1,5 s reais).
- **Repouso:** Biblioteca em 1440×900 com **22** controles visíveis e **sem rolagem** vertical
  (o grupo novo do material é um único `<details>`).

### Uso offline do material (mesmo servidor, rede cortada)

Com **todas** as chamadas `/api/*` abortadas e a página recarregada (servidor configurado, mas
inalcançável):

- as ações novas do servidor **não aparecem**: os três nós "Ver na apostila" nascem escondidos e
  um deles (a sugestão da aula) precisou do mesmo portão dos outros — corrigido nesta etapa
  (`gateServerNode` em `course-lesson.js`);
- os **anexos manuais salvos** continuam e funcionam **offline**: o PDF abriu de um `blob:` com o
  aviso "PDF aberto em nova aba a partir da cópia salva neste navegador (funciona offline)" e a
  faixa tocou do `blob:` (`currentTime` 1,465 s de 3 s, `readyState` 4);
- "Anexos guardados neste navegador: **2 arquivo(s), 37,8 kB**";
- **zero** requisições a `/api/blob`: só **2** sondagens `/api/health`, e a linha de estado diz
  "Sem servidor (dados só neste navegador)".

### Critério 23d — saídas compartilháveis sem conteúdo de curso

- **Exportar exercício** (exercício vinculado à aula, baixado de verdade no navegador):
  `estudo-musical.json`, `id` genérico `public-exercise`, **sem** o título da aula, **sem** o nome
  do arquivo de material e **sem** o bloco `study` — a música sai inteira.
- Provas de unidade com canário próprio cobrem o resto da família: link de compartilhamento,
  MIDI da sessão, pacote de tarefa, histórico (nome genérico, treinos intactos), `exportLibrary`
  padrão e o retrato privado levando tudo; e a **cópia em conflito da sincronização** só sai pela
  convenção privada (nome `PRIVADO` + confirmação nativa, cancelar ⇒ **0** arquivos, bytes
  **idênticos**), agora num teste de consumidor com motor real e servidor de contrato real.
- **Marca pegajosa no caminho NOVO do sync:** `applyRemoteEntry` não rebaixa
  `courseContent: true` quando o documento remoto é antigo/sem marca, e o vínculo
  `origin.material` sobrevive à aplicação remota (mesma origem) — canário próprio.

### Critério 23e — build e blobs

- `npm run build` com um **PDF plantado** em `dist/`: **falha** (exit 1), com o arquivo
  **preservado**; o mesmo vale para **symlink** apontando para `local/` e para **áudio renomeado**
  com nome licenciado. Build limpo: "Static site built in dist/; public-content boundary
  verified", e `dist/` sem nenhum PDF/MP3/ZIP — só os **três** WAV CC0 de bateria já licenciados.
- Os blobs de curso vivem **só** no diretório de dados e saem apenas por `/api/blobs/:sha256`
  (tipo conferido por assinatura, `Cache-Control: private, no-store`); nenhum deles existe na
  árvore estática. No modo `tailscale` a rota exige identidade (coberto na etapa 6).

### Critério 23f — gancho de `pre-commit` (invocação real)

Repositório **descartável** com o gancho e o guarda reais e a **lista real** de termos copiada
(nunca impressa): um commit com `dist/evil.pdf` novo, `local/foo.txt` e uma linha contendo um
termo da lista foi **recusado** (exit 1) apontando `dist/evil.pdf`:1 `material-novo`,
`local/foo.txt`:1 `caminho-privado`, `local/termos-privados.txt`:1 `caminho-privado` e
`src/sample.js`:2 `termo-privado` — e a saída **não continha nenhum dos 11 termos** (conferência
termo a termo no próprio processo). A mensagem final: "Nenhum termo ou trecho foi exibido."

### PDF de dentro do pacote (`fontes[].arquivo_interno`)

Fatia `R6ZipCatalogOrigins` (relatório em `local://round6-zip-catalog-origins.md`): o PDF de
dentro do ZIP agora é lido **primeiro** e vira, quando não existe, um **material canônico de
apóstila** (`role: apostila`, extensão `pdf`, id único) com vínculo na aula — o mesmo PDF citado
por várias aulas vira **um** recurso com vários vínculos. No curso real: **45 citações → 30
recursos canônicos**, `counts.catalog.materials = 30`, **335/335** sugestões com
`material.resourceId` (278 com página), conversão `valid` sem problemas e **0** avisos citando
`arquivo_interno`. No curso **fictício** desta etapa: o conversor criou
`Apostila Interna Exemplo.pdf` (`role: apostila`), ligou o `resourceRefs` da aula ao PDF e a
sugestão saiu com `material.names = ["Apostila Interna Exemplo.pdf", "Pacote Exemplo.zip"]`,
`resourceId` do PDF e `pdfPage: 2`. A cola de entrada não precisou de patch: o índice do servidor
indexa todo `lesson.resources[]` e casa membro a membro (teste com ZIP de bytes reais na fatia).

### Defeitos reais corrigidos nesta etapa

1. **Portão do servidor faltando na sugestão da aula.** Com a rede cortada, "Ver na apostila
   (página 3)" continuava **visível** e prometia o painel do servidor; agora a ação nasce
   escondida e se mostra quando a sondagem responde (`gateServerNode`), como no Estúdio e na
   Biblioteca.
2. **Loja de Hoje única vazando entre casos de teste.** Depois do FF da etapa 7, `mountToday`
   passou a usar `sharedTodayStore()`; os testes de saída privada do Hoje precisavam de
   `resetSharedTodayStore()` por caso (senão o status/bytes do caso anterior vazavam).
3. **Documento remoto rebaixando a marca.** `applyRemoteEntry` (caminho NOVO da etapa 7) agora
   preserva `courseContent: true` anterior e o `origin.material` da mesma origem — sem isso, um
   documento antigo vindo do servidor transformava o exercício privado em cópia pública.
4. **Cópias cruas da sincronização.** "Baixar cópias guardadas" (conflitos e recuperação) saía
   cru, sem marca e sem confirmação; passou pela convenção privada (`PRIVADO` + confirmação
   nativa, cancelar ⇒ 0 arquivos, bytes intactos).

### Verificação executada

- `npm test` na etapa: **1347 testes, 1345 passam, 0 falham, 2 ignorados**
  (amostra física e o teste contra o servidor real, que roda por flag).
- `npm run check`: **276 módulos, 0 falhas**.
- `npm run build` (limpo e com venenos plantados): observado acima.
- `GROOVE_SYNC_REAL_SERVER=1 node --test tests/sync-real-server.test.js`: 1/1 contra o servidor
  real (rodado na etapa 7 e mantido).
- Navegador próprio (Chromium novo, perfil novo, 1440×900) com dados fictícios; servidor de teste
  em `127.0.0.1` com `GROOVE_DATA_DIR` fora do repositório.

### Privacidade

Curso, materiais, mapa e catálogo **fictícios** (`example.invalid`, PDFs/MP3/ZIP autogerados);
nenhum identificador real de curso, host, IP, login ou token em arquivo, teste, evidência ou
mensagem de commit. A auditoria privada desta etapa saiu com **0 ocorrências** e nada de `local/`
foi para o commit.

## Etapa 9 — deploy no Pi, HTTPS obrigatório e contexto seguro (B5, 23a)

Duas entregas: o `deploy/` (o que publica o serviço no Pi dentro da tailnet) e o
aviso global de contexto inseguro que o critério 23a pede — mais o conserto de um
defeito real que só aparecia no servidor de verdade (SRI × marcador da página).

A **instalação real no Pi** acontece depois da publicação desta etapa; os números
observados lá (serviço ativo, `/api/health` na máquina e pelo endereço da tailnet,
configuração de `serve` preservada) entram na evidência da etapa 10.

### Critério 23a — HTTPS com confiança real (observado em navegador próprio)

Servidor de teste com certificado de teste **confiado de verdade** (CA própria,
sem `--ignore-certificate-errors`, sem `--allow-insecure-localhost`), página
servida por um proxy TLS em `https://localhost:5461`, dados fictícios fora do
repositório:

| Verificação | Observado |
| --- | --- |
| Confiança real | documento `securityState="secure"`, status 200, `remoteIP=127.0.0.1`, sem falha de carregamento, sem erro de console, sem interstitial |
| Contexto seguro | `window.isSecureContext === true`; app montado |
| `navigator.mediaDevices` | existe (`getUserMedia`, `enumerateDevices`); `AudioWorkletNode` é função |
| Uso offline | clique real em "Preparar uso offline" → worker `activated`, escopo `https://localhost:5461/`, `controller=true`, 160 recursos em cache |
| Instrumento | "Ativar instrumento" abre faixa viva (`readyState=live`, 1 faixa de áudio, 44,1 kHz); medidor do próprio app em 30–34% |
| Áudio de verdade | analisador independente mede RMS ≈ 0,317 (não é só um objeto) |
| Saída normal | sair de Praticar encerra a captura e volta para teclado |
| Aviso de contexto inseguro | **ausente** no HTTPS (correto) |
| Captura | `evidence/rodada-6/secure-context-https-localhost-5461-instrumento.png` |

### Critério 23a — HTTP por IP reservado: aviso claro e persistente

O mesmo app servido em `http://192.0.2.1:5462` (IP reservado TEST-NET-1, sem
HTTPS):

| Verificação | Observado |
| --- | --- |
| Transporte honesto | `securityState="insecure"`; `isSecureContext === false`; sem `serviceWorker`, sem `mediaDevices`, sem `crypto.subtle` |
| Aviso global | `section.notice` filho de `#studio-notices`, visível, com o texto: "Instrumento e uso offline exigem HTTPS. Abra o endereço HTTPS do Tailscale Serve." |
| Mesma frase no menu | "Ajuda e app → Offline" traz a mesma frase; "Preparar uso offline" fica escondido |
| Persistência | o mesmo nó sobrevive a troca de atividade e de BPM/sessão |
| Console | zero erros de JavaScript |
| Captura | `evidence/rodada-6/secure-context-http-ip-192-0-2-1-5462.png` |

O aviso vive em `src/offline.js` e vale para o app inteiro (não depende de painel
aberto) — nenhuma mudança de fonte foi necessária para ele sobreviver aos
renders.

### Defeito real corrigido: o uso offline não fechava no servidor de verdade

**Sintoma**: com a API ligada, "Preparar uso offline" terminava em "Não foi
possível preparar esta versão…" e o worker virava `redundant` (nenhum registro).
**Causa**: o servidor entrega o `index.html` com o marcador `data-groove-server`
trocado (`off` → `on`), mas a lista offline publicada descrevia os bytes do disco;
o service worker instala com SRI e a verificação daquele arquivo não fechava, o
que derrubava a instalação inteira. **Conserto** (sem afrouxar o SRI de nenhum
recurso): a lista entregue passa a descrever os bytes entregues — `server/static.js`
recalcula a integridade do `index.html` sobre a página já marcada (e ajusta os
bytes), com `sriHash` exportado por `scripts/asset-manifest.js`; a revisão
continua sendo a do build, que é a que o `sw.js` embute. Teste de regressão em
`tests/server-static.test.js` confere a integridade de **todos** os arquivos da
lista contra o que o servidor entrega, nos dois modos (raiz do projeto e `dist`):
**6 de 7 falham** contra o código anterior, **7/7** depois do conserto.

### `deploy/` — o que a etapa entrega

| Arquivo | Papel |
| --- | --- |
| `deploy/groovegoblin.service` | unidade systemd: usuário dedicado sem privilégio, escuta em `127.0.0.1`, `ProtectSystem=strict`, `ReadWritePaths` só do diretório de dados, `MemoryMax`, caminho absoluto do Node |
| `deploy/groove.env.example` | ambiente de exemplo, só valores fictícios |
| `deploy/install.sh` | valida o ambiente (parser literal, sem `source`), cria usuário e diretório de dados `0700`, constrói, instala e habilita a unidade, espera o `/api/health` e publica no `tailscale serve` |
| `deploy/update.sh` | busca o código, constrói, roda os testes, reinicia, confere o health e reverte o que mudou se algo falhar |
| `deploy/restore.sh` | restauração a partir de um instantâneo (o trabalho de verdade é do próprio servidor) |
| `deploy/README.md` | do zero ao app em HTTPS, pasta de entrada dos cursos, restauração, convivência com outros serviços no mesmo Pi e o que mudaria fora da tailnet |
| `deploy/hooks/pre-commit` | gancho da etapa 8 |

**Convivência no mesmo Pi**: o `install.sh` lê a configuração atual do `serve` e
**só adiciona** a porta HTTPS pedida quando ela está livre. Se a porta pedida já
for de outro serviço, ele para sem publicar; se não conseguir ler a configuração,
não publica às cegas; depois de publicar, confere que tudo que já existia continua
igual e, se algo tiver sumido, restaura as entradas antigas e para com aviso.
Essas decisões são cobertas por `tests/deploy-serve.test.js`: 7 casos que rodam a
função real com uma CLI falsa do `tailscale` (sem rede e sem tocar no `serve`
desta máquina).

### Verificação executada

- `npm test` nesta etapa: **1355 testes, 1353 passam, 0 falham, 2 ignorados**
  (amostra física e o teste contra o servidor real, que roda por flag).
- `npm run check`: **277 módulos, 0 falhas**.
- `node --test tests/deploy-serve.test.js` → **7/7** (6/7 contra a função anterior).
- `node --test tests/server-static.test.js` → **7/7** (6/7 contra o código anterior).
- `bash -n deploy/install.sh` (e `update.sh`/`restore.sh`), `--help` e recusas
  seguras: ambiente ausente, arquivo fora de `CHAVE=valor`, chave desconhecida,
  dono/permissões do arquivo, `--serve-port` fora de faixa, árvore sem `server/`.
- Navegador próprio (Chrome novo, perfis novos) com dados fictícios; certificado
  de teste confiado; nada de `--ignore-certificate-errors`.

### Privacidade

Nada de valor real de infraestrutura (host, IP, login, chave, endereço da
tailnet): os exemplos do `deploy/` são fictícios (`example.invalid`,
`exemplo.ts.net`, `usuario@example.org`) e a evidência usa IP reservado e
`localhost`. O arnês de prova ficou **fora** do repositório: o commit guarda só as
capturas e esta evidência. Auditoria privada desta etapa: **0 ocorrências**.

## Etapa 10 — integração final, UI nativa, auditoria e publicação

Dono: `R6FinalPublish`. WT `/home/mat/code/groovegoblin-round6-final`, branch `feat/round6-finalise`,
base da etapa 9 (`cf83473`). **Um** commit da etapa 10, fast-forward do `main`, checagens no `main`,
push. Nada de emenda em commit empurrado, nada de force.

### Documentação reconciliada (sem seções duplicadas)

`README.md`, `guide.html` e `src/tour.js` foram integrados sobre a pilha final. No README, as **duas**
seções "Servidor pessoal (opcional)" (o panorama preparado e a técnica das etapas 6–8) viraram
**uma**: o panorama abre a seção e o detalhe técnico (Modos/Rotas/Cabeçalhos/Limites/HTTPS/Cópia de
segurança/Privado por desenho) mais as subseções (Sincronização, Conteúdo do curso, Barreiras)
seguem; o título "Dados, privacidade e mídia", que a preparação havia substituído por engano, foi
**restaurado** antes do seu corpo. O guia traz as seções novas `#study` e `#server` e o índice com os
dois itens; o tour cita "Novo estudo"/"Gerar variação" e "Gerar"/Praticar+Assistir, sem passo novo.
**Nenhum atalho de teclado novo** (varredura de `keydown` nas telas novas não achou nenhum; a folha de
atalhos fica como está). `src/main.js` segue com **528 linhas** (≤ 530), a Sessão continua **v5**,
`src/feedback.js` **intocado** na rodada; `src/repertoire*.js` só teve as exceções mínimas de
privacidade de saída da etapa 8 (`repertoire-package.js` +8/−3, `repertoire-view.js` +30/−4), nada além.

### Reparação offline/privacidade integrada (fonte)

Os arquivos deixados sem commit pela etapa 8 (WT privado) entraram nesta pilha: `src/app-services.js`
(adaptador `appPins()` para o motor), `src/library-view.js` (passa `pins`), `src/course-lesson.js`
("Manter offline"/"Deixar de manter offline" na linha do material, correções de perda de referência e
do painel B4b com cópia), `src/course-content.js` (a sonda de `/api/health` respeita o marcador
`data-groove-server`) e os testes `tests/course-content.test.js` + `tests/course-lesson-view.test.js`.
Nenhuma segunda cópia de bytes: o painel/`<audio>` do servidor continua transmitindo com `Range`; a
cópia local só existe quando o usuário marca "Manter offline". As provas nativas desta fatia (pins de
PDF e áudio vindos do servidor com sha local = sha do servidor, PDF/áudio offline por `blob:` com zero
`/api/blob`, unpin nativo **com a rede cortada** preservando nome/tipo/tamanho e a referência do
servidor, reconexão sem exclusão destrutiva) estão em `local://round6-final-media-privacy-proof.md`.

### Provas nativas das fatias externas (mídia, backup e link)

- **Mídia do servidor offline** (`local://round6-final-media-privacy-proof.md`): pins de PDF **e** de
  áudio vindos do servidor (`/api/blobs/<sha>`; sha local = sha do servidor = sha do arquivo em disco),
  painel embutido abrindo dos **bytes locais** (`blob:`) quando a rede cai **sem recarregar** (zero
  `/api`, URL de objeto revogada ao fechar/trocar), PDF e áudio offline por `blob:` após recarga (zero
  `/api/blob`), unpin nativo **com a rede cortada** preservando nome/tipo/tamanho e a referência do
  servidor, reconexão sem exclusão destrutiva. **ZIP pela UI**: conversor → intake do ZIP pela UI →
  relatório "2 de 3 disponíveis / Faltando (1) / Não casaram (1)" → aula abrindo o PDF de DENTRO do
  pacote e exercício gerado abrindo o **segundo** PDF na **página 3** no painel (visual de PDF nativo).
  Defeito real corrigido no painel (usava sempre `/api/blobs/<sha>`, ignorando a cópia local).
- **Backup privado + link público** (`local://round6-backup-share-native-proof.md`): exportação padrão
  (download real) **sem** nenhum canário de curso, sem cursos/anexos/vínculos de rótulo (exercício
  utilizável com notas/BPM/compassos intactos e nome redigido); opt-in privado com diálogo nativo —
  **cancelar ⇒ 0 arquivos**, confirmar ⇒ nome com **PRIVADO** e payload completo; anexos em opt-in
  independente (desmarcados = só totais; marcados = `dataBase64` com sha conferido); restauração pela
  UI em **outro perfil novo** preservando curso, progresso+anotação, vínculo remapeado, forma, vínculo
  de rótulo, anexo (sha igual) e exercício, com a 2ª importação idempotente. Link de exercício
  vinculado: `#share` nativo → URL copiada (clipboard real) → decodificada pelo codec existente: notas
  e parâmetros musicais exatos, bloco `study` ausente e **zero** canários no payload e na URL.
  Observações registradas (não são regressão): o bloco `shapes` (formas **autorais**) não é gated no
  backup público — só o catálogo de curso é omitido; e "Ver na apostila" do card da Biblioteca resolve
  material pelo servidor, avisando para importar os arquivos quando o anexo existe só localmente.

### Correção de consumidor: "Ver na apostila" com a cópia guardada

  A observação da fatia de backup/link foi tratada como **defeito real**: com servidor configurado, o
  botão "Ver na apostila" do card da Biblioteca (e a ação do Estúdio) resolvia o material **só** pelo
  servidor e, para um anexo que existe **apenas** localmente (restaurado de um backup ou marcado
  "manter offline" com a rede fora), respondia "não está no servidor" — descartando bytes disponíveis.
  `src/course-lesson-origins.js` agora consulta a **cópia guardada** para o `refKey` EXATO (a mesma loja
  de anexos compartilhada do app, sem segundo cache nem resolução por semelhança) **antes** da rede e,
  quando existe, abre o painel dos bytes locais (o painel já prefere a cópia). Sem cópia local, o
  caminho do servidor continua igual. A marca estática `off` continua escondendo a ação (contrato do
  B4b). Regressão permanente em `tests/course-lesson-view.test.js` ("abre da CÓPIA GUARDADA quando o
  servidor não tem a referência"), com prova **nativa**: curso e exercício fictícios criados pela UI,
  anexo local no `refKey` exato, `/api` **bloqueado** depois da carga e clique real no botão do card →
  `#material-panel` aberto com o `iframe` em **`blob:`** e o aviso "Abrindo a cópia guardada neste
  navegador (funciona sem servidor)." — captura
  `evidence/rodada-6/stage10-apostila-copia-local.png`.

### Medições de UI na pilha final (dados fictícios)

Chromium próprio (CDP 9546, perfil novo), app servido pelo `dist/` do build real em `127.0.0.1:5480`.
Contagem de controles pelo método das rodadas 4/5 (página inteira, `button,input,select,summary`
visíveis, inclusive desabilitados, excluindo o miolo de `details` fechado; âncoras e caixas de texto à
parte). Curso fictício de 200 aulas e sessão fictícia de 128 compassos importados **pela própria UI**.

| Cena (repouso) | 1440×900 | 1280×800 | Teto |
| --- | --- | --- | --- |
| Estúdio (sessão padrão) | **31** controles · 900 px · sem rolagem | **31** · 800 px | 58 |
| Estúdio (sessão de 128 compassos) | **40** · 900 px · sem rolagem | **40** · 809 px | 58 |
| Treinar | **20** · 900 px · sem rolagem | **20** · 831 px | 30 |
| Biblioteca (com exercícios, paginada) | **17** · 900 px · sem rolagem | **17** · 800 px | 22 |
| Cursos (lista) | **4** fora das linhas de aula | **4** | 30 |
| Página do curso (200 aulas) | **8** fora das linhas (19 linhas montadas) | **8** (19) | 30 |
| Novo estudo (repouso / progressão / figura / forma / região / duração) | **7 / 9 / 9 / 6 / 7 / 9** | idem | 14 |

Em **1440×900** nenhuma cena tem rolagem vertical de página nem transbordamento horizontal; em
**1280×800** só o Estúdio (809 px) e o Treinar (831 px) passam de 800 px — rolagem vertical permitida
nessa largura (o limite de 900 px vale para 1440×900), sempre sem transbordamento horizontal. O
diálogo do gerador tem no máximo **9** controles visíveis nas cenas medidas (o pior caso documentado
na etapa 4, com avisos acionáveis, chega a 14 — dentro do teto). Capturas em `evidence/rodada-6/`:
`stage10-estudio-1440x900.png`, `stage10-estudio-128-1440x900.png`, `stage10-treinar-1440x900.png`,
`stage10-biblioteca-1440x900.png`, `stage10-cursos-1440x900.png`, `stage10-curso-pagina-1440x900.png`,
`stage10-novo-estudo-1440x900.png` e as variantes 1280×800.

### Site estático (marcador `off`)

App servido pelo `dist/` sem diretório de dados (marcador `data-groove-server="off"`), navegando por
Biblioteca/Treinar/Estúdio/Biblioteca: **0** requisições a `/api`, **0** mensagens de console e **0**
exceções. Antes da correção de `src/course-content.js` o mesmo teste mostrava **1** sonda
`/api/health` → 404 e **1** erro de console; o teste de unidade
("página estática (marcador off) não faz NENHUMA requisição a /api") trava o comportamento.

### Contexto seguro (23a) na pilha final

HTTPS com certificado de teste confiado de verdade (CA própria no NSS do perfil, sem
`--ignore-certificate-errors`), `https://localhost:5482/` pelo servidor em modo `tailscale` com o
proxy TLS injetando a identidade: `isSecureContext === true`, `mediaDevices`/`AudioWorkletNode`/
`crypto.subtle` presentes, **sem** interstitial; service worker **ativo** (160 recursos em cache) pelo
clique real em "Preparar uso offline"; o botão nativo "Ativar instrumento" abre `getUserMedia` real
(dispositivo **falso** do Chrome, `label` "Fake Default Audio Input", faixa `live`; RMS ≈ 0,32 no
analisador e medidor do app em 30–34%). **Não há medição de guitarra ou baixo físicos** — é o
dispositivo simulado do navegador alimentado por um WAV do repositório. Aviso de contexto inseguro
**ausente** sob HTTPS. Captura:
`evidence/rodada-6/secure-context-final-https-instrumento.png`. Em **HTTP por IP reservado**
(TEST-NET-1 mapeado para loopback, `remoteIP=127.0.0.1`), `isSecureContext === false`,
`mediaDevices`/`serviceWorker`/`crypto.subtle` ausentes, o aviso "Instrumento e uso offline exigem
HTTPS. Abra o endereço HTTPS do Tailscale Serve." visível e persistente (mesma frase no menu
"Ajuda e app → Offline", botão de preparação escondido), sem exceções — captura
`evidence/rodada-6/stage10-http-ip-aviso.png`.

### Auditoria de privacidade do histórico completo

Varredura de **todo** o histórico da rodada (`b7c984a..HEAD`, todas as versões de arquivo tocadas em
cada um dos commits, mais o índice preparado do commit da etapa 10) contra a lista privada de termos e
contra os identificadores reais derivados de `local/deploy.env` (host, endereço da tailnet, usuário,
pastas e binário), com casamento por limite de palavra nos termos curtos. Saída só com
contagens e `arquivo:linha`, nunca o valor casado; imagens e áudio são pulados (a única exceção de
mídia pública são os **três WAV CC0** de bateria, com caminho e `sha256` conferidos). Resultado:
**0 ocorrências** — os 9 commits do histórico (`b7c984a..cf83473`) mais o índice preparado da etapa
10, **259** versões de arquivo e **20** identificadores/termos privados derivados de `local/`, sem
nenhum casamento.

### Verificação executada

- `npm test`: **1359 testes, 1357 passam, 0 falham, 2 ignorados** (amostra física e o teste contra o
  servidor real, que roda por flag).
- `npm run check`: **277 módulos, 0 falhas**.
- `npm run build`: **ok** — `dist/` gerado e a fronteira de conteúdo verificada (a única exceção de
  mídia são os três WAV CC0 de bateria, com caminho e `sha256` conferidos).
- Provas de UI e de contexto seguro acima, no Chromium próprio (CDP 9546/9548/9550).

### Serviço no Pi no commit final

@@PI10@@

### Privacidade

Tudo fictício (`example.invalid`, `usuario@example.org`, IP reservado TEST-NET-1, dispositivo de
mídia falso do Chrome, curso/sessão/mídia inventados). Nenhum valor real de curso ou de
infraestrutura entrou em arquivo, teste, captura ou nesta evidência. O arnês de prova (scripts CDP,
proxy TLS, relatórios) ficou **fora** do repositório; o commit guarda só as capturas e a evidência
escrita.

## Critérios de aceitação — resultado final

Legenda: **ok** = prova observada; a coluna "onde" aponta a seção desta evidência (ou a etapa que a
provou). Nenhum critério fica sem prova.

| # | Critério | Resultado | Onde |
| --- | --- | --- | --- |
| 1 | Sessão de 128 compassos (criar, editar, tocar, treinar, exportar, reimportar) | ok — 101,8 s de toque, 102,9 s de treino | Critérios das etapas 1–3 |
| 2 | Arpejo T-3-5 quartas, 25 compassos, ritmo e posição | ok — 25 compassos / 37 notas | Critérios das etapas 1–3 |
| 3 | Linha contínua 1–5, 13 compassos, inversão na borda | ok — 13 compassos / 49 notas | Critérios das etapas 1–3 |
| 4 | Aviso do percurso com o mínimo e ação que resolve | ok | Etapa 4 · Critério 4 |
| 5 | "Até fechar o período" para no estado inicial e avisa | ok — 120 compassos / 480 notas | Critérios das etapas 1–3 |
| 6 | Mesma receita em 5 cordas usa a corda Si e mantém a região | ok | Critérios das etapas 1–3 |
| 7 | Criar forma no braço, usar no gerador e ver no Braço | ok | Critérios das etapas 1–3 · Etapa 3 |
| 8 | Diálogo ≤ 14 controles, prévia ao vivo, avisos com ação | ok — ≤ 9 nas cenas medidas (pior caso 14) | Etapa 4 · Critério 8 · Etapa 10 UI |
| 9 | Variação nova ligada; original nunca sobrescrito; 12 tonalidades | ok | Etapa 4 · Critério 9 |
| 10 | Conversor no mapa fictício (ids, progresso, material, 6 cordas, avisos) | ok | Etapa 5 · Critério 10 |
| 11 | Reimportar com ids novos sem perder nada | ok — UI na pilha final | Etapa 5 · Critério 11 |
| 12 | `--catalogo` na aula e "Gerar" | ok | Etapa 5 · Critério 12 |
| 13 | Conferência privada do catálogo real (contagens por família) | ok — 321/335 geráveis; conferidor 216/113/6 | Critérios das etapas 1–3 |
| 14 | Praticar/Assistir independentes; assistir 3 aulas alimenta a prática de amanhã | ok — UI na pilha final | Etapa 5 · Critério 14 |
| 15 | Sem servidor: app como antes, sem erros no console | ok — 0 `/api`, 0 console | Etapa 7 · Critério 15 · Etapa 10 |
| 16 | Recusas de subida/identidade e escrita de outra origem | ok | Etapa 6 · Critério 16 |
| 17 | Escrita condicional 412 + cópia em conflito | ok | Etapas 6/7 · Critérios 17 e 20 |
| 18 | Primeira conexão (enviar/mesclar) com segundo perfil | ok | Etapa 7 · Critério 18 |
| 19 | Rede cortada: fila e volta sem perder nada | ok | Etapa 7 · Critério 19 |
| 20 | Anexo byte a byte, áudio com `Range`, remoção libera espaço | ok | Etapas 6/7/8 · Critérios 17 e 20 |
| 21 | "Converter no servidor" com mapa e catálogo fictícios | ok | Etapa 7 · Critério 21 |
| 22 | Instantâneo diário, rotação 14, restauração executada | ok | Etapa 6 · Critério 22 |
| 23 | `deploy/` com serviço, exemplos, scripts e guia; implantação no Pi | ok | Etapa 9 · `deploy/` · Etapa 10 · Pi |
| 23a | HTTPS (mediaDevices, service worker, instrumento) e aviso em HTTP por IP | ok | Etapa 9 · Critério 23a · Etapa 10 contexto seguro |
| 23b | Pasta de entrada: casamento por nome, guardar uma vez, relatório | ok | Etapa 8 · Critério 23b |
| 23c | Apostila embutida na página e faixa tocando; "Ver na apostila"; nenhum vídeo | ok — inclui ZIP e PDF de dentro pela UI | Etapa 8 · Critério 23c · provas nativas |
| 23d | Link/exportação sem conteúdo de curso; biblioteca privada com confirmação | ok — backup privado e link decodificado nativos | Etapa 8 · Critério 23d · provas nativas |
| 23e | Blob de curso só com identidade; `npm run build` falha com PDF/áudio em `dist/` | ok | Etapa 8 · Critério 23e |
| 23f | Gancho de pre-commit recusa PDF, `local/` e termo privado sem imprimir o termo | ok | Etapa 8 · Critério 23f |
| 24 | Auditoria de privacidade de todos os commits da rodada | ok | Etapa 10 · Auditoria |
| 25 | Limites de controles/altura e "O que já funciona" sem regressão | ok | Etapa 10 · Medições de UI |



