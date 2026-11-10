#!/bin/sh
# Runtime wrapper used by the root boot shim (go run .) and startup-app.sh.
# No compile step: exec the prebuilt binary at bin/jiange.
# Startup messages go to stdout so the platform can capture them.
set -eu

log() { printf '%s\n' "$*"; }

hold() {
	log "holding the process so the container stays up"
	while true; do
		sleep 3600
	done
}

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BIN="$ROOT/bin/jiange"

if [ ! -x "$BIN" ]; then
	log "missing or not executable: $BIN"
	hold
fi

if [ -z "${DATABASE_URL:-}" ]; then
	if [ -z "${POSTGRES_HOST:-}" ] || [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
		log "DATABASE_URL is missing, and POSTGRES_HOST / POSTGRES_USER / POSTGRES_DB are incomplete."
		log "env var names present:"
		env | sed -e 's/=.*//' | sort
		hold
	fi
	enc_pass=$(printf '%s' "${POSTGRES_PASSWORD:-}" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's:/:%2F:g' -e 's/\?/%3F/g' -e 's/#/%23/g' -e 's/\[/%5B/g' -e 's/\]/%5D/g' -e 's/ /%20/g')
	DATABASE_URL="postgres://${POSTGRES_USER}:${enc_pass}@${POSTGRES_HOST}:${POSTGRES_PORT:-5432}/${POSTGRES_DB}"
	export DATABASE_URL
	log "built DATABASE_URL from POSTGRES_* (password not printed)"
fi

# JIANGE_ADDR wins. Otherwise 0.0.0.0:$PORT, or 0.0.0.0:8000.
# Bind all interfaces: the Swarm proxy likely connects from outside the container.
if [ -z "${JIANGE_ADDR:-}" ]; then
	if [ -n "${PORT:-}" ]; then
		case "$PORT" in
			:*) JIANGE_ADDR=0.0.0.0$PORT ;;
			*:*) JIANGE_ADDR=$PORT ;;
			*) JIANGE_ADDR=0.0.0.0:$PORT ;;
		esac
	else
		JIANGE_ADDR=0.0.0.0:8000
	fi
	export JIANGE_ADDR
fi
log "listening address: $JIANGE_ADDR"

export JIANGE_BLOB_DIR="${JIANGE_BLOB_DIR:-$ROOT/data/blobs}"
mkdir -p "$JIANGE_BLOB_DIR"

export JIANGE_SECURE_COOKIES="${JIANGE_SECURE_COOKIES:-true}"
export JIANGE_AUTO_VERSION_EVERY="${JIANGE_AUTO_VERSION_EVERY:-0}"

log "exec $BIN"
exec "$BIN"
