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
| 8 | Treinador único, seis combinações | Pendente |
| 9 | Treinador com até 30 controles e 900 px | Pendente |
| 10 | Jogos de ouvido em Explorar | Pendente |
| 11 | Migração integral, deduplicação e backup | Pendente |
| 12 | Autosave, Novo e recarregamento | Pendente |
| 13 | Metadados, filtros e ordenação | Pendente |
| 14 | Registro no exercício dono da execução | Pendente |
| 15 | Intercâmbio de metadados e legado | Pendente |
| 16 | Fila de hoje, timer, resumo e retomada | Pendente |
| 17 | Histórico com gráficos e alvo | Pendente |
| 18 | Ordem do inspetor com Braço aberto/fechado | Aprovado na etapa 1 |
| 19 | Estúdio com quatro faixas e Tab sem rolar, até 58 controles | Aprovado na etapa 1 |
| 20 | Cordas nomeadas e Drop D | Aprovado na etapa 1 |
| 21 | Baixo sem convite redundante nem baixo gerado forçado | Aprovado na etapa 1 |
| 22 | Diagnóstico JSON, WAV explícito e fixtures opcionais | Aprovado na etapa 7; áudio sintético, sem hardware físico |
| 23 | Preservação das rodadas anteriores | Suítes aprovadas nas etapas 1, 2 e 7; revisão final pendente |
