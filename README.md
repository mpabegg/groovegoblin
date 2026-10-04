# GrooveGoblin

GrooveGoblin é um estúdio musical local para praticar, tocar com uma banda sintetizada, explorar ideias, trabalhar repertório e acompanhar o próprio percurso. É uma aplicação web estática em JavaScript ESM, CSS e SVG; não exige conta, backend nem dependências de runtime. O [guia da interface e dos limites](./guide.html) está disponível no app.

## Cinco intenções

- **Praticar**: objetivos rítmicos, exercícios ajustáveis, rotina guiada, jogos de ouvido, tentativa por teclado/toque e adaptação de andamento a partir dos resultados.
- **Banda**: frase, baixo, bateria, harmonia e metrônomo em um transporte sincronizado; escolha seu papel, estilos, densidade, timbres e mixagem.
- **Explorar**: jogos musicais, transformações de frases e ideias criativas, com prévias acionadas pelo usuário.
- **Repertório**: importe arquivos de áudio e trabalhe trechos, marcadores, análises estimadas, takes, exercícios, setlists e intercâmbio por arquivos.
- **Percurso**: histórico local, progresso por objetivo e agenda de revisões espaçadas.

As sessões têm 1–16 compassos, de 1–16 tempos com unidade 2, 4, 8 ou 16, e andamento de 30–300 BPM em semínimas. A frase usa coordenadas em ticks (4 ticks por semínima), admite 1–8 divisões por semínima, swing e atributos expressivos; a pauta rítmica representa durações e pausas, não altura. O histórico de desfazer/refazer cobre a sessão completa. As cinco abas são operadas por teclado ou toque; o estúdio **não** captura microfone, não recebe MIDI ao vivo e não mede velocidade/força física do toque.

Em **Banda**, a forma musical ordena até 32 seções com trechos da frase, repetições e alterações de BPM, compasso e densidade. Introdução, A/B, virada, pausa e final têm comportamentos audíveis; a forma pode repetir ou terminar. Reprodução e renderização de arranjo compartilham o mesmo plano musical. Treino e tomadas de execução usam o loop-fonte no andamento principal, não a forma variável.

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

Em HTTPS ou `localhost`, escolha **Preparar uso offline** enquanto conectado. A aplicação prepara os arquivos publicados para esta origem e pode então abrir sem rede. A opção de atualização só recarrega quando você a aplicar; reprodução, treino e trabalho em andamento adiam a atualização. Se a sessão ainda estiver somente na memória, salve-a ou exporte uma cópia antes de recarregar. Mídias importadas no Repertório não fazem parte do cache offline do app.
