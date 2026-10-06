#!/usr/bin/env bash
# GrooveGoblin — atualiza o código no Pi sem perder dados e sem deixar o site quebrado.
#
#   sudo deploy/update.sh [opções]
#
# Sequência (cada passo pode abortar antes de mexer no que está no ar):
#   1. lê e valida o ambiente privado; exige checkout sem alterações pendentes
#      em arquivos versionados e na branch esperada;
#   2. faz um instantâneo de segurança pela API (POST /api/backups) — obrigatório;
#   3. busca o remoto e só aceita avanço linear (merge --ff-only);
#   4. constrói o site para dist/ guardando o dist/ anterior de lado;
#   5. roda os testes;
#   6. reinicia o serviço e confere o /api/health (versão publicada).
# Se o build, os testes ou o health falharem, o dist/ anterior volta ao lugar e o
# código volta para a revisão anterior — mas só se o checkout ainda estiver
# exatamente como este script o deixou. Se alguém tiver alterado arquivos
# versionados nesse meio-tempo, nada é revertido por cima: o site antigo é
# reposto e você recebe os comandos para resolver à mão. O diretório de dados e
# qualquer caminho fora de dist/ e dist.old nunca são tocados.
#
# Opções:
#   --app-dir PATH    checkout do repositório (padrão: a raiz deste script)
#   --env-file PATH   ambiente do serviço (padrão /etc/groovegoblin/groove.env)
#   --data-dir PATH   diretório de dados (padrão /var/lib/groovegoblin)
#   --branch NAME     branch a acompanhar (padrão main)
#   --help
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEFAULT_ENV_FILE=/etc/groovegoblin/groove.env
DEFAULT_DATA_DIR=/var/lib/groovegoblin
UNIT_NAME=groovegoblin.service
UNIT_PATH=/etc/systemd/system/$UNIT_NAME
ENV_KEYS='PORT STATIC_ROOT BASE_PATH GROOVE_HOST GROOVE_DATA_DIR GROOVE_AUTH GROOVE_ALLOWED_LOGINS GROOVE_PUBLIC_ORIGIN GROOVE_MAX_BLOB_BYTES GROOVE_MIN_FREE_BYTES GROOVE_BACKUP_KEEP'

APP_DIR=$DEFAULT_APP_DIR
ENV_FILE=$DEFAULT_ENV_FILE
DATA_DIR=$DEFAULT_DATA_DIR
BRANCH=main
HEALTH_BODY=
HEALTH_LOGIN=
DIST=
DIST_OLD=
REMOTE_REV=

log() { printf '· %s\n' "$*"; }
warn() { printf 'aviso: %s\n' "$*" >&2; }
die() { printf 'erro: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

need_value() { [[ -n "${2:-}" ]] || die "$1 exige um valor."; }

while (( $# > 0 )); do
  case "$1" in
    --app-dir) need_value "$1" "${2:-}"; APP_DIR=$2; shift 2 ;;
    --env-file) need_value "$1" "${2:-}"; ENV_FILE=$2; shift 2 ;;
    --data-dir) need_value "$1" "${2:-}"; DATA_DIR=$2; shift 2 ;;
    --branch) need_value "$1" "${2:-}"; BRANCH=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "opção desconhecida: $1 (use --help)." ;;
  esac
done

abs_dir() {
  case "$1" in /*) ;; *) die "caminho precisa ser absoluto: $1" ;; esac
  [[ "$1" != / ]] || die "a raiz do sistema não pode ser usada aqui."
}

require_disjoint() {
  local a b
  a=$(realpath -m -- "$1"); b=$(realpath -m -- "$2")
  if [[ "$a" == "$b" || "$a" == "$b"/* ]]; then die "$3 ($a está dentro de $b)."; fi
  if [[ "$b" == "$a"/* ]]; then die "$3 ($b está dentro de $a)."; fi
}

# Lê o ambiente sem interpretá-lo: CHAVE=valor, chave conhecida, valor literal.
load_env_file() {
  local file=$1 line key value lineno=0 owner mode
  [[ -f "$file" ]] || die "arquivo de ambiente não encontrado: $file"
  if [[ -L "$file" ]]; then die "recuso arquivo de ambiente que é link simbólico: $file"; fi
  owner=$(stat -c '%u' -- "$file")
  mode=$(stat -c '%a' -- "$file")
  if [[ "$owner" != 0 ]]; then die "o arquivo de ambiente precisa pertencer ao root (está com uid $owner): $file"; fi
  if (( (8#$mode & 8#22) != 0 )); then
    die "permissões perigosas em $file: modo $mode (grupo/outros não podem ter escrita; use 0600)."
  fi
  if (( (8#$mode & 8#77) != 0 )); then
    warn "$file pode ser lido por grupo/outros (modo $mode); o recomendado é 0600."
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

validate() {
  abs_dir "$APP_DIR"
  abs_dir "$ENV_FILE"
  abs_dir "$DATA_DIR"
  [[ -f "$APP_DIR/server.js" ]] || die "não achei server.js em $APP_DIR."
  git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "$APP_DIR não é um checkout git."
  require_disjoint "$APP_DIR" "$DATA_DIR" "o diretório de dados precisa ficar fora do checkout"
  require_disjoint "$ENV_FILE" "$APP_DIR" "o arquivo de ambiente precisa ficar fora do checkout"
  [[ "$(realpath -m -- "${GROOVE_DATA_DIR:-}")" == "$(realpath -m -- "$DATA_DIR")" ]] \
    || die "GROOVE_DATA_DIR e --data-dir precisam ser o mesmo caminho."
  [[ "${GROOVE_HOST:-127.0.0.1}" == 127.0.0.1 ]] || die "GROOVE_HOST precisa ser 127.0.0.1."
  if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then
    IFS=',' read -r -a logins <<< "${GROOVE_ALLOWED_LOGINS:-}"
    HEALTH_LOGIN=${logins[0]//[[:space:]]/}
    [[ -n "$HEALTH_LOGIN" ]] || die "GROOVE_ALLOWED_LOGINS vazio: sem identidade o health não responde."
  else
    HEALTH_LOGIN=
  fi
}

health_body() {
  local -a extra=()
  if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then extra=(-H "Tailscale-User-Login: $HEALTH_LOGIN"); fi
  curl -fsS --max-time 5 "${extra[@]+"${extra[@]}"}" "http://127.0.0.1:${PORT:-5173}/api/health"
}

wait_health() {
  local tries=${1:-40} i body
  for ((i = 1; i <= tries; i++)); do
    if body=$(health_body 2>/dev/null) && [[ "$body" == *'"ok":true'* ]]; then HEALTH_BODY=$body; return 0; fi
    sleep 0.5
  done
  return 1
}

request_backup() {
  local -a extra=()
  if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then
    extra=(-H "Tailscale-User-Login: $HEALTH_LOGIN" -H "Origin: $GROOVE_PUBLIC_ORIGIN")
  else
    extra=(-H "Origin: http://127.0.0.1:${PORT:-5173}")
  fi
  curl -fsS --max-time 600 -X POST "${extra[@]}" "http://127.0.0.1:${PORT:-5173}/api/backups"
}

tracked_changes() { # número de arquivos versionados com alterações pendentes
  local count
  count=$(git -C "$APP_DIR" status --porcelain --untracked-files=no | wc -l)
  printf '%s' "${count//[[:space:]]/}"
}

sync_unit() { # regrava a unidade com os MESMOS valores já instalados
  [[ -f "$UNIT_PATH" ]] || { warn "não há $UNIT_PATH instalado; deixando o serviço como está."; return 0; }
  [[ -f "$APP_DIR/deploy/groovegoblin.service" ]] || return 0
  local user group work envfile exec_line rw tmp
  user=$(sed -n 's/^User=//p' "$UNIT_PATH" | head -n 1)
  group=$(sed -n 's/^Group=//p' "$UNIT_PATH" | head -n 1)
  work=$(sed -n 's/^WorkingDirectory=//p' "$UNIT_PATH" | head -n 1)
  envfile=$(sed -n 's/^EnvironmentFile=//p' "$UNIT_PATH" | head -n 1)
  exec_line=$(sed -n 's/^ExecStart=//p' "$UNIT_PATH" | head -n 1)
  rw=$(sed -n 's/^ReadWritePaths=//p' "$UNIT_PATH" | head -n 1)
  if [[ -z "$user" || -z "$group" || -z "$work" || -z "$envfile" || -z "$exec_line" || -z "$rw" ]]; then
    warn "a unidade instalada não segue o modelo do repositório; não vou reescrevê-la."
    return 0
  fi
  tmp=$(mktemp)
  sed \
    -e "s|^User=.*$|User=$user|" \
    -e "s|^Group=.*$|Group=$group|" \
    -e "s|^WorkingDirectory=.*$|WorkingDirectory=$work|" \
    -e "s|^EnvironmentFile=.*$|EnvironmentFile=$envfile|" \
    -e "s|^Environment=HOME=.*$|Environment=HOME=$rw|" \
    -e "s|^ExecStart=.*$|ExecStart=$exec_line|" \
    -e "s|^ReadWritePaths=.*$|ReadWritePaths=$rw|" \
    -e "s|^Documentation=.*$|Documentation=file:$work/deploy/README.md|" \
    "$APP_DIR/deploy/groovegoblin.service" > "$tmp"
  if ! cmp -s "$tmp" "$UNIT_PATH"; then
    install -m 0644 -o root -g root "$tmp" "$UNIT_PATH"
    systemctl daemon-reload
    log "unidade atualizada com os mesmos usuário/caminhos e recarregada."
  fi
  rm -f "$tmp"
}

restore_old_site() { # devolve dist.old para dist (só o diretório de build do próprio script)
  if [[ -d "$DIST_OLD" ]]; then
    rm -rf "$DIST"
    mv "$DIST_OLD" "$DIST"
    return 0
  fi
  return 1
}

rollback() { # rollback REV_ANTERIOR motivo; devolve 1 quando NÃO pôde reverter (já avisou o que fazer à mão)
  local rev=$1 reason=$2 head dirty
  warn "revertendo: $reason"
  head=$(git -C "$APP_DIR" rev-parse HEAD)
  dirty=$(tracked_changes)
  if (( dirty > 0 )); then
    restore_old_site || true
    warn "o checkout tem $dirty arquivo(s) versionado(s) alterado(s) depois do início da atualização; não vou reverter nada por cima disso."
    warn "o site antigo foi reposto em $DIST e eu não reiniciei o serviço."
    warn "Resolva à mão: git -C $APP_DIR status; depois sudo systemctl restart $UNIT_NAME"
    return 1
  fi
  if [[ -n "$REMOTE_REV" && "$head" != "$REMOTE_REV" ]]; then
    restore_old_site || true
    warn "o HEAD do checkout não é mais a revisão que eu apliquei; não vou mexer nele."
    warn "o site antigo foi reposto em $DIST. Confira à mão: git -C $APP_DIR log --oneline -1; sudo systemctl status $UNIT_NAME"
    return 1
  fi
  restore_old_site || true
  git -C "$APP_DIR" reset --hard "$rev" >/dev/null
  sync_unit || true
  systemctl restart "$UNIT_NAME"
  if wait_health 40; then
    warn "voltou a funcionar na revisão ${rev:0:12} (health: $HEALTH_BODY)."
  else
    warn "o serviço também não respondeu na revisão anterior; veja: journalctl -u $UNIT_NAME -n 40 --no-pager"
  fi
  return 0
}

# --- validação (nada muda nesta parte) ---------------------------------------
abs_dir "$APP_DIR"
abs_dir "$ENV_FILE"
abs_dir "$DATA_DIR"
command -v git >/dev/null 2>&1 || die "este script precisa do git."
load_env_file "$ENV_FILE"
validate

# --- 1. checkout sem alterações pendentes, na branch certa -------------------
CURRENT_BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
  || die "o checkout está na branch $CURRENT_BRANCH, não em $BRANCH. Troque com 'git -C $APP_DIR checkout $BRANCH'."
DIRTY_COUNT=$(tracked_changes)
if (( DIRTY_COUNT > 0 )); then
  die "o checkout tem $DIRTY_COUNT arquivo(s) versionado(s) com alterações pendentes; o update não mexe em nada até você resolver.
Veja o que é com 'git -C $APP_DIR status' e então commite, guarde (git stash) ou descarte."
fi

[[ $(id -u) -eq 0 ]] || die "rode como root: sudo $0 $*"
command -v systemctl >/dev/null 2>&1 || die "este script precisa de systemd."
command -v curl >/dev/null 2>&1 || die "este script precisa do curl."

NPM_BIN=$(command -v npm || true)
[[ -n "$NPM_BIN" ]] || die "não achei o npm no PATH."
systemctl cat "$UNIT_NAME" >/dev/null 2>&1 \
  || die "o serviço $UNIT_NAME não está instalado. Rode primeiro: sudo $APP_DIR/deploy/install.sh"

DIST=$APP_DIR/dist
DIST_OLD=$APP_DIR/dist.old

PREV_REV=$(git -C "$APP_DIR" rev-parse HEAD)
log "revisão atual: ${PREV_REV:0:12}"

# --- 2. instantâneo de segurança pela API (obrigatório) ----------------------
systemctl is-active --quiet "$UNIT_NAME" \
  || die "o serviço $UNIT_NAME está parado e o update exige um instantâneo de segurança antes de qualquer mudança.
Suba o serviço (sudo systemctl start $UNIT_NAME) e rode o update de novo; se ele não sobe, conserte o ambiente primeiro."
if BACKUP_JSON=$(request_backup); then
  log "instantâneo de segurança criado: $BACKUP_JSON"
else
  die "não consegui criar o instantâneo de segurança pela API (POST /api/backups). Nada foi atualizado."
fi

# --- 3. avanço linear --------------------------------------------------------
git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1 \
  || die "o checkout não tem o remoto 'origin'. Configure com: git -C $APP_DIR remote add origin <url do repositório>"
git -C "$APP_DIR" fetch --prune origin
REMOTE_REV=$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")
if [[ "$REMOTE_REV" == "$PREV_REV" ]]; then
  log "origin/$BRANCH já está em ${PREV_REV:0:12}; nada para atualizar."
  if wait_health 20; then
    log "health: $HEALTH_BODY"
    exit 0
  fi
  die "sem nada para atualizar e o /api/health não respondeu (journalctl -u $UNIT_NAME -n 40 --no-pager)."
fi
git -C "$APP_DIR" merge-base --is-ancestor "$PREV_REV" "$REMOTE_REV" \
  || die "o remoto não é um avanço linear (histórico divergente); resolva à mão antes de rodar o update."
if ! git -C "$APP_DIR" merge --ff-only "$REMOTE_REV" >/dev/null 2>&1; then
  die "não consegui avançar o histórico até ${REMOTE_REV:0:12}; nada foi instalado.
Veja o motivo com: git -C $APP_DIR merge --ff-only origin/$BRANCH"
fi
log "código atualizado: ${PREV_REV:0:12} -> ${REMOTE_REV:0:12}"

# --- 4. build com dist anterior guardado -------------------------------------
if [[ -e "$DIST_OLD" ]]; then
  log "removendo sobra da execução anterior em $DIST_OLD (diretório de build do próprio script)."
  rm -rf "$DIST_OLD"
fi
if [[ -d "$DIST" ]]; then mv "$DIST" "$DIST_OLD"; fi
if ! ( cd "$APP_DIR" && "$NPM_BIN" run build ); then
  rollback "$PREV_REV" "o build falhou" || true
  die "atualização abortada: build falhou; o site no ar continua o anterior."
fi
if [[ ! -f "$DIST/index.html" || ! -f "$DIST/sw.js" || ! -f "$DIST/offline-assets.json" ]]; then
  rollback "$PREV_REV" "o build saiu incompleto" || true
  die "atualização abortada: dist/ incompleto (index.html, sw.js, offline-assets.json)."
fi
chmod -R a+rX "$DIST"
log "site construído em $DIST"

# --- 5. testes ---------------------------------------------------------------
log "rodando npm test..."
if ! ( cd "$APP_DIR" && "$NPM_BIN" test ); then
  rollback "$PREV_REV" "os testes falharam" || true
  die "atualização abortada: os testes falharam; o site no ar continua o anterior."
fi
log "testes passaram"

# --- 6. unidade, reinício e health -------------------------------------------
sync_unit
systemctl restart "$UNIT_NAME"
if ! wait_health 40; then
  if rollback "$PREV_REV" "o /api/health não respondeu depois do reinício"; then
    die "atualização revertida para ${PREV_REV:0:12} (health: $HEALTH_BODY). Veja: journalctl -u $UNIT_NAME -n 40 --no-pager"
  fi
  die "o /api/health não respondeu e eu não reverti o checkout (veja os avisos acima). Veja: journalctl -u $UNIT_NAME -n 40 --no-pager"
fi
rm -rf "$DIST_OLD"
log "health: $HEALTH_BODY"
cat <<EOF

Atualizado: ${PREV_REV:0:12} -> ${REMOTE_REV:0:12}, no ar e respondendo.
Dados intactos em $DATA_DIR. Instantâneo de segurança anterior ao update em $DATA_DIR/backups/.
Se algo parecer errado: sudo $APP_DIR/deploy/restore.sh --latest
EOF
