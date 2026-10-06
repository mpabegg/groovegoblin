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

## Critérios de aceitação

| Nº | Critério | Resultado observado |
| --- | --- | --- |
| 1 | Diretório privado ignorado e histórico sem conteúdo real | Exclusão confirmada; auditoria final pendente |
| 2 | Sessão de 64 compassos de ponta a ponta e legados preservados | Pendente |
| 3 | Ciclo de quartas com tríades, 25 compassos e acorde final | Pendente |
| 4 | Agora/Próximo em reprodução, treino e virada do loop | Pendente |
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
| 19 | Limites de controles e altura em 1440×900 | Pendente |
| 20 | Funcionalidades anteriores preservadas | Pendente |
