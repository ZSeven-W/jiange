#!/bin/sh
# Map the platform PORT (Render default is 10000) onto JIANGE_ADDR.
set -eu

if [ -z "${JIANGE_ADDR:-}" ]; then
	port="${PORT:-8080}"
	case "$port" in
		:*) JIANGE_ADDR=0.0.0.0$port ;;
		*:*) JIANGE_ADDR=$port ;;
		*) JIANGE_ADDR=0.0.0.0:$port ;;
	esac
	export JIANGE_ADDR
fi

export JIANGE_BLOB_DIR="${JIANGE_BLOB_DIR:-/data/blobs}"
export JIANGE_SECURE_COOKIES="${JIANGE_SECURE_COOKIES:-true}"
export JIANGE_AUTO_VERSION_EVERY="${JIANGE_AUTO_VERSION_EVERY:-0}"
mkdir -p "$JIANGE_BLOB_DIR"

exec /usr/local/bin/jiange
