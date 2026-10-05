# Rodada 2 — fluidez de edição e instrumento real

Base: `4e55281`. JavaScript ESM/CSS, sem dependências novas de runtime. Cada etapa usa branch própria, um commit, integração na main, nova execução dos testes e push. Entrada por instrumento implementada em worktree separado e integrada na etapa 6.

## Registro das etapas

As seções abaixo recebem decisões e resultados observados ao concluir cada etapa; não representam verificações antecipadas.

### Etapa 1 — Previsibilidade, mensagens e popovers

- Padrões compatíveis repetem somente as notas; geração mantém os parâmetros musicais. Incompatibilidades oferecem mudar compasso/divisão ou cancelar; não há quantização/fusão silenciosa. Expansão exige aceite e não corta acordes/seções.
- BPM sugerido só é aplicado quando não existem notas, acordes, banda ligada ou seções. Banda inicial cria um acorde por compasso.
- Toast único sobreposto: 6 s normal, 10 s com Desfazer seguro; fecha ao trocar de aba. Popovers nativos no top layer, ancorados ao acionador; avançado harmônico inline.
- Verificação na branch: `npm test` **306/306**, `npm run check` **82 módulos, zero falhas**. Navegador: Tresillo manteve 72 BPM/4 compassos/acorde no segundo compasso, três ataques em cada compasso; início em três cliques tocou quatro acordes de um compasso. Diálogo 7/8 explicou a mudança antes do aceite.
- Toast expirou; posição documental do transporte permaneceu **130 px antes/depois**. Som da bateria abriu a 6 px abaixo do acionador, inteiro no viewport, com aviso presente.
- Capturas: [1440×900](rodada-2-etapa1-1440x900.png), [1280×800](rodada-2-etapa1-1280x800.png).
- Integração: `c55dfff` fast-forward na main; **306/306 testes e check** repetidos após merge; push confirmado.

### Etapa 2 — Edição ao vivo e seleção

- Notas, acordes, tom e histórico compatível usam o agendador existente sem reiniciar o loop. Eventos já enviados ao Web Audio no horizonte de 100 ms permanecem; os posteriores usam a sessão atualizada. Estrutura e substituições param automaticamente com aviso.
- Duração ativa em preferência própria (colcheia inicial), seleção Shift/retângulo/Ctrl+A, operações agrupadas, clipboard interno Ctrl+C/V/D e prévia curta de notas/acordes com áudio parado.
- Alça de 6 px mantida em notas de 12 px ou mais; abaixo disso, corpo move e setas redimensionam. Decisão: evitar que uma alça ocupe toda uma nota geometricamente menor que ela.
- Navegador: criou semínima, moveu nota e trocou Cmaj7 por Dm7 mantendo botão Parar/loop ativo. Aumentar compassos parou o transporte e avisou. Arrasto central moveu semicolcheia de posição 0 para 2 sem alterar duração 1; alça medida em 6 px.
- Ctrl+A selecionou todas; Ctrl+D duplicou após o grupo; colagem pelo cursor inseriu nas posições 16 e 24. Esc ocultou seleção e devolveu ações da frase. Shift selecionou duas notas e intensidade 35% alterou ambas; retângulo selecionou quatro.
- Regressão revelou conversão incorreta das vozes da prévia de acorde; produção e teste corrigidos para usar `note.midi`. Verificação final na branch: **317/317 testes**, **87 módulos, zero falhas**. Regressões exercitam eventos realmente agendados e prévias sintetizadas.
- Capturas: [1440×900](rodada-2-etapa2-1440x900.png), [1280×800](rodada-2-etapa2-1280x800.png).
- Integração: `c7f2df5` fast-forward na main; **317/317 testes e check** repetidos após merge; push confirmado.

### Etapa 3 — Tamanho e leitura

- Ampliar a sessão oferece repetir a frase nos compassos novos; execução nativa 1→4 produziu ataques 0/4/8/12 em cada compasso. Oferta e repetição são duas alterações independentes no histórico.
- Menu da régua por botão direito ou teclado: duplicar insere após o compasso e desloca o conteúdo posterior, copiar rejeita sobreposição e limpar afeta somente o alvo. Loop e seções acompanham a inserção; sustentações atravessadas são divididas, sem perder os trechos escritos. Limites da sessão são explicados sem truncamento.
- Repetições harmônicas têm 40% de opacidade, borda tracejada e nenhuma alça. Materializar transformou três fantasmas em acordes reais; duplicar inseriu o quinto compasso preservando a sequência.
- Decisão de layout autorizada pelo item 5: rolagem horizontal com cabeçalhos fixos, em vez de sistemas, preservando o único gesto contínuo de edição de notas/acordes e o cursor existente. Zoom na régua oferece quatro ou dois compassos; nunca espreme tudo. Compassos excepcionalmente densos podem exigir rolagem mesmo numa sessão curta.
- Em 1280 px, 16 compassos: semicolcheia medida em **15,6875 px**; os 64 rótulos da régua não se sobrepõem. Durante reprodução, rolagem automática chegou a 581 px e o cabeçalho permaneceu em x=38 px.
- Bateria tem nomes à esquerda; baixo mostra nomes das notas quando cabem. Durações harmônicas usam tempos/compassos; Polirritmia e Partitura da frase substituem os termos anteriores.
- Cabeçalho da Frase mantém quatro figuras e Mais com outras sete em popover ancorado; Som deixou de ficar cortado. O baixo somente leitura explica onde ajustar seu conteúdo ao receber clique.
- Verificação na branch: **333/333 testes**, **90 módulos, zero falhas**. Capturas: [1440×900](rodada-2-etapa3-1440x900.png), [1280×800](rodada-2-etapa3-1280x800.png).


## Critérios de aceitação

| Nº | Critério | Resultado |
|---|---|---|
| 1 | Tresillo preserva 4 compassos, 72 BPM e acorde no compasso 2; preenche frase | Passou: navegador e regressão |
| 2 | Banda inicial: um acorde por compasso | Passou: navegador, 4 acordes × 1 compasso; regressões incluem 1 compasso |
| 3 | Criar/mover nota e trocar acorde durante loop sem parar | Passou: interação no navegador e regressões do agendador |
| 4 | Cliques nas faixas têm resposta visível | Pendente |
| 5 | Duração ativa lembrada; arrasto central move nota curta | Passou: semínima criada; semicolcheia movida sem mudar duração |
| 6 | Seleção múltipla, copiar, colar, duplicar e Esc | Passou: Shift, retângulo, Ctrl+A/C/V/D e intensidade agrupada |
| 7 | Aumentar sessão e repetir frase | Passou: 1→4 com quatro compassos iguais no navegador e regressão de histórico |
| 8 | Acordes repetidos desenhados como fantasmas | Passou: 40% de opacidade, sem alça; materialização verificada |
| 9 | 16 compassos legíveis; semicolcheia >=12px, rótulos sem sobreposição | Passou: 15,6875 px, 64 rótulos sem sobreposição, rolagem automática e cabeçalho fixo |
| 10 | Popovers ancorados e inteiros, com e sem aviso | Parcial: Som da bateria verificado; todas as faixas na verificação final |
| 11 | Mudo e solo a um clique | Pendente |
| 12 | Avisos não deslocam transporte | Passou: posição documental 130 px antes/depois |
| 13 | Transporte em uma linha a 1280px; <=60 controles no Estúdio | Pendente |
| 14 | Arrastar régua define loop | Pendente |
| 15 | Ouvir frase no Treinar e partitura inteira | Pendente |
| 16 | Bateria editável, exportação/importação e migração v3 preservadas | Pendente |
| 17 | Captura, medidor e diagnóstico de ataques | Pendente; validação física de guitarra depende do usuário |
| 18 | Detector sintético: erro <=10ms, sem falsos ataques sustentados | Pendente |
| 19 | Instrumento usa relatório comum; duração/altura não avaliadas | Pendente |
| 20 | Calibração por dispositivo altera desvio seguinte | Pendente |
| 21 | Permissão negada/ausência retorna ao Teclado | Pendente |
| 22 | Nenhuma permissão solicitada antes de escolher Instrumento | Pendente |
| 23 | Removidas afirmações de que microfone não é usado | Pendente |
| 24 | Preservados requisitos da primeira rodada | Pendente |

## Limite de evidência de áudio

Sinais sintéticos e dispositivos simulados permitem verificar detector, relógio, medidor e integração. Não equivalem a tocar uma guitarra física. O painel de diagnóstico permitirá essa validação posterior sem gravar nem enviar áudio.
