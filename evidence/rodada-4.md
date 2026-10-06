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

## Critérios de aceitação

| Nº | Critério | Estado observado |
| --- | --- | --- |
| 1 | Resultado 4 compassos/2 repetições sem rolar | Pendente |
| 2 | Partitura anotada, sinais, cores e desvios | Pendente |
| 3 | Atraso uniforme de 30 ms descrito com precisão | Pendente |
| 4 | Pior compasso e treino do trecho | Pendente |
| 5 | Repetir, −10 BPM e +4 BPM condicionado | Pendente |
| 6 | Comparação com tentativa anterior | Pendente |
| 7 | Sem timeline sobreposta; tabela recolhida | Pendente |
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
| 22 | Diagnóstico JSON, WAV explícito e fixtures opcionais | Pendente |
| 23 | Preservação das rodadas anteriores | Suíte aprovada na etapa 1; revisão final pendente |
