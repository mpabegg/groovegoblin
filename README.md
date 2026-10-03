# GrooveGoblin

Compositor e treinador rítmico web local e privado. Frases de **1, 2 ou 4 compassos em 4/4**, uma linha monofônica e 16 posições de semicolcheia por compasso. Sem backend de aplicação, contas, dependências de runtime, fontes externas ou envio automático de dados. Os links da biblioteca só acessam a internet quando você os abre.

## Executar

Requer Node.js 22 ou posterior e um navegador moderno com Web Audio. Verificação feita no Chrome for Testing 149.0.7827.54.

```sh
cd /home/mat/code/groovegoblin
npm start
```

Abra **http://127.0.0.1:5173**. Não é necessário `npm install`. Node serve apenas arquivos estáticos em loopback; não recebe nem processa frases. Porta alternativa: `PORT=5174 npm start`. Pare com Ctrl+C.

Use sempre a mesma origem (protocolo, host e porta): `localhost`, `127.0.0.1` e portas diferentes têm armazenamentos separados. `file://` não é suportado por causa dos módulos ES.

## Composição e edição

1. Escolha **Compassos: 1, 2 ou 4**. Diminuir o tamanho é rejeitado se uma nota ultrapassar o novo fim; nenhuma nota é apagada silenciosamente.
2. Clique numa posição vazia para criar uma nota de uma semicolcheia. Clique no bloco para selecionar, arraste o corpo para mover e puxe a borda direita para redimensionar.
3. Use **Início** (posição absoluta na frase, começando em 1), **Duração** (semicolcheias) ou os botões de duração. Durações 1, 2, 3, 4, 6, 8, 12 e 16 representam semicolcheia, colcheia, colcheia pontuada, semínima, semínima pontuada, mínima, mínima pontuada e semibreve. Outros inteiros também são válidos, até o fim da frase.
4. **Excluir nota** apaga a seleção; **Limpar frase** apaga a frase inteira. **Desfazer/Refazer** recuperam notas, BPM e quantidade de compassos, incluindo carregamento de padrões, geração e importação. Até 100 estados recentes, contando o atual; nova edição após desfazer descarta o ramo de refazer.
5. Para frases longas, role horizontalmente o grid. A partitura usa a mesma área de rolagem. Durante reprodução/treino, a área acompanha o cursor; no treino, as ferramentas de inspiração são recolhidas e o grid é trazido à vista.

Ataques e durações são quantizados. Operações inválidas são rejeitadas: não empurram notas, não sobrepõem e não ultrapassam o fim. Terminar exatamente na barra final é válido; sustentar através de uma barra interna também. Pausas são espaços vazios. Notas adjacentes permanecem distintas, com novo ataque. A barra final indica o início do próximo loop, **não uma posição extra**. Cada tempo usa `1 e & a`: `&` é o contratempo de colcheia; `e` e `a` são subdivisões de semicolcheia.

### Atalhos

| Tecla | Ação |
| --- | --- |
| ← / → | Mover a nota selecionada por 1 semicolcheia |
| ↑ / ↓ | Aumentar / diminuir a duração por 1 semicolcheia |
| Shift + setas | Passo de 4 semicolcheias |
| 1 / 2 / 3 / 4 / 6 / 8 | Duração de 1 / 2 / 3 / 4 / 6 / 8 semicolcheias |
| Delete / Backspace | Excluir a nota selecionada |
| Ctrl+Z | Desfazer |
| Ctrl+Y / Ctrl+Shift+Z | Refazer |
| Escape | Parar a sessão |
| Espaço durante treino | Pressionar = ataque; soltar = término |

Atalhos de edição não atuam dentro de campos e seletores nem durante uma sessão. Tab permite focar as posições do grid; Enter/Espaço em uma posição vazia criam a nota. O histórico dura apenas até fechar/recarregar; a frase atual continua salva.

## Partitura rítmica

Logo abaixo do grid: **pauta de uma linha, sem alturas, nomes de notas ou clave tonal**. Todos os símbolos de nota ficam na mesma altura. Mostra figuras rítmicas, pausas, pontos de aumento e barras em 4/4; acompanha criação, arraste, resize, campos, presets, desfazer/refazer, importação, biblioteca e gerador.

Notas com valores não convencionais e sustentações fora de alinhamento métrico são divididas em figuras convencionais **ligadas**. Uma duração de 5 ticks iniciada no tempo vira semínima + semicolcheia ligadas; 6 ticks no tempo viram semínima pontuada. Notas de 3, 6 e 12 ticks mantêm, quando alinhadas, colcheia, semínima e mínima pontuadas. Sustentações entre compassos recebem ligadura entre as partes. Uma ligadura **não pede novo ataque**; notas adjacentes diferentes não são ligadas.

Pausas usam somente figuras **sem ponto**, escolhendo a maior que cabe no silêncio sem atravessar a barra e respeitando o alinhamento: semibreve no início de um compasso completo, mínima nos tempos 1 ou 3, semínima no início de um tempo, colcheia em subdivisão de colcheia e semicolcheia nas demais posições. Assim, um silêncio de 6 ticks começando após uma colcheia vira pausa de colcheia + pausa de semínima, mostrando o limite entre tempos; intervalos ímpares preservam exatamente o silêncio com pausas de semicolcheia onde necessário. Compasso vazio mostra uma pausa de compasso centralizada.

O desenho é SVG geométrico local, sem fonte musical ou biblioteca externa. Colcheias e semicolcheias têm bandeirolas individuais, sem agrupamento por feixes. A partitura é uma representação do ritmo quantizado, não uma transcrição de alturas ou de uma execução de treino.

## Biblioteca padrão

Abra **Biblioteca de grooves e gerador**, escolha o padrão e clique em **Carregar padrão**. Substitui frase, compassos e BPM; Desfazer recupera o estado anterior. Todas as notas carregadas são editáveis; a biblioteca não é alterada ao editar a frase.

| Padrão | Compassos | Ataques, em ticks começando em 0 |
| --- | --- | --- |
| Pulso em semínimas | 1 | 0, 4, 8, 12 |
| Contratempos de colcheia | 1 | 2, 6, 10, 14 |
| Tresillo — 3+3+2 | 1 | 0, 6, 12 |
| Cinquillo — 2+1+2+1+2 | 1 | 0, 4, 6, 10, 12 |
| Son clave 3–2 | 2 | 0, 6, 12, 20, 24 |
| Son clave 2–3 | 2 | 4, 8, 16, 22, 28 |

Os dois primeiros são exercícios próprios. Os padrões tradicionais usam fontes da **Berklee PULSE**, disponíveis também na interface:

- [The Foundational Rhythms of New Orleans](https://pulse.berklee.edu/?id=4&lesson=376): [Bamboula/Tresillo](https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Bamboula.jpg) e [Cinquillo](https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Cinquillo.jpg).
- [The Clave](https://pulse.berklee.edu/?id=4&lesson=14): [Son clave 3–2](https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Son-Clave.jpg) e [Son clave 2–3](https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/lesson5_banded/2_3_son_graphic.png).

As fontes fundamentam os **ataques**. BPM e sustentações são escolhas didáticas, explicitadas em cada entrada; não reproduzem o decaimento de claves, uma bateria completa ou uma gravação conhecida. Tresillo aqui é 3+3+2 em colcheias, não tercinas. A descrição/fontes se referem ao padrão selecionado, não às alterações posteriores feitas pelo usuário.

## Gerador semi-aleatório

1. Escolha o tamanho da frase em **Compassos** e o BPM normalmente.
2. Selecione densidade de **2, 4 ou 8 notas por compasso**, preferência de ataques nos tempos/mistos/sincopados e durações curtas/variadas/longas.
3. **Nova variação** sorteia uma semente uint32 e gera a frase. **Gerar com esta semente** repete a semente exibida; mesmos parâmetros e semente geram as mesmas notas.

Mantém BPM e quantidade de compassos atuais. São preferências ponderadas, não proibições: “mais nos tempos” ainda pode produzir síncopes. Ataques são sorteados sem reposição por compasso; durações inteiras são limitadas pelo próximo ataque ou pelo fim, sem sobreposição, podendo atravessar barras internas. “Curtas” usa sempre 1 tick; as outras opções incluem sustentações e pausas. Trocar apenas a opção de duração preserva os ataques para a mesma semente.

Método: PRNG Mulberry32 determinístico; “mais nos tempos” usa pesos 12/3/1 para tempos/contratempos de colcheia/demais ticks; “mais sincopados” usa 1 nos tempos e 4 nas outras subdivisões; mistos usa pesos iguais. A nova semente vem de `crypto.getRandomValues`, não de um serviço remoto. Não há promessa de composição estilística ou de identificar um gênero. Opções/semente do gerador não entram no histórico ou no JSON; **Exportar** preserva o resultado completo.

## Ouvir e treinar

Ajuste BPM inteiro entre **40 e 240**. **Ouvir em loop** usa tom triangular sustentado de 440 Hz, ataque de 4 ms e release de 15 ms terminando na borda nominal. Ative/desative metrônomo durante o loop; cliques já agendados podem permanecer por aproximadamente 100 ms. **Parar** ou Escape interrompem a sessão. Edição, biblioteca, gerador e BPM ficam bloqueados durante uma sessão.

O áudio usa agendamento Web Audio com lookahead de 100 ms, acordando a cada 25 ms. Toda a frase repete a partir de uma única origem temporal, sem pausa adicional na emenda. Pausas escritas na frase continuam sendo pausas. A animação consulta o relógio; não dispara sons.

1. Ouça a referência antes do treino.
2. Clique em **Começar treino**. Aguarde **um compasso** de entrada, independentemente do tamanho da frase.
3. Reproduza **quatro vezes a frase inteira**. Pressione Espaço no ataque, mantenha durante a duração e solte no término.
4. Grid e partitura ficam visíveis; durante a avaliação, **somente o metrônomo toca**. Referência e pressões não são sonificadas.
5. Veja timeline e tabela de feedback por repetição; ouça a referência novamente quando quiser.

Treino requer teclado físico. Pressões iniciadas na entrada são ignoradas, mesmo se mantidas até a avaliação. Repetição automática do teclado não cria ataques. Segurar através de uma fronteira não divide a tentativa. Uma pressão ainda mantida no fim é encerrada nessa borda; não é possível medir quanto você a manteria depois. Parar, Escape, perder foco ou trocar de aba cancelam treino e descartam resultados parciais.

## Feedback: método e latência

Sem pontuação única. Timeline sobrepõe referência e execução, marca ataques e términos separadamente e distingue omitidas/extras; tabela conserva os desvios exatos em milissegundos. Valores negativos = antes; positivos = depois. Geometria que ultrapassa uma janela de repetição é recortada e indicada; os desvios numéricos não são corrigidos por esse recorte. Editar frase/BPM/tamanho invalida o feedback anterior.

A referência é expandida numa timeline contínua de **quatro frases**, não quatro compassos quando a frase tem mais de um. Matching ordena por ataque e associa a primeira tentativa na janela de um ataque esperado, sem usar duração para escolher a associação. Ataques anteriores à janela são extras; esperados ultrapassados são omitidos. Finais só são comparados depois da associação. A repetição de uma nota associada vem da referência; a de uma extra é estimada pela janela de frase em que seu ataque ocorreu.

- `tickMs = 15000 / BPM`.
- Janela de associação: **±meio tick**, `7500 / BPM` ms.
- Tolerância independente de ataque e término: **±um quarto de tick**, `3750 / BPM` ms, bordas inclusivas.
- A 100 BPM: associação ±75 ms; tolerância ±37,5 ms, apresentada arredondada para 38 ms.
- A 240 BPM: tolerância ±15,625 ms; latência passa a ter mais influência.

Duração correta não apaga deslocamento: uma nota inteira atrasada pode ter ataque e término atrasados. Fora da janela, aparece omitida + extra. No meio exato entre ataques adjacentes, o desempate favorece o esperado anterior. Duas tentativas na mesma janela não têm identificação infalível de intenção. Não há realinhamento global nem calibração automática/manual.

Scheduler usa `AudioContext.currentTime`. Indicador, limites de captura e fim do treino usam `getOutputTimestamp()` quando válido; timestamps do teclado são convertidos pelo par `contextTime/performanceTime`. Isso é uma **estimativa do navegador**, não medição independente da chegada do som ao ouvido. Sem essa API, usa um par fresco `currentTime/performance.now()`, sem compensar latência de saída.

Teclado, SO, navegador, driver, hardware, Bluetooth e percepção afetam os resultados. Prefira fones com fio e use o feedback para comparar padrões, não para alegar precisão absoluta. Travamentos maiores que o horizonte do scheduler podem causar falhas de áudio; não há promessa de tempo real rígido.

## JSON, persistência e privacidade

**Exportar** baixa `groovegoblin-frase.json`. **Importar** carrega atomicamente uma frase: JSON incorreto, formato/versão desconhecidos, campos desconhecidos, IDs duplicados, BPM inválido, sobreposição ou notas fora do limite são rejeitados sem alterar a frase. Importação também pode ser desfeita.

Formato: `format: "groovegoblin-phrase"`, `version: 1`, `bpm`, `bars` e `notes` com `id`, `start` e `duration`. Ticks e inícios começam em 0 no arquivo. Arquivos sem `bars` são interpretados como um compasso; novos arquivos sempre incluem o campo. O formato contém só a frase/BPM/tamanho, não resultados de treino, histórico, biblioteca ou opções do gerador.

Frase, BPM e tamanho são salvos após mudanças válidas em `localStorage`, chave `groovegoblin.v1`. Estados antigos sem tamanho continuam como um compasso. Armazenamento bloqueado mantém o app funcionando em memória com aviso; dados inválidos são tratados conservadoramente. Limpar dados do navegador apaga a frase. Nenhum repositório remoto/publicação foi criado.

## Verificar

```sh
npm test
npm run check
```

**185 testes passaram, zero falhas/skip**, com checagem sintática de todos os módulos e servidor. Cobrem limites, sobreposição, adjacência, estados/histórico, importação, matching e desvios independentes, biblioteca, 8.100 combinações do gerador e todas as posições/durações válidas da partitura em 1/2/4 compassos, incluindo pausas sem ponto alinhadas à métrica, silêncios de 1/3/6/12 ticks e entre compassos, preservação de notas pontuadas e ligaduras. Testes não substituem o navegador.

### Roteiro manual

1. Carregue Tresillo; edite duração para 3, depois 5; veja ponto e ligadura na partitura. Arraste/redimensione e confirme atualização; carregue Pulso e confirme quatro ataques sem ligaduras entre notas adjacentes.
2. Escolha 4 compassos; gere com semente 42, densidade 2, ataques mais sincopados e durações longas. Peça nova variação; desfaça; repita 42. Tente semente −1 e redução que exclua notas: a frase deve permanecer intacta.
3. Exporte, altere a frase/BPM e importe o arquivo. Desfaça/refaça a importação. Reabra a mesma origem e confira frase/BPM/tamanho/partitura.
4. Ouça em loop; alterne metrônomo. Treine uma frase de 2 compassos: entrada tem 4 cliques, quatro frases têm 32, total 36. Para 4 compassos, total 68.
5. Desloque uma nota inteira, encurte outra, omita e acrescente ataques. Confira timeline e tabela; mantenha a última pressão até o fim para observar encerramento na borda.

### Evidência observada

Smoke desktop em Chrome real, com eventos nativos de mouse/teclado; verificação multicompasso posterior em origem isolada na porta 5174 para não disputar o estado do uso normal na 5173.

- Desfazer/refazer de notas, BPM, tamanho e importação; edição após desfazer desativou refazer. Presets, setas, arraste/resize, rejeição de redução e de sobreposição exercitados.
- Download real concluído pelo navegador (260 bytes), upload desse arquivo restaurou notas/BPM/tamanho; arquivo com sobreposição rejeitado e `localStorage` preservado. Restauração de frase de 4 compassos, 240 BPM e oito notas, incluindo sustentações cruzando barras, comprovada após recarregar.
- Todos os seis padrões carregados pela UI; número de ataques da partitura conservou cada padrão. Gerador reproduziu semente 42, criou nova variação e desfez; semente inválida preservou a frase. Densidade 8 em 4 compassos produziu 32 ataques de semicolcheia na partitura.
- Partitura: pausas em frases importadas comprovadas em uso real da UI. No arquivo de prova de 2 compassos, BPM 100, as pausas foram (início,duração): (2,2) colcheia, (4,4) semínima, (8,8) mínima, (16,4) semínima, (22,2) colcheia, (26,2) colcheia e (28,4) semínima; todas sem ponto. Os ataques importados permaneceram em 0, 20 e 24. Redimensionar a última nota de 2 para 4 semicolcheias removeu a pausa em 26 e manteve a pausa em 28; Desfazer restaurou a frase e as pausas. `evidence/rhythm-rests-corrected.png` mostra a partitura renderizada no navegador. Gerador, semente 321, densidade 8, curtas e mistos: nova captura de 4 compassos com 32 ataques e a gramática corrigida, sem pausas pontuadas.
- Loop de 2 compassos a 120 BPM: mesma nota reapareceu após **4,000 s**; sustentações agendadas de **0,750 s** e **0,125 s**. Loop de 4 compassos a 240 BPM também repetiu após **4,000 s**. Metrônomo ativado durante reprodução. `evidence/audio-multibar.wav` captura seis segundos do monitor real PipeWire, com sustentações medidas de cerca de 0,749 s e 0,125 s e recorrência de quatro segundos; houve uma captura inicial silenciosa antes da reprodução ativa, substituída por esta captura durante o loop.
- Treino completo de 2 compassos: **36 cliques**, nenhum tom de referência; 2 associadas, 6 omitidas, 1 extra. Nota deslocada: ataque **+44 ms**, término **+42 ms**; outra: ataque **+11 ms**, término **−548 ms**; extra durou 100 ms.
- Treino completo de 4 compassos: **68 cliques**, nenhum tom de referência; 2 associadas, 30 omitidas. Última pressão mantida até o fim: ataque +2 ms, término 0 ms na borda. Smoke após integrar partitura: treino de 1 compasso produziu 20 cliques, com grid/partitura visíveis e somente metrônomo.

Arquivos de prova: `evidence/desktop-rhythm-score.png`, `evidence/rhythm-score-four-bars.png` (panorama montado de capturas reais esquerda/meio/direita com rolagem horizontal; sem sintetizar a partitura), `evidence/rhythm-rests-corrected.png`, `evidence/desktop-score-training.png`, `evidence/desktop-feedback-multibar.png`, `evidence/desktop-feedback-four-bars.png` e `evidence/audio-multibar.wav`. As capturas intermediárias atualizadas são `evidence/score-left.png`, `evidence/score-middle.png` e `evidence/score-right.png`. Evidências anteriores do MVP continuam em `evidence/desktop-feedback.png`, `evidence/mobile-editor.png` e `audio-smoke.wav`.

Não comprovados: avaliação humana subjetiva do áudio, outros navegadores/dispositivos, Bluetooth, precisão absoluta por medição externa ou carga extrema. O layout móvel não foi o foco desta rodada.

### Decisões e delegação

JavaScript ESM/CSS nativos e SVG geométrico: sem framework, pacote musical, fonte remota ou backend. Parent mantém a integração dos fluxos compartilhados. Biblioteca distingue ataques fundamentados de durações editoriais; gerador usa semente reproduzível e preferências simples, sem prometer estilo musical; notação preserva sustentações com ligaduras em vez de inventar ataques.

Nesta rodada, seis agentes `task` com **`openai-codex/gpt-6.1-sol:medium`** entregaram histórico, JSON, timeline, biblioteca, gerador e partitura. Histórico/JSON/timeline em paralelo; biblioteca/gerador em paralelo; notação adicionada após o pedido posterior. Máximo de três agentes simultâneos; parent integrou, corrigiu os problemas encontrados e executou a suíte/smoke. JEV recomendou Codex para as escolhas não óbvias, considerando requisitos, cotas observadas e handoffs; consultivo, não benchmark. Nenhum agente/configuração persistente foi criado.
Após habilitar o modo vibe, `openai-codex/gpt-6.1-sol:high` fez a correção final da grafia das pausas e as regressões; `openai-codex/gpt-6-luna:low` capturou e atualizou a prova visual via navegador. A escolha seguiu o tipo de trabalho: raciocínio de notação/testes para a correção, execução mecânica do roteiro visual para a evidência. JEV havia sido consultado antes do modo vibe; não foi necessária nova consulta para essa divisão de trabalho.

Interfaces de catálogo e `omp usage` consultadas na sessão: no snapshot anterior à rodada, Codex indicava 1% semanal usado; Claude Bridge 5% em 5 h e 0% semanal; OpenCode Go 0% em 5 h, 3% semanal e 39% mensal. Não são saldos atuais garantidos nem equivalência entre provedores. No MVP original, dois agentes Sonnet fizeram módulos em paralelo e um reviewer Codex revisou integração; um handoff travado foi cancelado e suas correções concluídas pelo parent, sem ocultar a falha. Nenhum servidor LSP estava disponível; checagem sintática Node utilizada. Projeto permanece sem Git/Checkpoint registrado e sem publicação.
