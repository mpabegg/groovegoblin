#!/usr/bin/env bash
# GrooveGoblin — instala (ou reinstala) o serviço pessoal no Raspberry Pi.
#
#   sudo deploy/install.sh [opções]
#
# O que este script faz, nesta ordem:
#   1. lê e valida o arquivo de ambiente privado (fora do checkout);
#   2. valida caminhos, Node 22+, modo de autenticação e origem pública;
#   3. cria o usuário de serviço e o diretório de dados (0700, dono = serviço);
#   4. roda `npm run build` e confere o dist/ publicado;
#   5. instala /etc/systemd/system/groovegoblin.service, habilita e reinicia;
#   6. espera o /api/health responder em 127.0.0.1;
#   7. publica o serviço em HTTPS na tailnet com `tailscale serve --bg`.
#
# Nada aqui toca a sua conta do Tailscale (painel, ACLs, chaves) nem substitui
# configuração de `serve` que já exista. O passo 7 só ADICIONA a porta HTTPS
# pedida: se ela já estiver publicada por outro serviço, o script para e mostra o
# comando com outra porta; as outras portas ficam como estavam.
#
# O arquivo de ambiente nunca é executado como shell: cada linha precisa ser
# CHAVE=valor com uma chave conhecida do servidor, e o valor entra literal.
#
# Opções:
#   --app-dir PATH     checkout do repositório (padrão: a raiz deste script)
#   --data-dir PATH    diretório de dados, fora do checkout (padrão /var/lib/groovegoblin)
#   --user NAME        usuário de serviço (padrão groovegoblin)
#   --env-file PATH    ambiente do serviço (padrão /etc/groovegoblin/groove.env)
#   --serve-port N     porta HTTPS do `tailscale serve` (padrão 443)
#   --skip-serve       não mexe no `tailscale serve`
#   --help
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEFAULT_DATA_DIR=/var/lib/groovegoblin
DEFAULT_SERVICE_USER=groovegoblin
DEFAULT_ENV_FILE=/etc/groovegoblin/groove.env
UNIT_NAME=groovegoblin.service
UNIT_PATH=/etc/systemd/system/$UNIT_NAME
DEFAULT_SERVE_PORT=443
# Chaves aceitas no arquivo de ambiente: exatamente as do servidor (nenhuma convenção paralela).
ENV_KEYS='PORT STATIC_ROOT BASE_PATH GROOVE_HOST GROOVE_DATA_DIR GROOVE_AUTH GROOVE_ALLOWED_LOGINS GROOVE_PUBLIC_ORIGIN GROOVE_MAX_BLOB_BYTES GROOVE_MIN_FREE_BYTES GROOVE_BACKUP_KEEP GROOVE_INTAKE_MAX_ENTRIES GROOVE_INTAKE_MAX_ZIP_BYTES GROOVE_INTAKE_MAX_ZIP_PDF_MEMBERS GROOVE_INTAKE_MAX_ZIP_PDF_BYTES GROOVE_INTAKE_MAX_COURSE_BYTES'

APP_DIR=$DEFAULT_APP_DIR
DATA_DIR=$DEFAULT_DATA_DIR
SERVICE_USER=$DEFAULT_SERVICE_USER
ENV_FILE=$DEFAULT_ENV_FILE
SERVE_PORT=$DEFAULT_SERVE_PORT
SKIP_SERVE=0
HEALTH_BODY=
HEALTH_LOGIN=

log() { printf '· %s\n' "$*"; }
warn() { printf 'aviso: %s\n' "$*" >&2; }
die() { printf 'erro: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

need_value() {
  [[ -n "${2:-}" ]] || die "$1 exige um valor."
}

while (( $# > 0 )); do
  case "$1" in
    --app-dir) need_value "$1" "${2:-}"; APP_DIR=$2; shift 2 ;;
    --data-dir) need_value "$1" "${2:-}"; DATA_DIR=$2; shift 2 ;;
    --user) need_value "$1" "${2:-}"; SERVICE_USER=$2; shift 2 ;;
    --env-file) need_value "$1" "${2:-}"; ENV_FILE=$2; shift 2 ;;
    --serve-port) need_value "$1" "${2:-}"; SERVE_PORT=$2; shift 2 ;;
    --skip-serve) SKIP_SERVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "opção desconhecida: $1 (use --help)." ;;
  esac
done

abs_dir() {
  case "$1" in
    /*) ;;
    *) die "caminho precisa ser absoluto: $1" ;;
  esac
  [[ "$1" != / ]] || die "a raiz do sistema não pode ser usada aqui."
}

require_disjoint() { # require_disjoint A B "mensagem"
  local a b
  a=$(realpath -m -- "$1")
  b=$(realpath -m -- "$2")
  if [[ "$a" == "$b" || "$a" == "$b"/* ]]; then die "$3 ($a está dentro de $b)."; fi
  if [[ "$b" == "$a"/* ]]; then die "$3 ($b está dentro de $a)."; fi
}

# --- 1. arquivo de ambiente privado ------------------------------------------
# Lê o arquivo sem interpretá-lo: CHAVE=valor, chave conhecida, valor literal.
# Não há `source`: uma linha estranha no arquivo é recusada, nunca executada.
load_env_file() {
  local file=$1 line key value lineno=0 owner mode
  [[ -f "$file" ]] || die "arquivo de ambiente não encontrado: $file
Crie-o a partir do modelo:
  sudo install -d -m 0755 ${file%/*}
  sudo install -m 0600 -o root -g root deploy/groove.env.example $file
  sudo editor $file"
  if [[ -L "$file" ]]; then die "recuso arquivo de ambiente que é link simbólico: $file"; fi
  owner=$(stat -c '%u' -- "$file")
  mode=$(stat -c '%a' -- "$file")
  if [[ "$owner" != 0 ]]; then die "o arquivo de ambiente precisa pertencer ao root (está com uid $owner): $file"; fi
  if (( (8#$mode & 8#22) != 0 )); then
    die "permissões perigosas em $file: modo $mode (grupo/outros não podem ter escrita; use 0600)."
  fi
  if (( (8#$mode & 8#77) != 0 )); then
    warn "$file pode ser lido por grupo/outros (modo $mode); o recomendado é 0600 (só o root lê o seu login e a origem)."
  fi

  for key in $ENV_KEYS; do unset "$key"; done
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    case "$line" in ''|'#'*) continue ;; esac
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      die "linha $lineno de $file não está no formato CHAVE=valor (veja deploy/groove.env.example)."
    fi
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ " $ENV_KEYS " != *" $key "* ]]; then
      die "chave desconhecida na linha $lineno de $file. Aceitas: $ENV_KEYS"
    fi
    case "$value" in
      \"*\") value=${value:1:${#value}-2} ;;
      \'*\') value=${value:1:${#value}-2} ;;
    esac
    if [[ "$value" == *'`'* || "$value" == *'$('* || "$value" == *'${'* ]]; then
      die "linha $lineno de $file tem valor com expansão de shell; escreva o valor literal."
    fi
    if [[ "$value" == *'\' ]]; then
      die "linha $lineno de $file termina em barra invertida; não há continuação de linha."
    fi
    printf -v "$key" '%s' "$value"
  done < "$file"
}

# --- 2. validação ------------------------------------------------------------
validate() {
  abs_dir "$APP_DIR"
  abs_dir "$DATA_DIR"
  [[ -f "$APP_DIR/server.js" ]] || die "não achei server.js em $APP_DIR (aponte --app-dir para o checkout do repositório)."
  [[ -f "$APP_DIR/package.json" ]] || die "não achei package.json em $APP_DIR."
  [[ -f "$APP_DIR/deploy/$UNIT_NAME" ]] || die "não achei deploy/$UNIT_NAME em $APP_DIR."
  require_disjoint "$APP_DIR" "$DATA_DIR" "o diretório de dados precisa ficar fora do checkout"
  require_disjoint "$ENV_FILE" "$APP_DIR" "o arquivo de ambiente precisa ficar fora do checkout"
  [[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "nome de usuário inválido: $SERVICE_USER"
  [[ "$SERVE_PORT" =~ ^[0-9]{1,5}$ ]] || die "--serve-port precisa ser um número."
  (( SERVE_PORT >= 1 && SERVE_PORT <= 65535 )) || die "--serve-port fora do intervalo 1..65535."

  local port=${PORT:-5173}
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || die "PORT precisa ser um número (recebido: $port)."
  (( port >= 1 && port <= 65535 )) || die "PORT fora do intervalo 1..65535."

  local host=${GROOVE_HOST:-127.0.0.1}
  [[ "$host" == 127.0.0.1 ]] || die "GROOVE_HOST precisa ser 127.0.0.1 (o servidor só pode escutar em loopback): $host"

  [[ "${BASE_PATH:-/}" == / ]] || die "em produção o app é servido na raiz; BASE_PATH precisa ser / (recebido: $BASE_PATH)."

  [[ -n "${GROOVE_DATA_DIR:-}" ]] || die "GROOVE_DATA_DIR precisa estar definido em $ENV_FILE."
  abs_dir "$GROOVE_DATA_DIR"
  [[ "$(realpath -m -- "$GROOVE_DATA_DIR")" == "$(realpath -m -- "$DATA_DIR")" ]] \
    || die "GROOVE_DATA_DIR ($GROOVE_DATA_DIR) e --data-dir ($DATA_DIR) precisam ser o mesmo caminho; ajuste o arquivo de ambiente ou o argumento."
  require_disjoint "$APP_DIR" "$GROOVE_DATA_DIR" "o diretório de dados precisa ficar fora do checkout"

  local static_root=${STATIC_ROOT:-}
  case "$static_root" in
    dist|./dist) ;;
    "$APP_DIR/dist") ;;
    '') die "defina STATIC_ROOT=dist em $ENV_FILE (é o site construído por npm run build)." ;;
    *) die "STATIC_ROOT precisa ser dist (ou $APP_DIR/dist), não $static_root." ;;
  esac

  local mode=${GROOVE_AUTH:-dev}
  case "$mode" in dev|tailscale) ;; *) die "GROOVE_AUTH precisa ser dev ou tailscale." ;; esac
  if [[ "$mode" == tailscale ]]; then
    [[ -n "${GROOVE_ALLOWED_LOGINS:-}" ]] || die "GROOVE_AUTH=tailscale exige GROOVE_ALLOWED_LOGINS (o servidor recusa subir sem a lista)."
    [[ -n "${GROOVE_PUBLIC_ORIGIN:-}" ]] || die "GROOVE_AUTH=tailscale exige GROOVE_PUBLIC_ORIGIN."
    [[ "$GROOVE_PUBLIC_ORIGIN" == https://* ]] || die "GROOVE_PUBLIC_ORIGIN precisa ser https://…"
    local authority=${GROOVE_PUBLIC_ORIGIN#https://}
    case "$authority" in
      ''|*/*|*'?'*|*'#'*) die "GROOVE_PUBLIC_ORIGIN precisa ser só a origem: https://<máquina>.<tailnet>.ts.net (sem caminho nem barra no fim)." ;;
    esac
    [[ "$authority" == "${authority,,}" ]] || die "GROOVE_PUBLIC_ORIGIN precisa estar em minúsculas (como o próprio servidor exige)."
    case "$GROOVE_PUBLIC_ORIGIN:$GROOVE_ALLOWED_LOGINS" in
      *example.org*|*example.ts.net*|*exemplo.ts.net*)
        die "o ambiente ainda tem os valores fictícios do modelo (example.org/exemplo.ts.net). Edite $ENV_FILE com o endereço e o login reais da sua tailnet." ;;
    esac
    IFS=',' read -r -a logins <<< "$GROOVE_ALLOWED_LOGINS"
    HEALTH_LOGIN=${logins[0]//[[:space:]]/}
    [[ -n "$HEALTH_LOGIN" ]] || die "GROOVE_ALLOWED_LOGINS não tem nenhum login utilizável."
    if (( SERVE_PORT != 443 )); then
      case "$authority" in
        *":$SERVE_PORT") ;;
        *) die "com --serve-port $SERVE_PORT, GROOVE_PUBLIC_ORIGIN precisa terminar em :$SERVE_PORT (ex.: https://groove.exemplo.ts.net:$SERVE_PORT)." ;;
      esac
    else
      case "$authority" in
        *:*) die "GROOVE_PUBLIC_ORIGIN na porta 443 não leva porta: use https://<máquina>.<tailnet>.ts.net." ;;
      esac
    fi
  else
    HEALTH_LOGIN=
    warn "GROOVE_AUTH=dev: sem identidade, qualquer processo desta máquina alcança os seus dados. Use tailscale no Pi."
    if [[ -n "${GROOVE_ALLOWED_LOGINS:-}" || -n "${GROOVE_PUBLIC_ORIGIN:-}" ]]; then
      die "GROOVE_ALLOWED_LOGINS e GROOVE_PUBLIC_ORIGIN só valem com GROOVE_AUTH=tailscale."
    fi
  fi
  command -v curl >/dev/null 2>&1 || die "preciso do curl instalado (sudo apt install curl)."
}

# --- utilidades de execução --------------------------------------------------
health_body() {
  local -a extra=()
  if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then extra=(-H "Tailscale-User-Login: $HEALTH_LOGIN"); fi
  curl -fsS --max-time 5 "${extra[@]+"${extra[@]}"}" "http://127.0.0.1:${PORT:-5173}/api/health"
}

wait_health() {
  local tries=${1:-40} i body
  for ((i = 1; i <= tries; i++)); do
    if body=$(health_body 2>/dev/null) && [[ "$body" == *'"ok":true'* ]]; then
      HEALTH_BODY=$body
      return 0
    fi
    sleep 0.5
  done
  return 1
}

render_unit() {
  local node_bin=$1
  sed \
    -e "s|^User=.*$|User=$SERVICE_USER|" \
    -e "s|^Group=.*$|Group=$SERVICE_GROUP|" \
    -e "s|^WorkingDirectory=.*$|WorkingDirectory=$APP_DIR|" \
    -e "s|^EnvironmentFile=.*$|EnvironmentFile=$ENV_FILE|" \
    -e "s|^Environment=HOME=.*$|Environment=HOME=$DATA_DIR|" \
    -e "s|^ExecStart=.*$|ExecStart=$node_bin server.js|" \
    -e "s|^ReadWritePaths=.*$|ReadWritePaths=$DATA_DIR|" \
    -e "s|^Documentation=.*$|Documentation=file:$APP_DIR/deploy/README.md|" \
    "$APP_DIR/deploy/$UNIT_NAME"
}

# Lê o JSON do `serve` (stdin) e imprime uma linha por porta publicada:
#   https<TAB>porta<TAB>destino-do-caminho-/
#   tcp<TAB>porta<TAB>https|outro
# JSON que não dá para ler vira a linha "!parse" (nunca adivinha).
serve_json_ports() {
  "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let cfg;
      try { cfg = JSON.parse(raw.trim() || "{}"); }
      catch { process.stdout.write("!parse\n"); return; }
      for (const [key, value] of Object.entries(cfg.Web || {})) {
        const port = key.slice(key.lastIndexOf(":") + 1);
        const root = (value && value.Handlers && value.Handlers["/"]) || {};
        process.stdout.write("https\t" + port + "\t" + (root.Proxy || root.Text || (root.Path ? "file:" + root.Path : "?")) + "\n");
      }
      for (const [port, value] of Object.entries(cfg.TCP || {})) {
        process.stdout.write("tcp\t" + port + "\t" + (value && value.HTTPS ? "https" : "outro") + "\n");
      }
    });
  '
}

# Publica o serviço no `tailscale serve`. Regra: só ADICIONA a porta HTTPS pedida
# quando ela está livre; nunca substitui nem remove listener ou caminho de outro
# serviço, e nunca toca em configuração que não conseguiu ler.
configure_serve() {
  command -v tailscale >/dev/null 2>&1 || die "não achei o CLI do tailscale. Instale e suba o Tailscale, ou rode com --skip-serve."
  tailscale status >/dev/null 2>&1 || die "o Tailscale não respondeu (tailscale status). Rode 'sudo tailscale up' e tente de novo, ou use --skip-serve."
  local target="http://127.0.0.1:${PORT:-5173}" status json before after pair restored= ours=0 taken=0 missing=0
  status=$(tailscale serve status 2>&1 || true)
  json=$(tailscale serve status --json 2>/dev/null || true)
  before=$(printf '%s' "$json" | serve_json_ports)

  if [[ "$before" == *'!parse'* ]]; then
    # Sem JSON legível: decide pelo texto e, na dúvida, não mexe em nada.
    if [[ "$status" == *"$target"* ]]; then
      log "tailscale serve já publica $target; nada a mudar."
    elif [[ "$status" == *":$SERVE_PORT"* ]]; then
      printf '%s\n' "$status" >&2
      die "a porta HTTPS $SERVE_PORT já aparece na configuração de 'tailscale serve' e não consegui ler o JSON para confirmar de quem é; não vou substituí-la.
Escolha uma porta livre:  sudo $0 --serve-port 8443"
    elif [[ "$status" == *"https://"* || "$status" == *"http://"* ]]; then
      printf '%s\n' "$status" >&2
      die "não consegui ler a configuração de 'tailscale serve' desta máquina; publicaria às cegas e prefiro parar.
Confira 'tailscale serve status' e publique numa porta livre:  sudo $0 --serve-port 8443"
    else
      tailscale serve --bg --https="$SERVE_PORT" "$target"
    fi
    log "serve: porta(s) HTTPS publicada(s): $(printf '%s' "$(tailscale serve status --json 2>/dev/null || true)" | serve_json_ports | awk -F'\t' '$1 == "https" { print $2 }' | paste -sd' ' -)"
    return 0
  fi

  while IFS=$'\t' read -r kind port rest; do
    [[ "$port" == "$SERVE_PORT" ]] || continue
    if [[ "$kind" == https && "$rest" == "$target" ]]; then ours=1; else taken=1; fi
  done <<< "$before"

  if (( ours == 1 )); then
    log "tailscale serve já publica $target na porta HTTPS $SERVE_PORT; nada a mudar."
    return 0
  fi
  if (( taken == 1 )); then
    printf '%s\n' "$status" >&2
    die "a porta HTTPS $SERVE_PORT já está publicada por outro serviço; não vou substituí-la nem removê-la.
Publique o GrooveGoblin numa porta livre (o resto da configuração do serve fica intacto):
  sudo $0 --serve-port 8443
(com --serve-port 8443, GROOVE_PUBLIC_ORIGIN precisa terminar em :8443)"
  fi

  log "publicando $target na porta HTTPS $SERVE_PORT (adicionando ao que já existe)..."
  tailscale serve --bg --https="$SERVE_PORT" "$target"

  after=$(printf '%s' "$(tailscale serve status --json 2>/dev/null || true)" | serve_json_ports)
  if [[ "$after" != *"https"$'\t'"$SERVE_PORT"$'\t'"$target"* ]]; then
    printf '%s\n' "$after" >&2
    die "o 'tailscale serve' não confirmou $target na porta $SERVE_PORT; rode 'tailscale serve status' e publique na mão."
  fi
  while IFS= read -r pair; do
    [[ -n "$pair" ]] || continue
    grep -qxF -- "$pair" <<< "$after" || missing=1
  done <<< "$before"
  if (( missing == 1 )); then
    warn "o 'tailscale serve' alterou configuração que já existia; restaurando o que sumiu..."
    while IFS=$'\t' read -r kind port rest; do
      [[ -n "$port" ]] || continue
      grep -qxF -- "$kind"$'\t'"$port"$'\t'"$rest" <<< "$after" && continue
      if [[ "$kind" == https && "$rest" == http://127.0.0.1:* ]]; then
        if tailscale serve --bg --https="$port" "$rest"; then
          restored+="|$port|"
        else
          warn "não consegui restaurar a porta HTTPS $port → $rest"
        fi
      elif [[ "$kind" == tcp && "$restored" == *"|$port|"* ]]; then
        : # a porta voltou junto com o handler HTTPS dela
      else
        warn "restaure na mão a porta $port ($kind $rest), que existia antes desta instalação"
      fi
    done <<< "$before"
    printf '%s\n' "$(tailscale serve status 2>&1 || true)" >&2
    die "a configuração de 'tailscale serve' desta máquina foi mexida por engano; ela foi restaurada e o GrooveGoblin está rodando, mas confira 'tailscale serve status' antes de seguir."
  fi
  log "serve: porta(s) HTTPS publicada(s): $(printf '%s' "$after" | awk -F'\t' '$1 == "https" { print $2 }' | paste -sd' ' -)"
}

# --- execução ----------------------------------------------------------------
abs_dir "$APP_DIR"
abs_dir "$DATA_DIR"
abs_dir "$ENV_FILE"
load_env_file "$ENV_FILE"
validate

[[ $(id -u) -eq 0 ]] || die "rode como root: sudo $0 $*"
command -v systemctl >/dev/null 2>&1 || die "este instalador precisa de systemd."

NODE_BIN=$(command -v node || true)
[[ -n "$NODE_BIN" ]] || die "não achei o node no PATH. Instale o Node 22 (ex.: NodeSource) e tente de novo."
NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(process.versions.node.split(".")[0])')
(( NODE_MAJOR >= 22 )) || die "preciso do Node 22 ou mais novo (encontrado $("$NODE_BIN" -v) em $NODE_BIN)."
NPM_BIN=$(command -v npm || true)
[[ -n "$NPM_BIN" ]] || die "não achei o npm no PATH."

log "usuário de serviço: $SERVICE_USER"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  SERVICE_GROUP=$(id -gn "$SERVICE_USER")
else
  command -v useradd >/dev/null 2>&1 || die "não achei o useradd para criar o usuário $SERVICE_USER."
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  SERVICE_GROUP=$(id -gn "$SERVICE_USER")
  log "usuário $SERVICE_USER criado (grupo $SERVICE_GROUP, sem login)."
fi

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR"
if [[ -e "$DATA_DIR/groovegoblin-data.json" ]]; then
  MARKER_OWNER=$(stat -c '%U' -- "$DATA_DIR/groovegoblin-data.json")
  [[ "$MARKER_OWNER" == "$SERVICE_USER" ]] || die "o diretório de dados já tem dados de outro dono ($MARKER_OWNER).
Ajuste antes de seguir:  sudo chown -R $SERVICE_USER:$SERVICE_GROUP $DATA_DIR"
fi
log "diretório de dados: $DATA_DIR (dono $SERVICE_USER, modo 0700)"

log "construindo o site (npm run build)..."
( cd "$APP_DIR" && "$NPM_BIN" run build )
[[ -f "$APP_DIR/dist/index.html" && -f "$APP_DIR/dist/sw.js" && -f "$APP_DIR/dist/offline-assets.json" ]] \
  || die "o build não produziu dist/ completo (index.html, sw.js, offline-assets.json)."
chmod -R a+rX "$APP_DIR/dist"
log "dist pronto em $APP_DIR/dist"

if command -v runuser >/dev/null 2>&1; then
  if ! runuser -u "$SERVICE_USER" -- test -r "$APP_DIR/server.js" ||
     ! runuser -u "$SERVICE_USER" -- test -r "$APP_DIR/dist/index.html" ||
     ! runuser -u "$SERVICE_USER" -- test -x "$APP_DIR"; then
    warn "o usuário $SERVICE_USER não consegue ler o checkout; liberando leitura (sem tocar em escrita)."
    chmod -R a+rX "$APP_DIR"
  fi
fi

install -d -m 0755 /etc/groovegoblin
render_unit "$NODE_BIN" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
systemctl restart "$UNIT_NAME"
log "serviço habilitado no boot e reiniciado: $UNIT_NAME"

if ! wait_health 40; then
  warn "o /api/health não respondeu em 20 s. Últimas linhas do serviço:"
  journalctl -u "$UNIT_NAME" -n 20 --no-pager >&2 || true
  die "instalação incompleta: o serviço não respondeu em http://127.0.0.1:${PORT:-5173}/api/health"
fi
log "health: $HEALTH_BODY"

if (( SKIP_SERVE == 0 )); then
  configure_serve
else
  log "pulando o tailscale serve (--skip-serve). Quando quiser:"
  log "  sudo tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:${PORT:-5173}"
fi

cat <<EOF

Pronto. Abra no laptop (na mesma tailnet):  ${GROOVE_PUBLIC_ORIGIN:-https://<máquina>.<tailnet>.ts.net}
Apostilas e faixas: copie os arquivos baixados, tudo plano, para $DATA_DIR/entrada/<id do curso>/
  (o servidor cria a pasta; arquivos de outro dono ficam ilegíveis: use chown -R $SERVICE_USER $DATA_DIR/entrada)
Backup:  curl -fsS ${HEALTH_LOGIN:+-H \"Tailscale-User-Login: $HEALTH_LOGIN\" }http://127.0.0.1:${PORT:-5173}/api/backup -o backup.ndjson.gz
Restauração:  sudo $APP_DIR/deploy/restore.sh --latest
EOF
