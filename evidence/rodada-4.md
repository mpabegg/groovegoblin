# Rodada 4 — evidências de execução

Base: `main` em `802b49f`. JavaScript ESM, sem dependências de runtime novas; formato da sessão permanece v5. Este registro é atualizado a cada etapa, sem transformar verificações pendentes em aprovações.

## Etapa 1 — Estúdio

Implementação na branch `feat/round4-studio`:

- Ordem: linha do tempo → inspetor/ações da frase → Braço → Opções da banda → forma. Abrir o Braço não desloca o inspetor para depois dele.
- Bateria e baixo gerado recolhem para uma linha, mantendo ligar/desligar, M/S e volume; expandir devolve os controles e a edição. Preferências independentes em `groovegoblin.studio.track-layout.v1`, fora da sessão e do Undo.
- Cordas nomeadas em uma coluna do cabeçalho, à esquerda da Tab. A geometria musical compartilhada não recebe deslocamento nem sobreposição no início.
- No perfil Baixo, o convite é “Ligar bateria e acordes” e desaparece quando o acompanhamento está pronto. A ação não liga o baixo gerado.

### Prova no navegador

Chromium isolado, servidor da branch na porta 5201, fixture válida de quatro compassos com quatro faixas ligadas e Tab de seis cordas. A fixture foi carregada no armazenamento do perfil de prova; as interações seguintes foram feitas na interface.

| Observação | Resultado |
| --- | --- |
| 1440×900, altura do documento | **900 px**, sem rolagem vertical |
| Controles visíveis do Estúdio | **50** |
| Controles visíveis na página inteira | **55** |
| Método de contagem | `button,input,select,summary`, filtrados por `checkVisibility()` |
| Transporte | **53 px** de altura |
| 1280×800 | sem overflow horizontal; documento **892 px**, com rolagem vertical |
| Inspetor / Braço, também aberto | inspetor termina em y=691; Braço começa em y=703 |
| Cordas / rótulos | os seis centros coincidem exatamente |
| Tick zero | rótulo termina em x=233; nota começa em x=240; clique seleciona a nota |
| Faixas de acordes, frase, bateria e baixo | origem comum em x=238 |
| Afinação pela interface | sexta corda muda E → D em Drop D; D → Ré em Dó Ré Mi |
| Preferência após recarregar | bateria expandida, baixo recolhido, conforme escolha anterior |
| Mixer recolhido | M persiste `muted: true`; seta no volume persiste `0.99`; ambos restaurados pela interface |
| Baixo com bateria/acordes ligados | convite oculto, baixo gerado desligado |
| Reativação do acompanhamento no Baixo | botão apropriado liga bateria/acordes; baixo gerado permanece desligado |
| Erros de página observados | nenhum |

Capturas reais: [1440×900](rodada-4-estudio-1440x900.png), [1280×800](rodada-4-estudio-1280x800.png).

Verificação da branch: `npm test && npm run check` — **567 testes aprovados**, nenhum ignorado ou falho; **136 módulos**, zero falhas. Os testes novos cobrem persistência/corrupção das preferências, transição de edição recolhida/expandida, acompanhamento por perfil e afinação dos rótulos.

### Decisões e limites

- A contagem inclui controles desabilitados visíveis, mas não elementos fechados de `details`. A contagem de página inteira também fica abaixo de 58.
- A API atual de `evaluateSession` aceita modo, objetivo e repetições, mas não tolerância configurável. O seletor Auto/±60/±90 não será introduzido alterando o algoritmo nesta rodada.
- Houve perda de isolamento de contexto nos primeiros agentes delegados. Foram cancelados; suas alegações de testes/capturas foram descartadas. Os números acima são da execução independente do integrador, não daqueles relatos.

## Etapa 2 — resultado anotado

- O resultado substitui a área de toque, a partitura de repouso e as opções/guidado enquanto está aberto. Há uma só partitura de resultado, com cifras, ritmo e Tab; a tabela por nota começa recolhida.
- Resumos, estados por nota, moda entre repetições, desvios, extras e pior trecho são derivados do resultado existente de `evaluateSession`. O avaliador não foi alterado. O módulo e os estilos da antiga timeline sobreposta foram removidos.
- Erros de altura, inclusive oitava, têm anotação própria; altura não identificada não é inventada. A posição dos extras usa o instante observado, não a posição de uma nota esperada.
- Salvar a tentativa continua alimentando os consumidores existentes, mas não produz o toast de sucesso do playground/repertório após o treino. Erros e outros avisos permanecem visíveis.

### Prova no navegador

Chromium isolado, porta 5222, quatro compassos, duas repetições, 16 notas, quatro faixas e Tab de seis cordas:

| Cenário exercitado | Resultado observado |
| --- | --- |
| 1440×900, resultado completo em repouso | documento **900 px**, sem overflow horizontal, **20 controles** visíveis em Treinar |
| 1280×800 | documento **863 px**, sem overflow horizontal; rolagem vertical permitida |
| Entrada uniforme de +30 ms | **32 de 32**, texto **30 ms**, dispersão **0 ms** |
| Tentativa mista: −45/+45 ms, oito omissões no compasso 2, um extra | **20/32**; cores/sinais e tooltips com desvios; faixa **50%, 0%, 100%, 100%**, pior compasso marcado |
| Seletor de repetição | repetição 1 mostra o extra; repetição 2 não; Todas restaura a visão agregada |
| Tecla `L` | seleciona os compassos **1–2** (`startBar: 0`, `endBar: 2`) e inicia novo treino; execução seguinte **16/16** |
| Tecla `+` após 32/32 | **120 → 124 BPM**, com nova execução |
| Tecla `+` após 20/32 | permanece **124 BPM**, resultado continua visível |
| Botão −10, depois tecla `−` | **124 → 114 → 104 BPM**, ambas as ações iniciam o treino |
| Enter e botão Tentar de novo | repetem no mesmo BPM; a tentativa anterior correspondente aparece na comparação |
| Estado final | áudio `idle`, nenhum Parar visível, nenhum toast “Tentativa…”, tabela fechada, antigo `#timeline` ausente |

Os 30 ms exatos foram fornecidos como **timestamps controlados pela API pública `GrooveAudio.press/release`, atravessando transporte e avaliador reais**; não são uma medição de instrumento físico. Também houve 64 eventos de teclado CDP nativos/confiáveis: nessa execução o desvio efetivo foi 39 ms, corretamente mostrado como 39 ms. O atraso pedido ao agendador nativo não foi apresentado como atraso medido.

Capturas reais: [1440×900](rodada-4-resultado-1440x900.png), [1280×800](rodada-4-resultado-1280x800.png).

Verificação da branch: `npm test && npm run check` — **585 aprovados, 1 ignorado, zero falhas**; **142 módulos**, zero falhas. O único ignorado continua sendo o fixture opcional de instrumento. Regressões permanentes cobrem resumos/estados/oitava, agregação, limites de trecho, comparação, identidade da execução, atalhos e escopo da supressão dos avisos.

## Etapa 4 — biblioteca autosalva

- `groovegoblin.exercise-library.v1` passa a ser a fonte única dos exercícios. Sessão v5 e metadados ficam separados. As chaves legadas permanecem intactas e o backup cru das seis chaves anteriores é capturado em `groovegoblin.exercise-library.v1.backup` **antes** de `loadSession`.
- Biblioteca é a primeira aba; abre no início quando há mais de um exercício. Com um só, o Estúdio continua sendo a entrada. Novo preserva o anterior e começa sem notas/acordes; duplicar mantém o original.
- Trocas de exercício sincronizam `activeId`, sessão editada e Undo. Duplicar um item não ativo não pode copiar por cima dele a frase que estava no Estúdio.
- Nomes acima de 80 caracteres são rejeitados antes de qualquer escrita. A cópia reserva espaço para “ · cópia”, sem alterar o nome original. Importação incompatível é rejeitada integralmente, sem sobrescrever exercícios.
- Não há descarte automático aos 200 registros. O histórico completo é preservado ao registrar, recarregar e importar; falta de armazenamento continua sendo um erro explícito, não autorização para remover dados.

### Prova no navegador

Fluxos nativos em Chromium privado na porta 5214, mais integração independente na porta 5204:

| Cenário | Resultado observado |
| --- | --- |
| Sessão atual + três antigas distintas | **4 exercícios**, Biblioteca ativa, backup cru e originais preservados |
| Uma antiga idêntica à atual | **3 exercícios**, sem duplicação |
| Somente uma sessão | **1 exercício**, Estúdio ativo |
| Duplicar Arpejos não ativo | cópia abre com **96 BPM**, original de 120 permanece intacto; editar a cópia para 100 não altera o original |
| Excluir ativo / Desfazer | vizinho assume a edição; Desfazer restaura conteúdo e posição, sem sobrescrever o vizinho |
| Renomear / mudar BPM no Estúdio | nome permanece igual em metadados, sessão e campo de edição |
| Novo / recarregar | exercício vazio e todos os anteriores preservados; nenhum botão Salvar na biblioteca em repouso |
| Metadados e busca | etiquetas, alvo **150**, anotações, filtros de instrumento/etiqueta e ordenações exercitados; caret preservado inclusive em inserção no meio da busca |
| Treino nativo de teclado | **3/32** gravado somente no exercício iniciado, com timestamps, BPM e duração reais |
| Treino após integrar o resultado compacto | entrada controlada +30 ms → **32/32**; um registro no dono correto, **120 BPM**, **18.194 ms**; os três outros exercícios continuam sem registros |
| Exportar/importar exercício | metadados, alvo e registro preservados; reimportar não sobrescreve o existente |
| JSON de sessão antigo / biblioteca inteira | importação exercitada; mesmo ID com conteúdo diferente preserva as duas versões |
| Backup e corrupção | downloads reais; bytes corrompidos preservados e baixados exatamente, sem recuperação destrutiva automática |
| Nome de 80 / 81 caracteres | 80 aceito; 81 rejeitado com armazenamento byte a byte inalterado; recarregamento permanece válido |
| Histórico de 201 registros | importação nativa de fixture e recarregamento mantêm **201**, do ID `history-proof-0` ao `history-proof-200` |
| 1440×900 / 1280×800 | documentos **900 / 861 px**, sem overflow horizontal; busca com o estilo comum dos campos |

O histórico de 201 itens é uma fixture de fronteira, não 201 execuções humanas. O teste dessa fronteira falhou antes da correção por perder o primeiro registro e passou depois. O último exercício não é excluído: a interface explica que a biblioteca precisa de ao menos um, mantendo a invariância de exercício ativo.

Capturas reais: [1440×900](rodada-4-biblioteca-1440x900.png), [1280×800](rodada-4-biblioteca-1280x800.png).

Verificação final da branch já sobre a etapa 2: `npm test && npm run check` — **613 aprovados, 1 ignorado, zero falhas**; **145 módulos**, zero falhas. Regressões cobrem migração, backup, corrupção/quota, identidade da execução, ida/volta, nomes e preservação integral dos registros. Testes de encaminhamento por mocks de DOM foram removidos em favor dos fluxos reais acima.

## Etapa 5 — fila de hoje e rotinas

Etapa independente do treinador novo, integrada depois da Biblioteca. `today-store.js` guarda fila e rotinas nomeadas; `today-session.js` fecha os intervalos de prática; `today-view.js` reúne a montagem na Biblioteca e a tira no Treinar. O diário compartilhado `practice-activity.js` registra intervalos fechados por exercício/instrumento, sem inventar duração para registros antigos nem sobrescrever dados corrompidos.

### Prova de interação e tempo

- Sugestão com quatro exercícios: três nunca treinados em ordem de criação, depois o já treinado. Cliques nativos reordenaram Pulso, removeram um item e ajustaram a primeira duração de 5 para 1 minuto; total de **11 minutos em três itens**. Salvar “Rotina real de verificação”, limpar e recriar restaurou a fila em um clique.
- **63 segundos de relógio real**, sem avanço artificial: meta de 1 minuto vencida com `+00:03`, item **1 de 3**, transporte **Parar**, área de toque ativa e posição **Treino · C3 · T4 · 2/16**. Nada interrompeu ou avançou a tomada; somente o clique em **Próximo** parou o áudio e abriu o item 2.
- O diário real recebeu o intervalo de **63.218 ms**, com início/fim e o exercício correto. Pausar e recarregar conservou exatamente os tempos `[63218, 53, 0]`; a fila voltou pausada, sem cobrar o intervalo fora da página.
- Depois de mudar o BPM do segundo exercício por teclado, avançar conservou **30 → 34 BPM**, `finishedAt` e o tempo praticado na loja e no resumo final.
- A prova adicional do responsável usou relógio controlado para o intervalo de dez horas: reabertura pausada, nenhum tempo noturno somado. Também exercitou seleção de outro dono, retomada no item correto, quota, corrupção e downloads dos bytes originais. Esses cenários não são alegações de dez horas de prática física.

### Correções encontradas pela verificação

- O tempo excedido era convertido em booleano antes da formatação e permanecia `+00:00`; passou a usar os milissegundos reais, comprovados por `+00:03`.
- `Próximo` guardava uma referência de item invalidada pela persistência, perdendo BPM final e data de término. Agora reobtém o item após fechar o intervalo; a regressão usa a loja real e verifica resumo e recarregamento.
- Um resumo antigo podia reaparecer junto de uma fila ativa após reload; agora permanece fora da tira enquanto há sessão em andamento, evitando “sessão encerrada” ao lado do timer ativo.

Capturas: [meta vencida durante a tomada, 1440×900](rodada-4-etapa5-parent-zero-1440x900.png), [resumo com mudança de BPM, 1440×900](rodada-4-etapa5-parent-resumo-1440x900.png). As capturas do responsável também cobrem montagem, rotina e 1280×800.

`npm test && npm run check`: **653 aprovados, 1 ignorado, zero falhas**; **152 módulos**, zero falhas. Cobertura de ordem/duração, retomada, intervalos, dono, término manual, quota/corrupção, rotinas e preservação do BPM final. `main.js`: **514 linhas**.

## Etapa 6 — histórico por exercício e Percurso

`exercise-history.js` e `history-charts.js` apresentam os registros da Biblioteca; `history-time.js` une intervalos e divide por datas locais. O Percurso usa o mesmo diário de Hoje e do treinador, sem somar duas vezes um período sobreposto. A etapa foi integrada antes do treinador novo para que seu botão de histórico já tenha destino funcional.

### Provas no navegador

- Histórico aberto por clique no menu de um exercício não ativo: alvo **150 BPM**, melhor autoral **120 BPM**, gráfico de aproveitamento **100%**, data local, lista e **18 s** de tempo conhecido. O registro foi produzido pelo avaliador na prova anterior de 32 ataques com timestamps controlados, não por equipamento físico.
- Download real `guitarra-pratica-completa-historico.json`: **2.636 bytes**, envelope `groovegoblin-exercise-history`, exercício/alvo/instrumento e o registro completo com intervalo de **18.194 ms**.
- Percurso integrado aos intervalos reais da fila: **10 min 24 s**, **28 datas locais**, três registros avaliados e sete blocos de Hoje. Acrescentar ao diário uma cópia do intervalo de 18.194 ms já presente no registro aumentou a contagem de blocos do treinador para um e conservou **10 min 24 s**: tempo sobreposto contou uma vez.
- Exportação anterior preservada: download `groovegoblin-percurso.json`, **6.029 bytes**, com os dois registros legados. O controle passou a dizer **Exportar registros anteriores**, em **Dados anteriores**, para não prometer exportação de dados que pertencem à Biblioteca.
- Limpeza explícita com confirmação: registro do exercício passou de um para zero; sessão e metadados ficaram byte a byte iguais, assim como os demais exercícios e a chave do histórico anterior. O diálogo mostrou o estado vazio.
- As provas do responsável também cobriram guitarra/baixo, progresso autoral **100 → 124 BPM**, mudanças de alvo, sobreposição com um bloco controlado de 20 minutos, legado sem intervalos e downloads de dados corrompidos. As tomadas usaram eventos com timestamps controlados no transporte/avaliador reais.

Correção de fronteira: registros sem data ficavam antes dos recentes ao inverter a ordem cronológica; agora permanecem ao fim nos dois sentidos, sem inventar data. Testes também cobrem BPM ausente, importação com `ownerId` antigo (o dono é o exercício que contém o registro), material gerado sem progresso autoral, meia-noite local e horário de verão.

Capturas do integrador: [histórico, 1440×900](rodada-4-etapa6-parent-historico-1440x900.png), [Percurso, 1440×900](rodada-4-etapa6-parent-percurso-1440x900.png), [Percurso, 1280×800](rodada-4-etapa6-parent-percurso-1280x800.png). Sem overflow horizontal nos dois tamanhos; o histórico anterior continua disponível abaixo do panorama.

`npm test && npm run check` após integrar Hoje: **683 aprovados, 1 ignorado, zero falhas**; **158 módulos**, zero falhas. `main.js`: **523 linhas**; `practice.js`: **1988**, sem crescimento nesta etapa.

## Etapa 7 — diagnóstico da entrada

Etapa independente, verificada antes das etapas de biblioteca/treinador. A captura existente é compartilhada: exportar JSON não grava áudio; “Salvar amostra · 10 s” é a única ação que começa a retenção de PCM para um WAV.

### Prova no navegador e no arquivo baixado

- Chromium isolado com dispositivo de áudio virtual alimentado por WAV sintético privado, estéreo, 48 kHz; silêncio à esquerda e notas à direita. **Não houve instrumento físico disponível.** Os ataques e alturas abaixo vieram de `getUserMedia → AudioWorklet → detectores`, não de notas esperadas nem de resultados fabricados.
- “Testar entrada”, canal 2: JSON baixado com três ataques observados. Alturas identificadas de 41,2 e 55 Hz, confiança 0,9998/0,9999; o ataque encerrado antes da estimativa permaneceu `null`, sem adivinhação.
- Treino real de quatro compassos/duas repetições: outro JSON baixado com `source: "training"` e **13 ataques**. Estimativas observadas incluíram 30,87; 41,2; 55; 98; 82,41; 110; 146,83 e 196 Hz. O JSON informa dispositivo/canal/taxa/sensibilidade/compensação/perfil e unidades, com `audio: false`; não contém PCM nem alturas esperadas.
- Clique explícito em “Salvar amostra · 10 s”: download de **960.044 bytes**, **480.000 frames**, **48.000 Hz**, **mono PCM de 16 bits**. `ffprobe` confirmou duração **10,000000 s**. RMS medido 0,1358, pico 0,4657: arquivo contém sinal, não silêncio substituto.
- Um pedido de `getUserMedia` e zero chamadas a `track.stop()` durante teste, gravação concluída, cancelamento manual e troca de canal. A gravação não abriu outro microfone nem encerrou a captura emprestada.
- Cancelar após receber PCM e trocar de canal durante outra amostra descartaram as gravações, sem arquivos adicionais. Abrir outra aba de verdade durante a gravação disparou perda de foco: a entrada voltou ao Teclado, a amostra foi descartada e a faixa de captura foi encerrada uma vez.
- Nenhum recurso de origem externa observado. As chaves de armazenamento permaneceram as de sessão/preferências/histórico; não foi criada chave para áudio.

Captura: [configuração e exceção explícita de gravação, 1440×900](rodada-4-diagnostico-1440x900.png). Configuração expandida pode rolar; não é o estado de repouso usado nos limites do treinador.

### Testes e fixture opcional

- `npm test && npm run check`: **579 aprovados, 1 ignorado, zero falhas**; **138 módulos**, zero falhas. O único ignorado é o teste de WAV real, pois a pasta não contém amostras distribuídas.
- Prova do outro ramo: WAV sintético estéreo temporário em `tests/fixtures/instrument/r4-private-proof.wav`, com sidecar de oito onsets conhecidos (`0.5 + n × 1.2` segundos), canal de índice 1, 48 kHz, tolerância 35 ms. `node --test --test-name-pattern="supplied real instrument WAVs" tests/instrument-diagnostics.test.js`: **1 aprovado, nenhum ignorado**. WAV e sidecar temporários removidos depois.
- Contrato do sidecar: `expectedOnsets` em segundos; opcionais `channel` (índice a partir de zero), `sampleRate`, `sensitivity`, `refractory`, `instrumentType` e `toleranceSeconds`. O teste decodifica o WAV e executa o detector real em blocos de 128 amostras.
- Testes permanentes exercitam duração exata, opt-in, cancelamento, callbacks atrasados após encerramento, compartilhamento da captura, formato WAV e ataques/alturas observados. Asserções de redação e de arredondamento incidental foram removidas.

## Etapa 3 — um treinador para seis combinações

- Fonte **Frase da sessão / Exercício gerado** × modo **Avaliado / Tocar junto / Rotina**, com uma partitura, entrada, transporte e resultado. O botão principal assume a ação da etapa; não existe outro botão primário de rotina. Durante Ouvir, a prévia redundante fica oculta.
- Referência gerada é transitória, inclusive na prévia “Ouvir frase”; não precisa substituir as notas autorais. Prova com frase vazia: Treinar e Ouvir permaneceram disponíveis e a execução recebeu notas `ex-*`, enquanto a biblioteca manteve zero notas. Aplicar é ação explícita no Avançado; Desfazer restaurou a sessão anterior byte a byte.
- Execução real a 180 BPM, quatro compassos/duas repetições, com timestamps controlados de +5 ms: **32/32**, registro `source: generated` associado ao dono inicial, andamento canônico ainda 180. O cartão manteve **Melhor BPM: 120**, sem inflar o progresso autoral. Outra tomada controlada de +30 ms mostrou atraso mediano de **30,000 ms** e comparação anterior; em 180 BPM esse desvio excede a tolerância estrita existente. Não houve alteração no avaliador nem alegação de instrumento físico.
- Prova nativa da rotina pelo transporte único: ouvir → tocar → ler → memorizar → improvisar → concluir, cinco etapas completas. Memorizar manteve dois compassos silenciosos (cliques observados separados por 500/500/500/4500 ms). Tocar junto acelerou 120→125→130 e restaurou 120 ao parar.
- Integração com Hoje: **Próximo durante loop real** interrompeu `loop → idle`, abriu o item seguinte e fechou um intervalo `together` de **742 ms**, com o dono correto. O intervalo da fila foi preservado separadamente; Percurso une sobreposições.
- Histórico e revisões abre o histórico real do exercício. Jogos de ouvido em **Explorar → Jogos de ouvido**: pergunta gerada, prévia real e resposta “Correto: 3ª maior (4 semitons)” observadas.

### Layout medido

Em 1440×900, todas as combinações tiveram documento de **900 px**, sem overflow horizontal. Contagem de `button,input,select,summary` visíveis, incluindo desabilitados:

| Fonte | Modo | Painel | Página inteira |
| --- | --- | ---: | ---: |
| Sessão | Avaliado | 18 | 24 |
| Sessão | Tocar junto | 18 | 24 |
| Sessão | Rotina | 19 | 25 |
| Gerado | Avaliado | 20 | 26 |
| Gerado | Tocar junto | 20 | 26 |
| Gerado | Rotina | 21 | 27 |

Em 1280×800, as seis combinações ficaram entre **801 e 875 px**, sem overflow horizontal; pode haver rolagem vertical nessa altura menor, dentro do limite solicitado de 900 px. A captura final Gerado/Rotina mede 874 px.

Capturas: [1440×900](rodada-4-treinador-parent-gerado-1440x900.png) e [1280×800](rodada-4-treinador-parent-1280x800.png).

- Suíte integrada: **690 aprovados, 1 fixture opcional ignorada, zero falhas**; **161 módulos**, zero falhas. `practice.js` foi reduzido de 1988 para **1048 linhas**; integração de Hoje extraída para `today-view.js`, mantendo `main.js` dentro do limite.

## Etapa 8 — integração, documentação e offline

- README, guia, tour e ajuda de teclado atualizados para exercício/biblioteca, seis combinações do treinador, resultado, Hoje, histórico, jogos deslocados e diagnóstico. O documento musical continua v5; o envelope de exercício inclui metadados separados.
- Exportar pelo menu do Estúdio preservou etiquetas, alvo, anotações e um registro real; importar aumentou a biblioteca de quatro para cinco itens sem alterar os originais. Importar sessão legada a 77 BPM criou o sexto item. Renomear seguido de mudar BPM e Desfazer respeitou duas transações independentes, sem desfazer o nome junto do andamento.
- Recuperação exercitada em perfil privado: JSON corrompido permaneceu byte a byte intacto enquanto a cópia recuperada em memória foi exportada. Com biblioteca explicitamente vazia, o menu baixou `groovegoblin-documento-atual.json`, documento musical v5, com aviso de que não contém metadados; nenhum dado ausente foi inventado.
- Tour completo, **sete etapas**: Biblioteca → Instrumento → Edição → Harmonia/Braço → Treinador → Músicas → Atividades. Todos os cartões ficaram dentro de 1440×900. Fechar restaurou aba, painéis e menus; biblioteca permaneceu byte a byte igual e foco voltou a Como usar. Setas e Esc exercitados; ajuda de atalhos mostra Enter/L/−/+ e Esc fecha o diálogo.
- Na integração final, Hoje acrescentava uma linha e levava Gerado/Rotina a **952 px**. A tira passou a compartilhar a linha do transporte, sem diminuir a partitura nem remover controles. Com Hoje ativo, as seis combinações mediram **900 px** e **27/27/28/29/29/30 controles na página inteira**, respectivamente Sessão Avaliado/Junto/Rotina e Gerado Avaliado/Junto/Rotina. Sem avisos transitórios ou painéis avançados abertos. Em 1280×800, Gerado/Rotina com Hoje mediu **874 px**, sem overflow horizontal.
- Estúdio final, quatro faixas e Tab de seis cordas: **900 px**, **50 controles no painel / 56 na página** em 1440×900. Em 1280×800: **886 px**, sem overflow horizontal. Inspetor continua antes do Braço.

### Offline em subdiretório

`npm run build` e servidor do pacote em `/groovegoblin/`, não apenas servidor do código-fonte:

1. Preparar uso offline instalou e ativou o service worker.
2. Rede desativada no Chromium (`navigator.onLine === false`) e recarregamento: biblioteca com quatro exercícios preservada; referência gerada tocou em loop real; histórico exibiu os dois SVGs e o alvo de 150 BPM; guia abriu; Hoje contou 04:59, encerrou e mostrou resumo; jogo de ouvido gerou alternativas; Percurso mostrou os intervalos conhecidos.
3. Uma nova compilação produziu atualização instalada/aguardando. Aplicar enquanto tocava foi recusado com **“Pare a reprodução ou o treino antes de aplicar a atualização.”** O transporte continuou em Parar, sem recarga.
4. Após Esc, Aplicar ativou a versão final (`6ac1f9957e2b69aa3713785d`) e removeu o cache anterior. Novo recarregamento sem rede confirmou a tira integrada, **900 px / 30 controles**, sem perder a fila.

### Verificação final e limites

- Branch de fechamento: `npm test && npm run check && npm run build` — **690 aprovados, 1 ignorado, zero falhas**; **161 módulos**, zero falhas; distribuição estática gerada.
- `main.js`: **531 linhas**, limite 533. `practice.js`: **1048 linhas**, abaixo das 1988 iniciais. Nenhuma dependência runtime adicionada.
- Suítes anteriores continuam aprovadas, incluindo sessão/notação/perfis, áudio, entrada/calibração/afinação, banda, forma, repertório e proteção dos dados. Verificação visual integrada cobriu Estúdio, treinador, fila, histórico/Percurso, ouvido, tour e offline. O algoritmo de avaliação e o esquema v5 foram preservados; arquivos `repertoire*.js` não foram alterados.
- **Limite físico:** não havia guitarra/baixo/interface reais disponíveis. Diagnóstico e alturas foram verificados com sinais sintéticos e dispositivo virtual; as tomadas temporizadas são identificadas como controladas. O teste opcional sem WAV continua explicitamente ignorado, e o ramo com fixture foi exercitado na etapa 7. Em 1280×800 pode haver rolagem vertical: o limite solicitado de 900 px é respeitado, sem alegar que todo conteúdo cabe em 800 px.

Capturas finais:

- Estúdio: [1440×900](rodada-4-final-estudio-1440x900.png), [1280×800](rodada-4-final-estudio-1280x800.png).
- Hoje + Gerado/Rotina: [1440×900](rodada-4-final-hoje-treinador-1440x900.png), [1280×800](rodada-4-final-hoje-treinador-1280x800.png).
- [Tour](rodada-4-tour-1440x900.png), [treinador offline](rodada-4-offline-treinador-1440x900.png), [Percurso offline](rodada-4-offline-percurso-1440x900.png).

## Critérios de aceitação

| Nº | Critério | Estado observado |
| --- | --- | --- |
| 1 | Resultado 4 compassos/2 repetições sem rolar | Aprovado na etapa 2 |
| 2 | Partitura anotada, sinais, cores e desvios | Aprovado na etapa 2; navegador e regressões derivadas |
| 3 | Atraso uniforme de 30 ms descrito com precisão | Aprovado na etapa 2; timestamps controlados, sem alegação de hardware |
| 4 | Pior compasso e treino do trecho | Aprovado na etapa 2 |
| 5 | Repetir, −10 BPM e +4 BPM condicionado | Aprovado na etapa 2 |
| 6 | Comparação com tentativa anterior | Aprovado na etapa 2 |
| 7 | Sem timeline sobreposta; tabela recolhida | Aprovado na etapa 2 |
| 8 | Treinador único, seis combinações | Aprovado na etapa 3; material transitório, rotina completa e loop real |
| 9 | Treinador com até 30 controles e 900 px | Aprovado nas etapas 3 e 8; seis combinações inclusive com Hoje ativo: 27–30 controles, 900 px |
| 10 | Jogos de ouvido em Explorar | Aprovado na etapa 3; pergunta, prévia e resposta no navegador |
| 11 | Migração integral, deduplicação e backup | Aprovado na etapa 4 |
| 12 | Autosave, Novo e recarregamento | Aprovado na etapa 4 |
| 13 | Metadados, filtros e ordenação | Aprovado na etapa 4 |
| 14 | Registro no exercício dono da execução | Aprovado na etapa 4; também após integrar o resultado |
| 15 | Intercâmbio de metadados e legado | Aprovado na etapa 4 |
| 16 | Fila de hoje, timer, resumo e retomada | Aprovado na etapa 5; inclusive 63 segundos de relógio real durante tomada ativa |
| 17 | Histórico com gráficos e alvo | Aprovado na etapa 6; gráficos, download, limpeza e união temporal exercitados no navegador |
| 18 | Ordem do inspetor com Braço aberto/fechado | Aprovado na etapa 1 |
| 19 | Estúdio com quatro faixas e Tab sem rolar, até 58 controles | Aprovado na etapa 1 |
| 20 | Cordas nomeadas e Drop D | Aprovado na etapa 1 |
| 21 | Baixo sem convite redundante nem baixo gerado forçado | Aprovado na etapa 1 |
| 22 | Diagnóstico JSON, WAV explícito e fixtures opcionais | Aprovado na etapa 7; áudio sintético, sem hardware físico |
| 23 | Preservação das rodadas anteriores | Aprovado nas suítes completas e smoke integrado; limites físicos e de viewport explicitados acima |
