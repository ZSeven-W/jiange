#!/bin/sh
# Runtime wrapper used by startup-app.sh on Uppcoder Spark (and similar).
# DATABASE_URL is injected by the platform; POSTGRES_* are a fallback.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BIN="$ROOT/jiange"

if [ ! -x "$BIN" ]; then
  echo "missing binary: $BIN (run startup-app.sh to build it)" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -z "${POSTGRES_HOST:-}" ] || [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
    echo "DATABASE_URL is required, or POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB" >&2
    exit 1
  fi
  enc_pass=$(printf '%s' "${POSTGRES_PASSWORD:-}" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's:/:%2F:g' -e 's/\?/%3F/g' -e 's/#/%23/g' -e 's/\[/%5B/g' -e 's/\]/%5D/g' -e 's/ /%20/g')
  DATABASE_URL="postgres://${POSTGRES_USER}:${enc_pass}@${POSTGRES_HOST}:${POSTGRES_PORT:-5432}/${POSTGRES_DB}"
  export DATABASE_URL
fi

# JIANGE_ADDR wins. Otherwise use the platform PORT if set, else Uppcoder's
# documented convention: 127.0.0.1:8000 (Flask/FastAPI starters listen there).
if [ -z "${JIANGE_ADDR:-}" ]; then
  if [ -n "${PORT:-}" ]; then
    case "$PORT" in
      :*) JIANGE_ADDR=$PORT ;;
      *:*) JIANGE_ADDR=$PORT ;;
      *) JIANGE_ADDR=127.0.0.1:$PORT ;;
    esac
  else
    JIANGE_ADDR=127.0.0.1:8000
  fi
  export JIANGE_ADDR
fi

# Attachments live on disk; Uppcoder Spark has no object storage.
export JIANGE_BLOB_DIR="${JIANGE_BLOB_DIR:-$ROOT/data/blobs}"
mkdir -p "$JIANGE_BLOB_DIR"

# The public URL is HTTPS, so session cookies must be Secure.
export JIANGE_SECURE_COOKIES="${JIANGE_SECURE_COOKIES:-true}"

# Optional CPU saver on the 500 CPU-sec/day budget: skip automatic
# named version snapshots. Set to 30m to restore the default sweep.
export JIANGE_AUTO_VERSION_EVERY="${JIANGE_AUTO_VERSION_EVERY:-0}"

exec "$BIN"
