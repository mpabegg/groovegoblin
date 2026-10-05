# GrooveGoblin

GrooveGoblin é um estúdio musical local para praticar, tocar com uma banda sintetizada, explorar ideias, trabalhar repertório e acompanhar o próprio percurso. É uma aplicação web estática em JavaScript ESM, CSS e SVG; não exige conta, backend nem dependências de runtime. O [guia da interface e dos limites](./guide.html) está disponível no app.

Em **Ajuda e app**, no topo, **Como usar** abre uma ajuda opcional de quatro passos, começando pela atividade selecionada. Ela não aparece automaticamente nem interrompe a primeira visita. Use **Próximo**, **Voltar** ou as setas; **Fechar ajuda** ou **Esc** encerra. A ajuda respeita a preferência de movimento reduzido e restaura atividade, todos os painéis e menus (inclusive Ajuda e app e Mais opções), foco, modo de foco e rolagem sem modificar a Sessão ou iniciar áudio. **Atalhos** e **Offline** estão no mesmo menu.

## Estúdio · Treinar · Músicas

**Sessão** é o documento completo; **Frase** são suas notas; **Padrão** é um modelo pronto para carregar na Frase. Para ouvir uma banda a partir da Frase vazia, são **três cliques**: **Começar de um padrão → Ligar banda completa (bateria, baixo e acordes) → Tocar**. O padrão já selecionado carrega diretamente; escolher outro antes é opcional.

- **Estúdio** é a tela inicial e o único lugar de edição da sessão. Acordes, frase, bateria e baixo compartilham uma linha do tempo; **Som** no cabeçalho reúne timbre, volume e silenciamento. Estilo e densidade da bateria/baixo ficam visíveis lado a lado nos cabeçalhos. A forma musical continua nesta área, sem transportar o editor entre abas.
- **Treinar** mostra a partitura da frase atual somente para leitura, as configurações de treino e a área de toque. Use **Treinar esta frase** e toque com Espaço ou na área de toque; **Editar no Estúdio** volta ao editor. Os resultados aparecem abaixo do treino.
- **Músicas** permite importar áudio, selecionar um trecho A–B e repeti-lo; velocidade, análise, takes, exercícios, setlists e intercâmbio por arquivos continuam disponíveis.

Em **Mais opções**, **Explorar** reúne jogos e experiências musicais, e **Percurso** mostra progresso e revisões. As cinco áreas continuam navegáveis por teclado e toque; só as três atividades principais ocupam a navegação em destaque.

O transporte do Estúdio permanece visível no topo enquanto você rola sua área de trabalho. Suas duas linhas reúnem **Tocar/Parar**, BPM, metrônomo e opções de padrão/silêncios/polirritmia, limites do loop, posição, nome, compasso, compassos e desfazer/refazer. **Sessão** reúne nova sessão, abrir, salvar na biblioteca, duplicar, exportar, importar e compartilhar. Nova sessão e duplicação permitem desfazer; duplicar guarda a cópia na biblioteca antes de abri-la e não substitui uma biblioteca original protegida.

No Estúdio, **Espaço** toca ou para fora dos campos, diálogos e controles com ativação própria. Durante a contagem e o treino, Espaço mantém sua função de pressionar/soltar o ritmo. **Ctrl+Z / Ctrl+Shift+Z** desfaz/refaz a sessão (⌘ no macOS); **Delete** exclui a nota ou o acorde selecionado. Setas e teclas de duração continuam disponíveis no editor. **?** ou **Ajuda e app → Atalhos** abre a ajuda de teclado; **Esc** fecha a ajuda e interrompe todo o som; fora de campos e diálogos também limpa a seleção no Estúdio. Clicar na régua ou nas faixas de referência de bateria/baixo limpa a seleção sem criar eventos. Ao mudar de atividade com som ativo, o mesmo botão **Parar** fica acessível como parada global, sem criar outro transporte.

A linha do tempo usa uma única régua e um único cursor, guiado pelo transporte de áudio, para as quatro faixas. O **Zoom**, à esquerda da régua, escolhe **4 compassos visíveis** (padrão) ou **2 compassos visíveis**. Sessões longas usam rolagem horizontal com cabeçalhos fixos e acompanhamento do compasso em reprodução; cada semicolcheia tem pelo menos 12 px. Até quatro compassos comuns cabem no desktop; compassos muito densos podem exigir rolagem para preservar essa largura mínima. O zoom é apenas visual, fica na memória da página e não altera a sessão exportada. **Partitura da frase** abre a notação; as linhas de bateria têm nomes à esquerda, e o baixo mostra nomes das notas quando há espaço.

Ao aumentar a sessão, o aviso oferece **Repetir a frase nos novos compassos**, com histórico separado da ampliação. Botão direito no número do compasso (ou Enter / Shift+F10 com foco) abre ações: **Duplicar compasso (inserir após)** desloca os seguintes e ajusta loop/forma, até 16 compassos; **Limpar** recorta só o alvo; **Copiar para** acrescenta sem substituir e recusa sobreposições atomicamente. Incluem acordes quando habilitados. Repetições harmônicas automáticas são tracejadas, com 40% de opacidade, sem alça; clique oferece materializar até o fim, preservando pausas e ocorrências anteriores. Duplicar materializa acordes para preservar cada ocorrência; sustentações na inserção são divididas sem perder trechos.

Ligue acordes, bateria e baixo nos respectivos cabeçalhos; uma faixa desligada vira uma linha fina com seu interruptor. **Progressões prontas** oferece cadência, turnaround e progressão diatônica livre, distribuídas em tempos escritos para preencher exatamente os compassos da sessão, sem estendê-la. **Grade e swing** guarda subdivisão, swing e acesso à biblioteca/gerador. Sem seleção, o inspetor oferece **Carregar padrão**, **Gerar frase**, **Limpar** e **Transpor**. **Polirritmia**, nas opções do metrônomo, descreve N pulsos a cada M tempos. **Opções da banda** pergunta qual parte você vai tocar (a faixa correspondente fica muda) e se a banda mantém o pulso ou responde ao que você toca no treino. O monitor do toque permanece em **Configurar treino**.

Uma nova sessão do Estúdio começa com quatro compassos, sem mudar os padrões canônicos nem sessões antigas. Quando a frase está vazia, três escolhas aparecem abertas: **Começar de um padrão**, **Gerar uma frase** e **Escrever do zero**. O padrão selecionado carrega em um clique; a descrição principal é única, com fontes e detalhes técnicos dentro da biblioteca. Escrever do zero apenas dispensa as escolhas nesta página e mantém a grade editável. **Ligar bateria e baixo** liga acompanhamento Pop sem modificar a frase ou os acordes; **Ligar banda completa (bateria, baixo e acordes)** também liga os acordes e cria a cadência padrão somente se a progressão estiver vazia. A progressão existente é preservada. Carregar um padrão, ligar a banda completa e tocar são três ações explícitas; o carregador de padrões nunca troca a harmonia por conta própria.

Carregar um padrão compatível muda as notas da frase, não o compasso, a subdivisão ou o swing da sessão. Padrões curtos repetem até preencher os compassos existentes, com as pausas originais. Se o padrão for maior, um diálogo oferece **Ajustar para N compassos** ou **Cancelar**; nenhuma aplicação ocorre antes da escolha. Diferenças de compasso/subdivisão também pedem uma escolha explícita: **Mudar para o compasso e a subdivisão do padrão**, ou cancelar. Essa mudança autorizada preserva todos os ataques, sem quantizar nem fundir notas, e mantém posições/durações dos acordes em compassos. Se esses eventos forem incompatíveis com o novo compasso, a mudança é recusada com explicação, sem alterar dados. O BPM sugerido só é aplicado quando não há notas, acordes (mesmo desligados), bateria/baixo ligados ou seções a preservar; swing nunca é trocado pelo padrão. **Gerar frase** mantém BPM, compassos, compasso, subdivisão e swing. A banda completa cria exatamente um acorde por compasso quando a progressão está vazia, inclusive em uma sessão de um compasso.

**Som**, **Grade e swing**, opções do metrônomo e avançado das notas abrem painéis ancorados ao próprio controle, na camada superior nativa do navegador, acima do transporte. Esc ou clique fora fecha o painel; a posição acompanha rolagem/redimensionamento. **Avançado · cifras e inversões** dos acordes expande dentro do inspetor, sem painel flutuante.

A Frase é editável por clique, arrasto e borda direita, com figuras musicais nos blocos. A grade tem um único foco de teclado: setas navegam posições e **Enter** cria; **↓** entra nas notas, **PageUp/PageDown** escolhem a nota anterior/seguinte, e as setas nas notas movem ou mudam duração. Só há uma seleção: nota ou acorde. Para notas, o inspetor compacto mostra durações por figuras, **Intensidade** de 0–100%, articulação e exclusão; **Mais durações** conserva figuras pontuadas e tercinas/quintinas/septinas. **Avançado** conserva altura com nome e número MIDI, posição/duração exatas e **Microtempo**, o deslocamento do ataque em milissegundos sem alterar a escrita. A bateria mostra três linhas de referência (bumbo, caixa e chimbal/percussão), com os instrumentos adicionais identificados nos ataques; o baixo mostra o padrão gerado pela banda. Essas duas faixas são somente leitura: **editar manualmente os ataques de bateria é a próxima etapa, ainda não implementada**. **Variar** cria outra variação de bateria; sua semente explícita fica em **Som → Avançado** e continua determinística. A semente do gerador de Frases aparece apenas em **Avançado**.

Carregar, gerar e limpar a frase, gerar/ajustar progressões, variar a bateria ou trocar seu estilo/densidade, iniciar acompanhamentos e abrir/importar/substituir sessões usam o histórico canônico. Um único aviso sobreposto no canto inferior direito informa a mudança sem deslocar a tela: dura seis segundos, ou dez com **Desfazer**, e fecha ao mudar de aba ou pelo ×. O botão desfaz somente a entrada canônica anunciada; outra edição retira o aviso anterior. Selecionar elementos ou iniciar/parar áudio não cria outro histórico nem avisos redundantes de reprodução.

Na faixa **Acordes**, com a reprodução parada, clicar numa área vazia cria uma tônica no compasso escolhido: criar no compasso 3 deixa os anteriores em silêncio. Clique num bloco para selecionar o acorde; o inspetor mostra os sete graus do tom e exclusão, com empréstimos, dominantes secundárias, cifra manual e inversões em **Avançado · cifras e inversões**. Nunca mostra campos de nota ao mesmo tempo. Arraste a borda direita para redimensionar em tempos escritos, sem sobrepor nem ultrapassar o ciclo. Arrastar sobre outro acorde reordena os acordes nas posições existentes, conservando os espaços de silêncio; arrastar para o vazio move apenas aquele evento, mantendo a duração. **←/→** movem um tempo, **Shift+←/→** redimensionam, **Enter** seleciona (ou cria uma tônica na faixa vazia) e **Delete** exclui. Cada arrasto concluído cria uma única entrada de histórico; cancelar conserva o original. A Frase não muda durante a edição de acordes.

O ciclo harmônico tem tamanho próprio: pode repetir dentro da Sessão ou continuar além dela. Pausas aparecem hachuradas e recomeços do ciclo têm limites tracejados. Quando há pausas ou tamanho diferente, **Ajustar ao tamanho da sessão** redistribui os acordes em tempos inteiros para preencher a Sessão, removendo as pausas; sem acordes, a ação fica desabilitada. A sessão canônica usa **versão 3**, com `progression.cycleBars` e `chord.startBar` explícitos; exportações atuais usam `groovegoblin-session` v3 e links `#session=` com esse documento. Sessões v2 válidas continuam abrindo por JSON, armazenamento local, biblioteca e links: são migradas automaticamente com posições cumulativas e o ciclo anterior preservado, sem mudar sua reprodução. A chave local `groovegoblin.session.v2` é mantida intencionalmente para encontrar os dados já salvos; seu nome não indica a versão do documento. Essa compatibilidade não significa que versões antigas do app possam abrir v3. Frases/links v1 continuam aceitos; na ausência de sessão nessa chave, a migração local reaproveita frase, preferências e mixer v1.

O treino principal usa a frase da sessão e seu trecho de loop. O metrônomo acompanha o transporte, respeitando preferências e mute do mixer. **Prática guiada · objetivos, rotina e jogos de ouvido** é uma opção recolhida abaixo do treino: seus exercícios gerados usam uma sessão temporária e não substituem a frase salva nem seu andamento. Copiar o exercício para a sessão continua sendo uma ação explícita. Rotinas já salvas são preservadas.

As sessões têm 1–16 compassos, de 1–16 tempos com unidade 2, 4, 8 ou 16, e andamento de 30–300 BPM em semínimas. A frase usa coordenadas em ticks (4 ticks por semínima), admite 1–8 divisões por semínima, swing e atributos expressivos; a pauta rítmica representa durações e pausas, não altura. O histórico de desfazer/refazer cobre a sessão completa. O estúdio **não** captura microfone, não recebe MIDI ao vivo e não mede velocidade/força física do toque.

No **Estúdio**, abra **Organizar uma música em seções**, recolhido abaixo da linha do tempo. Até 32 seções ocupam uma linha de tabela cada: **Nome, Tipo e papel, Compassos** (de–até inclusivos), **Repetições** e **Mais**. O menu Mais guarda BPM, tempos/unidade do compasso e densidade da banda (herdados da Sessão quando não especificados), mover acima/abaixo e excluir seção. **Tocar a forma** fica desabilitado, com explicação visível, enquanto não houver seções; **Repetir a forma** escolhe repetir ou terminar. Introdução, A/B, virada, pausa da banda e final têm comportamentos audíveis. A linha atual é destacada na reprodução e a posição indica seção, repetição, compasso da Sessão, BPM e compasso; editar exige parar. Reprodução e renderização de arranjo compartilham o mesmo plano musical. Treinos e tomadas usam o loop da Frase escolhida, no andamento do exercício, não a forma variável.

Consulte [guide.html](./guide.html) para os controles, formatos aceitos, funcionamento offline e limitações de análise.

## Dados, privacidade e mídia

Sessão, biblioteca de sessões, preferências de prática/jogos e Percurso são armazenados localmente no navegador. O Repertório usa IndexedDB para mídias e metadados e avisa se o banco estiver indisponível ou se faltar quota; armazenamento persistente pode ser solicitado ao navegador, mas não é garantido. Exporte cópias para backup: limpar os dados do site pode apagar o conteúdo local. Sessões completas podem ser exportadas/importadas como JSON ou compartilhadas em link, sem enviar os dados a um servidor do GrooveGoblin. Pacotes de tarefa são arquivos explícitos para o usuário enviar por conta própria.

Áudio importado e processamentos permanecem no dispositivo. O limite por arquivo importado é 150 MiB e 15 minutos; arquivos de áudio embutidos em pacotes têm limite de 25 MiB. WAV e Standard MIDI são intercâmbios por arquivo; não são integração MIDI ao vivo. Compatibilidade de codecs de áudio depende do navegador. A análise local fornece hipóteses de ataques, andamento, alturas, tonalidade e acordes com confiança/alternativas, não transcrição infalível. HPSS separa estimativas harmônica e percussiva; não cria stems de voz, baixo ou instrumentos.

Não há upload automático de sessões, mídia, análises ou histórico. A hospedagem GitHub Pages entrega arquivos estáticos; ao abrir links externos ou compartilhar/baixar arquivos, a ação sai do armazenamento local sob controle do navegador.

## Desenvolvimento local

Requer Node.js 22 ou posterior e navegador moderno com Web Audio; não é necessário `npm install`.

```sh
npm start
```

Abra <http://127.0.0.1:5173>. O servidor local escuta somente em loopback e serve arquivos; não recebe nem processa sessões. Porta alternativa: `PORT=5174 npm start`. Pare com Ctrl+C. `file://` não é suportado por causa dos módulos ES.

## Build e preview com prefixo

```sh
npm run build
npm run preview
```

`npm run build` gera `dist/` para publicação estática. `npm run preview` serve esse artefato sob o prefixo `/groovegoblin/`; abra <http://127.0.0.1:5173/groovegoblin/>. Para usar outro prefixo, porta ou diretório: `STATIC_ROOT=dist BASE_PATH=/meu-projeto/ PORT=5174 node server.js`. O servidor redireciona o prefixo sem a barra final.

## Comandos de verificação

```sh
npm test
npm run check
npm run build
```

Esses são comandos disponíveis para a verificação local; este README não declara resultados de execução. Uma checagem manual do preview pode conferir HTML, CSS, JavaScript e guia sob `/groovegoblin/`. A publicação pelo GitHub Actions tem seu próprio workflow em [`.github/workflows/pages.yml`](./.github/workflows/pages.yml).

## Uso offline e atualizações

Em HTTPS ou `localhost`, abra **Ajuda e app → Offline** no topo e escolha **Preparar uso offline** enquanto conectado. A aplicação prepara os arquivos publicados para esta origem e pode então abrir sem rede. A opção de atualização só recarrega quando você a aplicar; reprodução, treino e trabalho em andamento adiam a atualização. Se a sessão ainda estiver somente na memória, salve-a ou exporte uma cópia antes de recarregar. Mídias importadas no Repertório não fazem parte do cache offline do app.
