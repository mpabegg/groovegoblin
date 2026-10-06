# Rodada 5 — cursos como trilha de estudo

Base: `main` em `6410052`. JavaScript ESM/CSS puros, Node 22, sem dependências novas de runtime. Este registro distingue implementação de verificação observada; não transforma itens pendentes em aprovações.

## Privacidade e método

- `local/` foi acrescentado ao `.gitignore` antes de qualquer acesso a mapas privados. `git check-ignore local/curso-mapa/curso.json` confirmou a exclusão.
- Dados públicos de teste: `tests/fixtures/course/map-example.json`, inteiramente inventado, com domínio `example.invalid`, campos opcionais, `null`, valores encapsulados, números ambíguos, recursos compartilhados e itens de seis cordas para testar o descarte.
- Na verificação inicial, o mapa privado não estava presente. A conversão real, se o arquivo aparecer, será executada com saída somente em `local/`; este registro receberá apenas contagens.
- Capturas e execução visual usam um perfil Chromium isolado e exclusivamente dados fictícios. Nenhum vídeo, PDF ou áudio de um site de curso é baixado ou embutido pelo aplicativo.
- Leituras obrigatórias concluídas antes das edições, incluindo os trechos longos de HTML. O repositório não tem servidor LSP configurado.

## Etapa 1 — preparação e pendências

- No Chromium isolado, a ação nativa **Novo exercício** persistiu `targetBPM: null`; o cartão mostrou **100 BPM · definir alvo**, sem seta. Um alvo numérico já guardado permaneceu igual. Captura: [Biblioteca sem alvo, 1440×900](round5-new-without-target-1440.png). Nesta cena: 21 controles visíveis, documento com 900 px de altura e sem transbordamento horizontal.
- O defeito da Tab foi delimitado à preferência **Ritmo**: o renderizador recebia essa vista e não desenhava tablatura. O resultado agora pede a camada Tab à partitura compartilhada, usando somente a sessão executada; não modifica a preferência do editor nem inventa acordes.
- Smoke do pai: baixo de cinco cordas, quatro compassos, duas repetições, vista **Ritmo**. A prévia tinha quatro cifras e nenhuma nota de Tab; após o transporte real, o resultado tinha quatro cifras, 16 notas de Tab e 16 sinais. Foram agendados 31 ataques controlados pelo relógio do navegador; não houve instrumento físico. O resumo observado foi **Você atrasa em média 12 ms** e **Seu tempo foi regular**, sem “casados”/“dispersão”.
- [Resultado 1440×900](round5-result-rhythm-bass5-1440.png): 26 controles, altura total 900 px, sem transbordamento horizontal. [Resultado 1280×800](round5-result-rhythm-bass5-1280.png): mesmas camadas e ações legíveis, altura total 817 px, sem transbordamento horizontal. [Baixo de quatro cordas em Tab](round5-result-layers-1440.png): cifras, casas e omissões visíveis.
- Verificação da branch: `npm test` — 703 testes, 702 aprovados, um ignorado por ausência de WAV físico opcional, zero falhas. `npm run check` — 162 módulos, zero falhas. Cobertura inclui alvo nulo em instalação nova/metadados parciais, preservação de alvos legados, exportação/importação e montagem real do resultado. O cálculo de avaliação em `feedback.js` permanece intacto; `main.js` continua com 531 linhas.

## Etapa 2 — sessões de até 64 compassos

- Mantida a sessão **v5**: a estrutura não mudou e o validador anterior já rejeita valores acima de 16. Não há leitura silenciosa/truncamento de um documento novo pelo código anterior; arquivos legados válidos continuam no mesmo formato.
- Pelo controle nativo **Compassos**, a sessão passou de quatro para 64; **Repetir a frase nos novos compassos** gerou 256 notas. Rolagem até o fim e edição nativa por dígito alteraram a nota do compasso 64, preservando `start: 1020`, duração e limite da sessão.
- [Estúdio, 1440×900](round5-64-studio-1440.png): quatro faixas habilitadas, 57 controles, documento com 900 px e sem transbordamento horizontal. A compactação reduz espaços e mantém alvos de nota de 24 px; nenhum controle é escondido para fazer caber.
- A referência completa foi executada até o compasso 64: 256 notas, cerca de 51,8 s a 300 BPM; resultado com 16 sistemas e 16 faixas de quatro células. Execução sem ataques, para verificar extensão e transporte, não desempenho instrumental.
- [Prévia do Treinar](round5-64-trainer-1440.png): os 16 sistemas permanecem acessíveis em uma área interna de 242 px (conteúdo de 3707 px); 24 controles, página com 900 px.
- Medida de edição com 256 notas, acordes, bateria e baixo: quatro alterações nativas de BPM até a segunda pintura levaram 201,9–279,3 ms antes e 162,9–217,4 ms depois de evitar reconstruir partituras ocultas. Isso inclui toda a atualização do editor, não apenas o desenho da timeline. Abrir a partitura e mudar para Treinar montaram a referência atual completa (16 sistemas/256 notas).
- Reprodução real: 90 quadros, mediana 16,7 ms, máximo 20,6 ms, nenhum acima de 33 ms. Renderização inicial/atualização da cena menor, com 64 notas e quatro faixas, medida pelo trabalhador: 142,3–231,9 ms.
- [Resultado, 1440×900](round5-64-result-1440.png): segunda execução completa em 51,8 s; 16 sistemas e 16 faixas de quatro células dentro de 318 px (conteúdo de 4415 px). Documento com 900 px, 24 controles, sem transbordamento horizontal. Com foco na região, o teclado alcançou `scrollTop: 4097` sem mover a página.
- Exportação nativa baixou o exercício com 64 compassos e 256 notas. Reimportação nativa reconheceu a duplicata sem sobrescrever. Outro JSON fictício com 512 notas foi importado e aberto; **Compartilhar link** recusou o limite de 65536 caracteres, orientou exportar o arquivo e manteve 64 compassos/512 notas.
- Verificação da branch: `npm test` — 711 testes, 710 aprovados, um WAV físico opcional ignorado, zero falhas. `npm run check` — 164 módulos, zero falhas. `main.js`: 527 linhas. Testes cobrem limites, sessão/formas, histórico, operações de compasso, geração, notação e recusa de links grandes.

## Etapa 3 — ciclos pelos 12 tons e leitura Agora/Próximo

- Pela UI nativa, **Progressões prontas → Ciclos pelos 12 tons → Quartas · maior · 2 compassos por acorde · Repetir o primeiro no fim, em 1 compasso** mostrou o tamanho antes de aplicar (`= 25 compassos`) e, no diálogo de tamanho, **Ajustar sessão para 25 compassos** ficou **habilitado** — o antigo teto de 16 compassos não bloqueia mais a operação. Confirmar levou a sessão de 4 para **25 compassos** com **13 acordes** em C F Bb Eb Ab Db Gb B E A D G C, na ordem exata do contrato: os 12 primeiros com 8% de largura (2 compassos cada, `start` de 0 a 352 em passos de 32 ticks) e o C final com 4% (1 compasso, `start` 384). O loop passou a 1–25.
- Outra ordem/tríade pela mesma UI: **Cromática ascendente · aumentada · 2 compassos**, já com 25 compassos na sessão, aplicou na hora (sem diálogo) e produziu Caug Dbaug Daug Ebaug Eaug Faug Gbaug Gaug Abaug Aaug Bbaug Baug + Caug; **Desfazer (↶)** devolveu o ciclo de quartas com os 25 compassos. Um terceiro ciclo de tamanho diferente — **Quintas (inverso) · menor · 1 compasso** — abriu o diálogo com **Ajustar sessão para 13 compassos**, **Repetir/cortar só a progressão** e **Cancelar**; **Cancelar** manteve a sessão intacta (25 compassos, 13 acordes).
- Reprodução real com o loop inteiro (300 BPM, 25 compassos ≈ 20 s): as leituras do Estúdio e do Treinar andaram **em passo**. Amostragem de 150 ms das transições: C (1) → F (3) → Bb (5) → Eb (7) → Ab (9) → Db (11) → Gb (13) → B (15) → E (17) → A (19) → D (21) → G (23) → **C (25, "Próximo: C, compasso 1")** → C (1) → F (3). O acorde repetido no fim dura um compasso e o **Próximo** volta ao primeiro acorde do loop.
- Loop parcial pela régua (Shift+setas, 1–5) a 60 BPM, medido por amostragem: **C 8 s** (dois compassos) → **F 8 s** → **Bb 4 s** → **C 4 s**, ou seja, ao fim do compasso 5 a leitura aponta o **compasso 1**. Captura com a partitura do Estúdio aberta e cursor no compasso 5: [virada do loop parcial, 1440×900](round5-cycles-studio-loopwrap-1440.png).
- **Treinar** com treino real: Entrada **Teclado**, quatro notas autorais nos compassos 1–4, **Treinar esta frase**. O treino percorreu Repetição 1/4 até **Treino concluído**, com Espaço registrando os ataques; a leitura permaneceu visível e correta durante a execução e no fim do loop parcial ("Agora: Bb, compasso 5 · Próximo: C, compasso 1"). Captura com o loop 1–5 e a leitura na partitura do Treinar: [virada do loop no Treinar, 1440×900](round5-cycles-trainer-loopwrap-1440.png). Nenhum dispositivo físico foi usado.
- **Braço** com a opção **Notas do próximo acorde (tracejado)** marcada: 19 células em contorno tracejado com as notas do próximo acorde (Fá maior: F, A, C) e nenhuma marcação do acorde atual removida — 48 células da escala e 6 fundamentais continuaram iguais; com o áudio tocando, o rótulo da tabela citou `contorno tracejado nas notas de F`. Captura: [braço com contorno tracejado, 1440×900](round5-cycles-fretboard-next-1440.png).
- Regra da leitura: ela some **apenas** quando a sessão que representa não tem acorde nenhum naquele ponto — material gerado que herde a harmonia continua legível e a frase autoral nunca é escondida por causa de uma execução gerada. Isso é coberto por `tests/harmony-readout.test.js` (8 testes: estado por compasso, pausa harmônica, virada do loop parcial e total, ausência de harmonia, impressão digital só da harmonia e o elemento montado escondendo/reescrevendo). No Estúdio, a leitura fica dentro de **Partitura da frase** (recolhida por padrão) e por isso não ocupa o repouso; a do Treinar fica sobre a partitura do painel.
- Repouso em **1440×900** com a sessão de 25 compassos: documento com **900 px** (nenhuma rolagem de página) e sem transbordamento horizontal, **30 controles visíveis** no Estúdio e **16** no Treinar pela contagem de `checkVisibility` restrita a `button/input/select/textarea` usada nas rodadas 3 e 4 (portanto abaixo dos limites 58/30). Em **1280×800** não há transbordamento horizontal e os controles continuam legíveis, com o mesmo excesso de altura já registrado nas rodadas anteriores para essa largura (833 px no Estúdio e 854 px no Treinar). Capturas: [Estúdio 1440×900](round5-cycles-studio-1440.png), [Estúdio 1280×800](round5-cycles-studio-1280.png), [Treinar 1280×800](round5-cycles-trainer-1280.png).
- Partituras de 25 compassos: a do Estúdio monta **7 sistemas e 25 cifras** quando aberta (a página cresce para 2269 px nesse estado intencional); a do Treinar mantém a área interna de 242 px com 1186 px de conteúdo e rolagem própria. Nenhuma partitura oculta é desenhada enquanto fechada.
- Observado e não escondido: as opções do ciclo (ordem/tríade/compassos/repetição) não são persistidas e voltam ao padrão ao recarregar; depois de um treino concluído, o contorno tracejado do Braço espera a próxima reprodução/posição, porque usa o mesmo sinal de "outro material soando" que marca o acorde como tocando.
- Verificação da branch: `npm test` — **731 testes, 730 aprovados, um WAV físico opcional ignorado, zero falhas**. `npm run check` — **167 módulos, zero falhas**. `main.js`: 527 linhas. Testes cobrem as três ordens, as quatro tríades, 1 e 2 compassos, final de um compasso (13/24/25), recusas, rótulo, ajuste de sessão, repetir/cortar, agora/próximo com pausas e no fim de loop parcial/total, e a leitura montada.

## Critérios de aceitação

| Nº | Critério | Resultado observado |
| --- | --- | --- |
| 1 | Diretório privado ignorado e histórico sem conteúdo real | Exclusão confirmada; auditoria final pendente |
| 2 | Sessão de 64 compassos de ponta a ponta e legados preservados | Pendente |
| 3 | Ciclo de quartas com tríades, 25 compassos e acorde final | Passou na Etapa 3: UI nativa ajustou a sessão para 25 compassos, 13 acordes C F Bb Eb Ab Db Gb B E A D G C, cada um com 2 compassos e o primeiro repetido em 1; cromática/aumentada e quintas/menor conferidas, com Desfazer |
| 4 | Agora/Próximo em reprodução, treino e virada do loop | Passou na Etapa 3: leituras iguais no Estúdio e no Treinar em reprodução real, com virada no fim do loop total (compasso 25 → 1) e do loop parcial 1–5, no Treinar com entrada Teclado e treino concluído |
| 5 | Resultado com cifras/Tab/marcas e linguagem direta | Smoke real em Ritmo/baixo 5 e Tab/baixo 4; capturas nas duas larguras |
| 6 | Exercício novo sem alvo | Ação nativa, persistência nula e regressões de preservação aprovadas |
| 7 | Formato válido importa; inválido aponta o campo | Pendente |
| 8 | Conversor irregular, progresso opt-in e descarte de seis cordas | Pendente |
| 9 | Lista/página de curso com 200 aulas e teclado | Pendente |
| 10 | Reimportação preserva progresso, notas e vínculos | Pendente |
| 11 | Link externo em nova aba, sem incorporar conteúdo | Pendente |
| 12 | PDF/MP3 locais, persistência, offline, remoção e espaço | Pendente |
| 13 | Sugestão cria exercício de baixo vinculado e configurado | Pendente |
| 14 | Conclusão exige ambos os alvos a 90%; override/reabertura | Pendente |
| 15 | Marcação em lote de aulas assistidas com Desfazer | Pendente |
| 16 | Seminários opcionais não bloqueiam a próxima aula | Pendente |
| 17 | Hoje prioriza aula/prática/pendências dentro do orçamento | Pendente |
| 18 | Backup preserva cursos, progresso, notas e vínculos | Pendente |
| 19 | Limites de controles e altura em 1440×900 | Parcial na Etapa 3: sessão de 25 compassos com Estúdio em 900 px/30 controles e Treinar em 900 px/16 controles (`checkVisibility`), sem transbordamento horizontal; Biblioteca/cursos e demais telas pendentes |
| 20 | Funcionalidades anteriores preservadas | Pendente |
