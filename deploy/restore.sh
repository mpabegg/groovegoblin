#!/usr/bin/env bash
# GrooveGoblin — restaura um instantâneo no diretório de dados do Pi.
#
#   sudo deploy/restore.sh --latest
#   sudo deploy/restore.sh --backup /caminho/para/groovegoblin-AAAA-MM-DD.ndjson.gz
#
# O trabalho de verdade é do próprio servidor (`node server/restore.js`), que
# valida o arquivo inteiro antes de tocar em qualquer coisa, grava um instantâneo
# pre-restore-<carimbo>.ndjson.gz e só então troca os documentos. Este script:
#   · exige o serviço parado (o data dir tem um lock que recusa dois processos);
#   · roda primeiro uma validação a seco e mostra as contagens;
#   · pede confirmação explícita antes de substituir os dados (a menos que --yes);
#   · reinicia o serviço no fim, inclusive quando a restauração falha;
#   · confere o /api/health depois, para você ver que o app voltou.
#
# Os blobs (PDFs e áudios) vivem só no diretório de dados e não são apagados por
# uma restauração: o instantâneo v2 traz os blobs dentro dele, então o que voltar
# do arquivo é restaurado, e o que já estava no disco continua lá.
#
# O arquivo de ambiente nunca é executado como shell: cada linha precisa ser
# CHAVE=valor com uma chave conhecida do servidor, e o valor entra literal.
#
# Opções:
#   --latest          usa o instantâneo diário mais novo do próprio diretório de dados
#   --backup ARQUIVO  usa um arquivo específico (ex.: um download feito no navegador)
#   --app-dir PATH    checkout do repositório (padrão: a raiz deste script)
#   --env-file PATH   ambiente do serviço (padrão /etc/groovegoblin/groove.env)
#   --data-dir PATH   diretório de dados (padrão /var/lib/groovegoblin)
#   --yes             não pergunta nada (use quando já conferiu o que vai ser feito)
#   --no-restart      não reinicia o serviço no fim
#   --help
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEFAULT_ENV_FILE=/etc/groovegoblin/groove.env
DEFAULT_DATA_DIR=/var/lib/groovegoblin
UNIT_NAME=groovegoblin.service
ENV_KEYS='PORT STATIC_ROOT BASE_PATH GROOVE_HOST GROOVE_DATA_DIR GROOVE_AUTH GROOVE_ALLOWED_LOGINS GROOVE_PUBLIC_ORIGIN GROOVE_MAX_BLOB_BYTES GROOVE_MIN_FREE_BYTES GROOVE_BACKUP_KEEP'

APP_DIR=$DEFAULT_APP_DIR
ENV_FILE=$DEFAULT_ENV_FILE
DATA_DIR=$DEFAULT_DATA_DIR
BACKUP_FILE=
USE_LATEST=0
ASSUME_YES=0
NO_RESTART=0
HEALTH_BODY=
HEALTH_LOGIN=
SERVICE_STOPPED=0
NEWEST=

log() { printf '· %s\n' "$*"; }
warn() { printf 'aviso: %s\n' "$*" >&2; }
die() { printf 'erro: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
need_value() { [[ -n "${2:-}" ]] || die "$1 exige um valor."; }

while (( $# > 0 )); do
  case "$1" in
    --latest) USE_LATEST=1; shift ;;
    --backup) need_value "$1" "${2:-}"; BACKUP_FILE=$2; shift 2 ;;
    --app-dir) need_value "$1" "${2:-}"; APP_DIR=$2; shift 2 ;;
    --env-file) need_value "$1" "${2:-}"; ENV_FILE=$2; shift 2 ;;
    --data-dir) need_value "$1" "${2:-}"; DATA_DIR=$2; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
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

restore_service() { # roda no fim, inclusive em falha
  if (( NO_RESTART == 1 )); then
    if (( SERVICE_STOPPED == 1 )); then
      warn "serviço parado e --no-restart: suba com 'sudo systemctl start $UNIT_NAME'."
    fi
    return 0
  fi
  if (( SERVICE_STOPPED == 1 )); then
    systemctl start "$UNIT_NAME" || warn "não consegui subir o serviço; veja: journalctl -u $UNIT_NAME -n 40 --no-pager"
  fi
}

wait_health() {
  local tries=${1:-40} i body
  local -a extra=()
  if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then extra=(-H "Tailscale-User-Login: $HEALTH_LOGIN"); fi
  for ((i = 1; i <= tries; i++)); do
    if body=$(curl -fsS --max-time 5 "${extra[@]+"${extra[@]}"}" "http://127.0.0.1:${PORT:-5173}/api/health" 2>/dev/null) \
      && [[ "$body" == *'"ok":true'* ]]; then
      HEALTH_BODY=$body
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# --- validação (nada muda nesta parte) ---------------------------------------
abs_dir "$APP_DIR"
abs_dir "$ENV_FILE"
abs_dir "$DATA_DIR"

if (( USE_LATEST == 1 && ${#BACKUP_FILE} > 0 )) || (( USE_LATEST == 0 && ${#BACKUP_FILE} == 0 )); then
  die "informe --latest OU --backup ARQUIVO."
fi

[[ -f "$APP_DIR/server.js" ]] || die "não achei server.js em $APP_DIR."
[[ -f "$APP_DIR/server/restore.js" ]] \
  || die "não achei server/restore.js em $APP_DIR (a restauração é feita pelo próprio servidor)."
require_disjoint "$APP_DIR" "$DATA_DIR" "o diretório de dados precisa ficar fora do checkout"
require_disjoint "$ENV_FILE" "$APP_DIR" "o arquivo de ambiente precisa ficar fora do checkout"

load_env_file "$ENV_FILE"
[[ "$(realpath -m -- "${GROOVE_DATA_DIR:-}")" == "$(realpath -m -- "$DATA_DIR")" ]] \
  || die "GROOVE_DATA_DIR ($GROOVE_DATA_DIR) e --data-dir ($DATA_DIR) precisam ser o mesmo caminho."
[[ "${GROOVE_HOST:-127.0.0.1}" == 127.0.0.1 ]] || die "GROOVE_HOST precisa ser 127.0.0.1."
command -v curl >/dev/null 2>&1 || die "preciso do curl instalado."

NODE_BIN=$(command -v node || true)
[[ -n "$NODE_BIN" ]] || die "não achei o node no PATH."

if [[ "${GROOVE_AUTH:-dev}" == tailscale ]]; then
  IFS=',' read -r -a logins <<< "${GROOVE_ALLOWED_LOGINS:-}"
  HEALTH_LOGIN=${logins[0]//[[:space:]]/}
else
  HEALTH_LOGIN=
fi

if (( USE_LATEST == 1 )); then
  [[ -d "$DATA_DIR/backups" ]] || die "não existe $DATA_DIR/backups (nenhum instantâneo diário para restaurar)."
  NEWEST=$(find "$DATA_DIR/backups" -maxdepth 1 -type f -name 'groovegoblin-*.ndjson.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
  [[ -n "$NEWEST" ]] || die "não achei nenhum instantâneo diário em $DATA_DIR/backups."
  log "instantâneo diário mais novo: $NEWEST"
else
  [[ -f "$BACKUP_FILE" ]] || die "arquivo de instantâneo não encontrado: $BACKUP_FILE"
  [[ -r "$BACKUP_FILE" ]] || die "não consigo ler o arquivo: $BACKUP_FILE"
  case "$BACKUP_FILE" in
    *.ndjson.gz) ;;
    *) warn "o arquivo não termina em .ndjson.gz ($BACKUP_FILE); a validação vai dizer se é um instantâneo deste servidor." ;;
  esac
  log "instantâneo escolhido: $BACKUP_FILE"
fi

[[ $(id -u) -eq 0 ]] || die "rode como root: sudo $0 $*"
command -v systemctl >/dev/null 2>&1 || die "este script precisa de systemd."

if (( ASSUME_YES == 0 )); then
  cat <<EOF

Isto vai SUBSTITUIR os documentos do diretório de dados:
  $DATA_DIR
pelos do instantâneo escolhido acima. O que existir aqui e não estiver no arquivo
vira lápide (deixa de aparecer no app). Os PDFs e áudios que já estão no disco não
são apagados. Antes de trocar qualquer coisa o servidor grava um instantâneo
pre-restore-<carimbo>.ndjson.gz na pasta backups/.

O serviço fica parado por alguns segundos. Digite SUBSTITUIR (tudo em maiúsculas):
EOF
  if ! read -r answer; then die "cancelado (entrada encerrada); nada foi alterado."; fi
  if [[ "$answer" != SUBSTITUIR ]]; then die "cancelado; nada foi alterado."; fi
fi

SERVICE_WAS_ACTIVE=0
if systemctl is-active --quiet "$UNIT_NAME"; then SERVICE_WAS_ACTIVE=1; fi
if (( SERVICE_WAS_ACTIVE == 1 )); then
  log "parando $UNIT_NAME..."
  systemctl stop "$UNIT_NAME"
  for _ in $(seq 1 20); do
    if ! systemctl is-active --quiet "$UNIT_NAME"; then break; fi
    sleep 0.5
  done
  if systemctl is-active --quiet "$UNIT_NAME"; then
    die "o serviço não parou; a restauração precisa do data dir livre."
  fi
  log "serviço parado."
fi
SERVICE_STOPPED=$SERVICE_WAS_ACTIVE
trap restore_service EXIT

log "validando o instantâneo (a seco, sem alterar nada)..."
if (( USE_LATEST == 1 )); then
  if ! "$NODE_BIN" "$APP_DIR/server/restore.js" --data-dir "$DATA_DIR" --latest; then
    die "o instantâneo não passou na validação; nada foi alterado (o serviço volta agora)."
  fi
else
  if ! "$NODE_BIN" "$APP_DIR/server/restore.js" --data-dir "$DATA_DIR" --backup "$BACKUP_FILE"; then
    die "o instantâneo não passou na validação; nada foi alterado (o serviço volta agora)."
  fi
fi

log "aplicando..."
if (( USE_LATEST == 1 )); then
  if "$NODE_BIN" "$APP_DIR/server/restore.js" --data-dir "$DATA_DIR" --latest --yes; then status=0; else status=$?; fi
else
  if "$NODE_BIN" "$APP_DIR/server/restore.js" --data-dir "$DATA_DIR" --backup "$BACKUP_FILE" --yes; then status=0; else status=$?; fi
fi

restore_service
SERVICE_STOPPED=0
trap - EXIT

if (( status != 0 )); then
  warn "a restauração falhou (código $status). O serviço foi reiniciado no estado anterior."
  warn "O instantâneo pre-restore, se chegou a ser gravado, está em $DATA_DIR/backups/."
  exit "$status"
fi

if wait_health 40; then
  log "health: $HEALTH_BODY"
  log "pronto: o app voltou no estado do instantâneo. Os clientes recebem a restauração sozinhos pelo /api/changes."
else
  warn "o /api/health não respondeu em 20 s. Veja: journalctl -u $UNIT_NAME -n 40 --no-pager"
  exit 1
fi
