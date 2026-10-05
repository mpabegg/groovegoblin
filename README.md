# GrooveGoblin

GrooveGoblin é um estúdio musical local para praticar, tocar com uma banda sintetizada, explorar ideias, trabalhar repertório e acompanhar o próprio percurso. É uma aplicação web estática em JavaScript ESM, CSS e SVG; não exige conta, backend nem dependências de runtime. O [guia da interface e dos limites](./guide.html) está disponível no app.

O botão **Como usar**, no topo, abre uma ajuda opcional de quatro passos, começando pela atividade selecionada. Ela não aparece automaticamente nem interrompe a primeira visita. Use **Próximo**, **Voltar** ou as setas; **Fechar ajuda** ou **Esc** encerra. A ajuda funciona em telas pequenas, respeita a preferência de movimento reduzido e restaura a tela anterior sem modificar a sessão ou iniciar áudio.

## Estúdio · Treinar · Músicas

- **Estúdio** é a tela inicial e o único lugar de edição da sessão. Frase, banda, harmonia, timbres, mixer e forma musical ficam nesta área, sem transportar o editor entre abas.
- **Treinar** mostra a partitura da frase atual somente para leitura, as configurações de treino e a área de toque. Use **Treinar esta frase** e toque com Espaço ou na área de toque; **Editar no Estúdio** volta ao editor. Os resultados aparecem abaixo do treino.
- **Músicas** permite importar áudio, selecionar um trecho A–B e repeti-lo; velocidade, análise, takes, exercícios, setlists e intercâmbio por arquivos continuam disponíveis.

Em **Mais opções**, **Explorar** reúne jogos e experiências musicais, e **Percurso** mostra progresso e revisões. As cinco áreas continuam navegáveis por teclado e toque; só as três atividades principais ocupam a navegação em destaque.

O transporte do Estúdio permanece visível no topo enquanto você rola sua área de trabalho. Suas duas linhas reúnem **Tocar/Parar**, BPM, metrônomo e opções de padrão/silêncios/polirritmia, limites do loop, posição, nome, compasso, compassos e desfazer/refazer. **Sessão** reúne nova sessão, abrir, salvar na biblioteca, duplicar, exportar, importar e compartilhar. Nova sessão e duplicação permitem desfazer; duplicar guarda a cópia na biblioteca antes de abri-la e não substitui uma biblioteca original protegida.

No Estúdio, **Espaço** toca ou para fora dos campos, diálogos e controles com ativação própria. Durante a contagem e o treino, Espaço mantém sua função de pressionar/soltar o ritmo. **Ctrl+Z / Ctrl+Shift+Z** desfaz/refaz a sessão (⌘ no macOS); **Delete** exclui a nota selecionada. Setas e teclas de duração continuam disponíveis no editor. **?** ou **Atalhos** abre a ajuda de teclado; **Esc** fecha a ajuda e interrompe todo o som. Ao mudar de atividade com som ativo, o mesmo botão **Parar** fica acessível como parada global, sem criar outro transporte.

O treino principal usa a frase da sessão e seu trecho de loop. O metrônomo acompanha o transporte, respeitando preferências e mute do mixer. **Prática guiada · objetivos, rotina e jogos de ouvido** é uma opção recolhida abaixo do treino: seus exercícios gerados usam uma sessão temporária e não substituem a frase salva nem seu andamento. Copiar o exercício para a sessão continua sendo uma ação explícita. Rotinas já salvas são preservadas.

As sessões têm 1–16 compassos, de 1–16 tempos com unidade 2, 4, 8 ou 16, e andamento de 30–300 BPM em semínimas. A frase usa coordenadas em ticks (4 ticks por semínima), admite 1–8 divisões por semínima, swing e atributos expressivos; a pauta rítmica representa durações e pausas, não altura. O histórico de desfazer/refazer cobre a sessão completa. O estúdio **não** captura microfone, não recebe MIDI ao vivo e não mede velocidade/força física do toque.

No **Estúdio**, a forma musical ordena até 32 seções com trechos da frase, repetições e alterações de BPM, compasso e densidade. Introdução, A/B, virada, pausa e final têm comportamentos audíveis; a forma pode repetir ou terminar. Reprodução e renderização de arranjo compartilham o mesmo plano musical. Treinos e tomadas usam o loop da frase escolhida, no andamento do exercício, não a forma variável.

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

Em HTTPS ou `localhost`, abra **Offline** no topo e escolha **Preparar uso offline** enquanto conectado. A aplicação prepara os arquivos publicados para esta origem e pode então abrir sem rede. A opção de atualização só recarrega quando você a aplicar; reprodução, treino e trabalho em andamento adiam a atualização. Se a sessão ainda estiver somente na memória, salve-a ou exporte uma cópia antes de recarregar. Mídias importadas no Repertório não fazem parte do cache offline do app.
