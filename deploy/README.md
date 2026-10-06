# GrooveGoblin no Raspberry Pi (systemd + Tailscale)

Este diretório leva o GrooveGoblin de "site estático no navegador" a "serviço
pessoal dentro da sua tailnet": o Pi guarda os dados, publica o app e o conteúdo
do curso em HTTPS, e o laptop abre tudo pelo endereço da tailnet. Nada aqui é
obrigatório para usar o app só no navegador — sem servidor ele continua
funcionando como sempre, inclusive offline e no GitHub Pages.

Todos os exemplos deste guia usam valores fictícios (`pi-groove.exemplo.ts.net`,
`usuario@example.org`). Troque pelos seus; nenhum identificador real da sua
infraestrutura entra no repositório, que é público.

## Arquivos

| Arquivo | Papel |
|---|---|
| `groovegoblin.service` | unidade systemd: usuário sem privilégios, `127.0.0.1`, reinício automático, limites e isolamento |
| `install.sh` | instala e habilita o serviço (cria usuário e diretório de dados, roda o build, confere o health, publica no `tailscale serve`) |
| `update.sh` | atualiza o código com instantâneo de segurança antes, build, testes, reinício e health; reverte se algo falhar |
| `restore.sh` | restauração: para o serviço, valida o instantâneo, pede confirmação, aplica e reinicia |
| `groove.env.example` | modelo do ambiente privado (fica em `/etc/groovegoblin/groove.env`, nunca no checkout) |
| `hooks/pre-commit` | trava local que recusa PDF/áudio/`local/` e termos privados antes do commit (instalação: veja "Desenvolvimento local") |
| `README.md` | este guia |

Layout padrão:

```
/opt/groovegoblin            checkout do repositório (root, só leitura para o serviço)
/opt/groovegoblin/dist       site construído por `npm run build`
/etc/groovegoblin/groove.env ambiente do serviço (root, 0600)
/var/lib/groovegoblin        diretório de dados (usuário do serviço, 0700)
  entrada/<id-do-curso>/     arquivos que você copia (PDF/MP3/WAV/ZIP)
  blobs/ objects/ private/ backups/ tmp/
```

## Antes de começar

No Pi (Raspberry Pi OS 64 bits, com systemd):

```bash
sudo apt update
sudo apt install -y curl git ca-certificates
# Node 22 pelos pacotes oficiais do NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # precisa ser v22 ou mais novo
```

Tailscale no Pi e no laptop:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Confira os nomes das opções do `serve` na versão instalada antes de decorar
comandos: `tailscale serve --help` e `tailscale version`. Este guia foi escrito
com o CLI 1.102.5 (`--bg` e `--https=<porta>`), conferido na documentação oficial
do `tailscale serve` (<https://tailscale.com/docs/reference/tailscale-cli/serve>,
validada em janeiro de 2026). A documentação confirma o que este guia assume:
com `--bg` a configuração sobrevive a reinício e a `tailscale down/up`, e o alvo
de um proxy só pode ser `http://127.0.0.1`.

## O que só você pode fazer (painel do Tailscale)

O instalador não toca na sua conta do Tailscale. No painel:

1. **MagicDNS ligado** (DNS → Enable MagicDNS), para o nome `<máquina>.<tailnet>.ts.net` resolver.
2. **Certificados HTTPS ligados** (DNS → HTTPS Certificates). Sem isso o `serve` não consegue emitir o certificado e o app não abre em HTTPS.
3. **Nome de máquina neutro** — escolha algo como `pi-groove`: o nome da máquina e o da tailnet aparecem nos registros públicos de transparência de certificados (Certificate Transparency). Não use nada que identifique você, o curso ou a casa.
4. **Sua lista de logins**: o `serve` injeta `Tailscale-User-Login` com o login do usuário que acessa. Use o seu login do Tailscale (por exemplo `usuario@example.org`) em `GROOVE_ALLOWED_LOGINS`.
5. **Descubra o endereço**: `tailscale status` no Pi mostra o nome DNS do próprio nó; o endereço público é `https://<máquina>.<tailnet>.ts.net`. É esse valor que vai em `GROOVE_PUBLIC_ORIGIN`.

Detalhe importante: dispositivos **com tag** (tagged devices, os que não têm dono)
não recebem identidade do Serve. O laptop de onde você usa o app precisa entrar
na tailnet como usuário (login pessoal), senão todo `/api/*` responde 401.

## Instalação no Pi (do zero ao HTTPS)

### 1. Código

```bash
sudo git clone https://github.com/mpabegg/groovegoblin.git /opt/groovegoblin
cd /opt/groovegoblin
```

Clonou em outro lugar? Sem problema, mas informe na hora de instalar:
`sudo /caminho/do/checkout/deploy/install.sh --app-dir /caminho/do/checkout`.

### 2. Ambiente privado

```bash
sudo install -d -m 0755 /etc/groovegoblin
sudo install -m 0600 -o root -g root /opt/groovegoblin/deploy/groove.env.example /etc/groovegoblin/groove.env
sudo editor /etc/groovegoblin/groove.env
```

O que você quase sempre muda:

| Variável | Valor |
|---|---|
| `GROOVE_ALLOWED_LOGINS` | seu login do Tailscale (`usuario@example.org`) |
| `GROOVE_PUBLIC_ORIGIN` | `https://pi-groove.exemplo.ts.net` (exatamente como aparece no navegador, sem barra no fim) |
| `GROOVE_DATA_DIR` | `/var/lib/groovegoblin` (mude se quiser os dados em outro disco) |
| `PORT` | `5173` (só interno, em loopback) |

O restante do arquivo já vem com os padrões do servidor comentados. Formato
aceito (o mesmo que o systemd lê e o mesmo que os scripts verificam): uma
`CHAVE=valor` por linha, `#` para comentar, sem `export`, sem `$VAR`, sem
continuação de linha e sem chave desconhecida — o arquivo **nunca** é executado
como shell. O `install.sh` recusa esse arquivo se ele não for do root, se o
grupo/outros puderem escrever nele, se estiver dentro do checkout, se tiver linha
fora do formato, ou se ainda tiver os valores fictícios do modelo.

### 3. Instalar

```bash
sudo /opt/groovegoblin/deploy/install.sh
```

O que ele faz: valida o ambiente e os caminhos; cria o usuário `groovegoblin` e o
diretório de dados `0700`; roda `npm run build`; instala e habilita
`/etc/systemd/system/groovegoblin.service`; espera o `/api/health` responder em
`127.0.0.1`; e publica o serviço com
`tailscale serve --bg --https=443 http://127.0.0.1:5173`.

Se você cuida do `serve` por conta própria (ou esta máquina ainda não tem
Tailscale), rode com `--skip-serve`: o instalador imprime o comando exato para
publicar depois.

As validações de ambiente, caminhos e checkout são somente-leitura e acontecem
antes da checagem de privilégio: um erro nelas aparece mesmo quando o script não
consegue seguir como root, e nada é alterado antes disso.

### 4. Conferir

No Pi:

```bash
systemctl status groovegoblin --no-pager
curl -fsS -H "Tailscale-User-Login: usuario@example.org" http://127.0.0.1:5173/api/health
sudo tailscale serve status
sudo ss -ltnp | grep 5173      # deve mostrar 127.0.0.1:5173, nunca 0.0.0.0
```

No laptop: abra `https://pi-groove.exemplo.ts.net`. Em "Ajuda e app" deve
aparecer algo como "Servidor: sincronizado há 1 min".

## Abrir as apostilas e as faixas dentro do app

Cada curso tem uma pasta de entrada no diretório de dados:

```
/var/lib/groovegoblin/entrada/<id-do-curso>/
```

O servidor cria `entrada/` no primeiro start e cria `entrada/<id-do-curso>/` sob
demanda (quando a página do curso aparece ou quando você arrasta arquivos). Você
também pode criá-la à mão. Copie os arquivos **planos** (sem subpastas — o
servidor não varre subpasta) e **como o usuário do serviço**, senão eles ficam
ilegíveis com modo 0600 de outro dono:

```bash
# descobrir o id do curso (rode no Pi; ou abra a mesma URL no navegador, pelo endereço da tailnet)
curl -fsS -H "Tailscale-User-Login: usuario@example.org" http://127.0.0.1:5173/api/docs/courses

# preparar a pasta
sudo install -d -o groovegoblin -g groovegoblin -m 0700 /var/lib/groovegoblin/entrada/curso-exemplo

# copiar do laptop para um diretório temporário do Pi
scp apostila-01.pdf 'faixa 01.mp3' packs-pdf.zip pi-groove.exemplo.ts.net:/tmp/

# mover para a pasta do curso, já com o dono certo
sudo install -o groovegoblin -g groovegoblin -m 0600 /tmp/apostila-01.pdf '/tmp/faixa 01.mp3' /tmp/packs-pdf.zip \
  /var/lib/groovegoblin/entrada/curso-exemplo/
sudo rm -f /tmp/apostila-01.pdf '/tmp/faixa 01.mp3' /tmp/packs-pdf.zip
```

Ou, mais simples, arraste os arquivos direto na página do curso no app — aí eles
já entram com o dono certo.

O casamento é pelo nome, tolerando maiúsculas, espaços, hífens e sufixos como
`(1)`. ZIPs são abertos e os PDFs de dentro são casados um a um. Um material
citado em várias aulas é guardado uma vez só. Limites por curso: 300 arquivos,
200 MiB por arquivo, 3 GiB no total, 64 MiB por ZIP, 60 PDFs extraídos; nome que
diz "6 cordas" é ignorado. A página do curso mostra "N de M materiais
disponíveis", o que falta e o que não casou com nada.

Arquivos que não casam aparecem no relatório e **não** são guardados; arquivos
copiados com o dono errado aparecem como não casados/ilegíveis — nesse caso:

```bash
sudo chown -R groovegoblin:groovegoblin /var/lib/groovegoblin/entrada
```

Vídeos continuam no site do curso: o app não baixa nem guarda vídeo.

## Cópias de segurança

- O servidor grava um instantâneo **diário** em `/var/lib/groovegoblin/backups/`
  e mantém os 14 mais novos (`GROOVE_BACKUP_KEEP`). Cada instantâneo é um
  `.ndjson.gz` que inclui os documentos **e** os blobs (PDFs e áudios) — ou seja,
  o arquivo tem aproximadamente o tamanho do seu material, e a restauração precisa
  de espaço livre equivalente em disco. Os instantâneos `pre-restore-<carimbo>.ndjson.gz`
  (gravados antes de cada restauração) **não** entram nessa rotação: apague à mão
  quando não precisar mais.
- Para baixar o mais recente, no navegador: `https://pi-groove.exemplo.ts.net/api/backup`
  (o download autentica sozinho, porque o `serve` injeta a identidade). No Pi,
  sem navegador:

```bash
curl -fsS -H "Tailscale-User-Login: usuario@example.org" \
  http://127.0.0.1:5173/api/backup -o groovegoblin-backup.ndjson.gz
```

- Para forçar um instantâneo fora de hora (é o mesmo que o `update.sh` faz antes de atualizar):

```bash
curl -fsS -X POST \
  -H "Tailscale-User-Login: usuario@example.org" \
  -H "Origin: https://pi-groove.exemplo.ts.net" \
  http://127.0.0.1:5173/api/backups
```

- Trate esses arquivos como material privado: eles contêm o conteúdo do curso.
  Não mande para serviço de nuvem público; guarde num disco ou pasta sua.

### Restaurar

```bash
sudo /opt/groovegoblin/deploy/restore.sh --latest
# ou um arquivo específico (inclusive um download feito no navegador):
sudo /opt/groovegoblin/deploy/restore.sh --backup /home/usuario/groovegoblin-backup.ndjson.gz
```

O que acontece: o script pede confirmação (digite `SUBSTITUIR`), para o serviço,
deixa o próprio servidor validar o arquivo inteiro a seco e mostrar as contagens,
grava um instantâneo `pre-restore-<carimbo>.ndjson.gz` e só então substitui os
documentos. O que existia e não está no arquivo vira lápide (some do app). Os
blobs que já estão no disco **não** são apagados, e os que vierem no arquivo são
restaurados. O serviço volta no fim, inclusive quando a restauração falha; só
com `--no-restart` ele fica parado. Os clientes recebem a restauração sozinhos no
próximo `/api/changes`.

A validação do conteúdo é do servidor e só roda com o serviço parado (o
diretório de dados tem um lock que recusa dois processos). Por isso ela acontece
logo depois do `systemctl stop`, já dentro da restauração de verdade: se o
arquivo não passar, nada é alterado e o serviço volta imediatamente.

## Atualizar

```bash
sudo /opt/groovegoblin/deploy/update.sh
```

O script exige o serviço no ar (é dele que sai o instantâneo de segurança), o
checkout na branch certa (`main`) e **sem alterações pendentes em arquivos
versionados**, faz o instantâneo pela API, avança só em linha reta
(`git merge --ff-only`), constrói o site guardando o `dist/` anterior de lado,
roda `npm test`, reinicia e confere o `/api/health`. Se o build, os testes ou o
health falharem, ele volta o código e o site para a revisão anterior e reinicia —
o diretório de dados nunca é tocado.

Se, no meio da atualização, algum arquivo versionado do checkout for alterado por
outra pessoa/processo, o script **não** reverte nada por cima disso: ele repõe o
site antigo (`dist.old` → `dist`), não reinicia o serviço e mostra os comandos
para você resolver à mão. `dist.old` é o diretório de build do próprio script
(nada fora de `dist/` e `dist.old` é tocado).

Durante o build (alguns segundos) o site estático fica fora do ar: o build
reconstrói `dist/` do zero, então há uma janela curta em que as páginas não são
servidas; as chamadas de API e os dados não são afetados.

Opções: `--branch NOME` (padrão `main`), `--app-dir PATH`, `--env-file PATH`,
`--data-dir PATH`, `--help`.

## Espaço, cotas e disco cheio

- `/api/health` traz `storage` (usado, livre, blobs, documentos, backups). Use
  para ver o que está ocupando o cartão:

```bash
curl -fsS -H "Tailscale-User-Login: usuario@example.org" http://127.0.0.1:5173/api/health
```

- Antes de gravar, o servidor exige `GROOVE_MIN_FREE_BYTES` livres (padrão
  128 MiB). Se a reserva for violada, a gravação responde **507
  `insufficient_storage`** e nada é escrito; o app mostra o erro e o que já
  estava salvo continua intacto.
- Upload de blob tem teto por arquivo (`GROOVE_MAX_BLOB_BYTES`, padrão 200 MiB).
- Quem ocupa espaço são os blobs (PDFs e áudios). Apague um material no app para
  liberar; os instantâneos diários mantêm as cópias antigas até sair da rotação
  (14 dias), então libere espaço também apagando instantâneos antigos (inclusive os
  `pre-restore-*`) em `/var/lib/groovegoblin/backups/`, se precisar. Restaurar
  também exige espaço: o arquivo escolhido é do tamanho do material.
- Cartão SD desgasta com escrita. Se você tiver um SSD, aponte o diretório de
  dados para ele antes de instalar:

```bash
# em /etc/groovegoblin/groove.env: GROOVE_DATA_DIR=/srv/groovegoblin
sudo /opt/groovegoblin/deploy/install.sh --data-dir /srv/groovegoblin
```

## HTTPS é obrigatório (e por que)

O app precisa de contexto seguro para captura de áudio (entrada por instrumento,
afinador), `AudioWorklet`, service worker (uso offline) e `crypto.subtle`. Em
`http://<IP-do-Pi>` (ou qualquer endereço na rede local por HTTP) nada disso
funciona — só em `https://…`. Por isso o acesso é pelo endereço da tailnet, com o
certificado válido que o `serve` emite e renova sozinho; certificado autoassinado
não serve. `http://127.0.0.1` e `http://localhost` (no próprio Pi, para
desenvolvimento) contam como contexto seguro e são a única exceção.

Se você abrir o app por HTTP num IP, o próprio app avisa que instrumento e uso
offline exigem o endereço HTTPS; o resto (biblioteca, sessões, treino) continua
funcionando.

## Convivendo com outros serviços no mesmo Pi

O padrão do `serve` é a porta HTTPS 443. Se outro serviço já estiver usando essa
porta, **não substitua**: publique o GrooveGoblin numa porta alternativa.

```bash
sudo tailscale serve status          # o que já está publicado hoje
sudo /opt/groovegoblin/deploy/install.sh --serve-port 8443
```

Com `--serve-port 8443` o `GROOVE_PUBLIC_ORIGIN` precisa incluir a porta
(`https://pi-groove.exemplo.ts.net:8443`), e é essa a URL que você abre no
laptop. O `install.sh` lê a configuração atual do `serve` e **adiciona** essa
porta: as portas que já estavam publicadas ficam exatamente como estavam. Ele só
para (sem publicar nada) quando a porta pedida já é de outro serviço — aí ele
mostra o comando com outra porta. Se a leitura da configuração falhar, ele
também para, em vez de publicar às cegas. Depois de publicar, ele confere que
tudo que existia continua lá; se algo tiver sumido, ele restaura as entradas
antigas e avisa.

Para desligar **só o GrooveGoblin**, use o `off` com as mesmas opções da
publicação (ele remove o handler daquela porta, sem tocar nos outros):

```bash
sudo tailscale serve status                              # confira antes o que existe
sudo tailscale serve --https=443 http://127.0.0.1:5173 off
sudo tailscale serve --https=8443 http://127.0.0.1:5173 off   # se você publicou em 8443
```

`tailscale serve reset` existe, mas é **destrutivo**: apaga a configuração de
`serve` de **todos** os serviços desta máquina, não só a do GrooveGoblin. Só use
se você tiver certeza de que nada mais depende disso aqui (rode
`tailscale serve status` e confira a lista inteira); para desligar só o nosso,
prefira o `off` acima.

Com `--bg` a configuração sobrevive a reinício do Pi e a `tailscale down/up`;
sem `--bg` ela some. Não use Funnel nesta rodada (nem em nenhuma outra sem
revisitar a seção abaixo).

## Segurança e privacidade

- **O Node escuta só em `127.0.0.1`.** O servidor recusa subir em qualquer outra
  interface, e essa é a premissa que torna o cabeçalho de identidade confiável:
  só o `serve` (ou um processo local do próprio Pi) consegue falar com a porta.
- O `serve` **descarta** `Tailscale-User-Login` e afins forjados pelo cliente e
  injeta os verdadeiros. Sem cabeçalho (ou fora da lista) → 401. Requisições que
  chegam com cabeçalhos de proxy em modo `dev` são recusadas.
- O usuário do serviço é dedicado, sem login; o diretório de dados é `0700` dele;
  o checkout é só leitura para ele; e a unidade roda com `NoNewPrivileges`,
  `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` só do
  diretório de dados, sem capabilities e com limite de memória/CPU/arquivos.
- O arquivo de ambiente é `0600` do root, fora do checkout; os scripts recusam
  fonte com dono/permissão errados e nunca executam o modelo do repositório.
- Nada de conteúdo de curso no repositório (que é público): o app não coloca
  curso em link compartilhado nem na exportação padrão, e a biblioteca exportada
  com cursos sai marcada como PRIVADO depois de uma confirmação.
- Não compartilhe a máquina do Pi com outras pessoas da tailnet: quem estiver na
  sua tailnet e na sua lista de logins alcança o conteúdo.

## Se um dia abrir para fora da tailnet

Fica para outra rodada. O resumo do que mudaria: você precisaria do Funnel (ou de
outro proxy público) e o TLS continuaria vindo do `serve`. Como o servidor exige
identidade do Serve em modo `tailscale`, um acesso público **sem** identidade
recebe 401 — ou seja, a lista de logins continuaria sendo a única porta de
entrada, e qualquer proxy que não injete `Tailscale-User-Login` deixaria todo
mundo de fora. Antes de fazer isso, revise a lista de logins, o
`GROOVE_PUBLIC_ORIGIN`, e pense duas vezes: o material do curso é pago e o
objetivo do servidor é justamente não publicá-lo.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `401 identity_required` no navegador | dispositivo com tag, ou acesso sem passar pelo `serve` (IP direto) | use o endereço `https://…ts.net` de um dispositivo de usuário |
| `401 identity_forbidden` | login fora de `GROOVE_ALLOWED_LOGINS` | copie o login exato do Tailscale para o ambiente e reinicie |
| `403 host_forbidden` | `GROOVE_PUBLIC_ORIGIN` diferente do endereço aberto (ex.: porta alternativa sem `:8443`) | ajuste a variável e reinicie |
| `403 origin_forbidden` em upload/escrita | mesma causa do item acima, mas na verificação de `Origin` | ajuste e reinicie |
| Serviço em ciclo de reinício | ambiente inválido, porta ocupada, syscall bloqueado | `journalctl -u groovegoblin -n 40 --no-pager`; se aparecer `EPERM`, apague a linha `SystemCallFilter=@system-service` da unidade e rode `sudo systemctl daemon-reload && sudo systemctl restart groovegoblin` |
| `507 insufficient_storage` | Pouco espaço livre | libere espaço ou baixe `GROOVE_MIN_FREE_BYTES` |
| "Sem servidor" no app | `/api/health` respondeu 404 (servidor sem `GROOVE_DATA_DIR`) ou a página veio do GitHub Pages | confira a variável e o `systemctl status` |
| `serve` diz que a porta está ocupada | outro serviço já publica em 443 | `install.sh --serve-port 8443` |
| `não achei o node no PATH` (nos três scripts) | Node 22 instalado fora do `PATH` (tarball, pasta própria) | rode o script com a pasta do Node à frente: `sudo env PATH="/caminho/do/node/bin:$PATH" deploy/install.sh …`. O serviço em si não depende disso: a unidade grava o caminho absoluto do Node |

## Desenvolvimento local

```bash
npm test                                  # testes do app e do servidor
npm run check                             # conferência dos módulos (node --check)
npm start                                 # só estático: http://127.0.0.1:5173
npm run build                             # gera dist/
GROOVE_DATA_DIR=/tmp/groove-dev GROOVE_AUTH=dev npm start   # com API, em modo dev
STATIC_ROOT=dist BASE_PATH=/ npm start    # servindo exatamente o que o Pi publica
```

No modo `dev` o servidor aceita só `Host` de loopback, recusa cabeçalhos de proxy
e não exige identidade; escritas precisam de `Origin` da própria origem
(`http://127.0.0.1:5173`). Use um diretório de dados de teste — nunca o do Pi e
nunca um sob `local/`.

Para instalar a trava local antes do commit (recusa PDF/áudio/`local/` e termos
privados, sem imprimir o termo):

```bash
install -m 0755 deploy/hooks/pre-commit .git/hooks/pre-commit
```

## Comandos de referência

```bash
# instalar / reinstalar (precisa do arquivo de ambiente pronto)
sudo /opt/groovegoblin/deploy/install.sh
sudo /opt/groovegoblin/deploy/install.sh --data-dir /srv/groovegoblin --serve-port 8443

# atualizar (serviço no ar, checkout sem alterações pendentes, branch main)
sudo /opt/groovegoblin/deploy/update.sh

# backup / restauração
curl -fsS -H "Tailscale-User-Login: usuario@example.org" http://127.0.0.1:5173/api/backup -o backup.ndjson.gz
sudo /opt/groovegoblin/deploy/restore.sh --latest
sudo /opt/groovegoblin/deploy/restore.sh --backup /home/usuario/backup.ndjson.gz

# ver o serviço e o que está publicado
systemctl status groovegoblin --no-pager
journalctl -u groovegoblin -n 40 --no-pager
tailscale serve status
curl -fsS -H "Tailscale-User-Login: usuario@example.org" http://127.0.0.1:5173/api/health
```
