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
- Integração: `fc670ce` fast-forward na main; **333/333 testes e check** repetidos após merge; push confirmado.

### Etapa 4 — Transporte, mixer e leitura do treino

- Transporte em uma linha de 53 px em 1280 px; Compasso reúne fórmula, divisão e swing. Os campos numéricos de loop foram removidos.
- Régua: arrasto selecionou compassos 2–3 e desenhou faixa com início em 25%/largura 50%; duplo clique nativo restaurou 1–4. Clique/setas escolhem início no mesmo agendador; o marcador não altera a sessão. Alterar o trecho para automaticamente com aviso; seek não interfere no treino.
- Uma superfície de teclado na régua substitui os botões de cada compasso. End/Enter abriu operações do compasso 16; fechar devolveu foco à régua, e o destino de cópia indicava compasso 1. As instruções completas ficam em Atalhos e na descrição acessível, não em parágrafos permanentes.
- M/S/volume diretos em todas as faixas. Tom, progressões, estilos, densidades e Variar continuam nos cabeçalhos. Solo múltiplo é temporário, respeita os mudos manuais e não reescreve o mixer salvo; retirar solo preservou o mudo da bateria.
- Medição de controles nativos visíveis dentro do Estúdio: **49** em quatro compassos e **50** em dezesseis, sem seleção/popovers e com quatro faixas ligadas. Nenhum controle ultrapassou seu cabeçalho; transporte, faixas e inspetor cabem em 1440×900.
- Som das quatro faixas: popovers inteiros na janela, tanto com aviso como sem aviso; com aviso, cada painel ficou a 6 px abaixo de seu acionador. Espaço iniciou loop e parou; também cancelou preparação pendente.
- Ouvir frase usa uma passagem finita no mesmo transporte. Com a frase salva muda e volume zero, e metrônomo desligado, o Web Audio real produziu pico **0,2503**; a sessão serializada permaneceu byte a byte igual e o transporte voltou naturalmente a Tocar.
- Partitura de 16 compassos no Treinar: quatro sistemas, todos sem rolagem horizontal (1160/1160 px por sistema); eventos e ligaduras entre sistemas têm regressão dedicada.
- Verificação final na branch: **342/342 testes**, **95 módulos, zero falhas**. Capturas: [1440×900](rodada-2-etapa4-1440x900.png), [1280×800](rodada-2-etapa4-1280x800.png).
- Integração: `a98f8cc` fast-forward na main; **342/342 testes e check** repetidos após merge; push confirmado.

### Etapa 5 — Bateria editável e sessão v4

- A sessão passa para **v4**. Campo canônico `drums.edits`: array ordenado, máximo 512 itens `{voice, start, velocity}`; posição absoluta em unidades internas retas da sessão; `velocity: null` remove um ataque e número entre 0,05 e 1 adiciona/substitui intensidade. Identidade é voz + posição, com tolerância numérica; duplicatas, campos desconhecidos, limites e edições indevidamente embutidas em documentos v2/v3 são rejeitados.
- Migração v2/v3 acrescenta diferenças vazias, mantendo as chaves de armazenamento/biblioteca. Comparação independente com o código v3 anterior: **198 sessões, 12.632 ataques, zero diferenças**, cobrindo 11 estilos, três densidades, três compassos e duas escolhas de sorteio.
- No navegador, durante loop: clique adicionou bumbo na posição 1; arrasto vertical mudou intensidade de 75% para 45%; clique removeu o ataque da posição 0. O transporte permaneceu em Parar.
- Enter/Delete e Shift+setas exercitados na grade; intensidade mudou de 45% para 50%. Espaço permanece exclusivamente atalho do transporte, inclusive com foco na bateria.
- Alterar estilo/sorteio com diferenças abre Manter/Descartar/Cancelar. Cancelar preservou o JSON inteiro; Manter preservou diferenças; Descartar limpou e Desfazer recuperou. Densidade não abriu diálogo nem perdeu diferenças. Restaurar e Desfazer funcionaram; botão compacto ficou contido no cabeçalho.
- Inserção de compasso deslocou edição da posição 17 para 33, preservando as anteriores e sem copiar diferenças para o compasso inserido. Redução que perderia diferenças foi recusada com explicação, preservando toda a sessão; mudança de fórmula com diferenças também requer restauração prévia. Decisão conservadora: não reinterpretar nem perder ataques manuais silenciosamente.
- Download JSON real de 8.357 bytes, importado pelo campo de arquivo do app: recuperou v4, remoção na posição 0 e intensidade 45% na posição 1. Reload preservou as diferenças. O arquivo temporário foi removido após a prova.
- Web Audio real: sessão isolada com todos os ataques gerados removidos e um bumbo manual na posição 1/45%; janela removida teve pico **0**, janela adicionada **0,069984**. Regressões também cobrem scheduler ao vivo, renderer, loop, forma, biblioteca e links.
- Exportação MIDI mantém o escopo anterior, frase/acordes, sem adicionar percussão ao módulo de repertório.
- Interface em 1280 px: **50 controles** com quatro faixas e diferenças presentes; Restaurar contido no cabeçalho e inspetor até y=765. Cliques no baixo e em posição ocupada da frase exibiram explicações, não silêncio.
- Verificação final na branch: **357/357 testes**, **99 módulos, zero falhas**. Capturas: [1440×900](rodada-2-etapa5-1440x900.png), [1280×800](rodada-2-etapa5-1280x800.png).
- Integração: `8d174cb` fast-forward na main; **357/357 testes e check** repetidos após merge; push confirmado.

### Etapa 6 — Entrada por instrumento

- Entrada Teclado/Instrumento integrada ao treino e à prática guiada. Dispositivo, canal 1/2/soma, sensibilidade, medidor, diagnóstico e calibração usam preferências próprias; abrir a página sempre começa no Teclado, sem restaurar captura.
- `getUserMedia` real + AudioWorklet real no Chromium, alimentados por WAV sintético estéreo: silêncio à esquerda e ataques de 110 Hz à direita. Canal 2 detectou ataques periódicos e o medidor respondeu. Isso verifica o caminho de captura, não uma guitarra física.
- Detector puro por amostra, limiar adaptativo e refratário mínimo de 50 ms. No WAV usado pelo navegador, erro de **0,146 ms**; repetir 30 ciclos manteve exatamente oito ataques por ciclo. A suíte cobre ruído, sustentadas, ataques próximos, quatro taxas de amostragem e blocos de tamanhos diferentes.
- Ataques passam pelos mesmos `audio.press/release` e relatório existentes. Instrumento avalia só ataques; términos são gates escritos, alturas não são medidas e o monitor de entrada não duplica o som. O navegador apresentou oito ataques extras numa execução sintética propositalmente fora de fase, com términos/alturas marcados como não avaliados.
- Compensação demonstrada no caminho real: três ataques tiveram exatamente **23 ms** subtraídos antes de `GrooveAudio.press`; no treino seguinte com compensação zero, nenhuma subtração. Dispositivo específico e compensação 23 ms foram restaurados após reload.
- Calibração com os oito cliques reais e respostas de teclado temporizadas: **23 ms, dispersão 0 ms**, oito ataques capturados e transporte final Pronto. Os dois primeiros são aquecimento; regressões verificam rejeição por dispersão, clock de saída inicialmente zerado, cauda de entrada e ausência de desconto duplicado.
- Calibração é associada à identidade física resolvida, nunca reaplicada cegamente ao alias `default`; sem identidade distinguível, fica apenas na captura atual com aviso. Falhas de armazenamento também são explícitas.
- Contador no navegador: **zero** chamadas de captura ao abrir, **uma** depois de selecionar Instrumento. Permissão negada real e ausência simulada retornaram ao Teclado com explicação. Evento de desconexão simulado numa faixa real durante treino interrompeu o transporte, voltou ao Teclado e deixou a faixa em `ended`.
- Áudio de entrada é processado somente no dispositivo, sem gravação ou envio. Takes sintetizados não são gravações do instrumento. Fones são recomendados; coincidência com cliques só gera aviso de possível vazamento, não separação garantida de fontes.
- Verificação após integrar as etapas 1–5: **388/388 testes**, **106 módulos, zero falhas**. Capturas: [1440×900](rodada-2-instrumento-1440x900.png), [1280×800](rodada-2-instrumento-1280x800.png).


## Critérios de aceitação

| Nº | Critério | Resultado |
|---|---|---|
| 1 | Tresillo preserva 4 compassos, 72 BPM e acorde no compasso 2; preenche frase | Passou: navegador e regressão |
| 2 | Banda inicial: um acorde por compasso | Passou: navegador, 4 acordes × 1 compasso; regressões incluem 1 compasso |
| 3 | Criar/mover nota e trocar acorde durante loop sem parar | Passou: interação no navegador e regressões do agendador |
| 4 | Cliques nas faixas têm resposta visível | Passou: edição de frase/acordes/bateria e avisos para baixo gerado/posição ocupada |
| 5 | Duração ativa lembrada; arrasto central move nota curta | Passou: semínima criada; semicolcheia movida sem mudar duração |
| 6 | Seleção múltipla, copiar, colar, duplicar e Esc | Passou: Shift, retângulo, Ctrl+A/C/V/D e intensidade agrupada |
| 7 | Aumentar sessão e repetir frase | Passou: 1→4 com quatro compassos iguais no navegador e regressão de histórico |
| 8 | Acordes repetidos desenhados como fantasmas | Passou: 40% de opacidade, sem alça; materialização verificada |
| 9 | 16 compassos legíveis; semicolcheia >=12px, rótulos sem sobreposição | Passou: 15,6875 px, 64 rótulos sem sobreposição, rolagem automática e cabeçalho fixo |
| 10 | Popovers ancorados e inteiros, com e sem aviso | Passou: quatro faixas, ambos os estados; distância de 6 px ao acionador |
| 11 | Mudo e solo a um clique | Passou: quatro controles diretos; retirar solo preserva mudo manual |
| 12 | Avisos não deslocam transporte | Passou: posição documental 130 px antes/depois |
| 13 | Transporte em uma linha a 1280px; <=60 controles no Estúdio | Passou: altura 53 px; 49 controles em 4 compassos e 50 em 16 |
| 14 | Arrastar régua define loop | Passou: arrasto 2–3, faixa proporcional e duplo clique restaura sessão inteira |
| 15 | Ouvir frase no Treinar e partitura inteira | Passou: áudio real audível mesmo com frase muda, sem persistir alteração; 16 compassos em 4 sistemas sem cortes |
| 16 | Bateria editável, exportação/importação e migração v3 preservadas | Passou: download/importação reais, reload, áudio com diferenças e 198 casos v3 sem alteração de ataques |
| 17 | Captura, medidor e diagnóstico de ataques | Passou com captura real de dispositivo simulado; guitarra física não testada |
| 18 | Detector sintético: erro <=10ms, sem falsos ataques sustentados | Passou: suíte de sinais; WAV do navegador com erro de 0,146 ms |
| 19 | Instrumento usa relatório comum; duração/altura não avaliadas | Passou: navegador e regressões da cadeia até avaliação |
| 20 | Calibração por dispositivo altera desvio seguinte | Passou: 23 ms/zero aplicados exatamente e compensação específica restaurada após reload |
| 21 | Permissão negada/ausência retorna ao Teclado | Passou: negação real, ausência simulada e desconexão simulada encerrando faixa real |
| 22 | Nenhuma permissão solicitada antes de escolher Instrumento | Passou: contador zero ao abrir, uma chamada após seleção |
| 23 | Removidas afirmações de que microfone não é usado | Textos globais corrigidos; descrições específicas de atividades sem captura permanecem verdadeiras e fora do escopo |
| 24 | Preservados requisitos da primeira rodada | Pendente |

## Limite de evidência de áudio

Sinais sintéticos e dispositivos simulados verificam detector, relógio, medidor e integração. Não equivalem a tocar uma guitarra física. O painel de diagnóstico está disponível para essa validação sem gravar nem enviar áudio. Legato, ataque fraco/lento, clipping, ruído e vazamento podem prejudicar a detecção; latências declaradas pelo navegador e compensação humana não são uma medição laboratorial.
