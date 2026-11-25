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

# Default to local disk blobs only when S3/MinIO is not configured.
if [ -z "${JIANGE_S3_ENDPOINT:-}" ] && [ -z "${JIANGE_BLOB_DIR:-}" ]; then
	export JIANGE_BLOB_DIR="/data/blobs"
fi
if [ -n "${JIANGE_BLOB_DIR:-}" ]; then
	mkdir -p "$JIANGE_BLOB_DIR"
fi

export JIANGE_SECURE_COOKIES="${JIANGE_SECURE_COOKIES:-true}"
export JIANGE_AUTO_VERSION_EVERY="${JIANGE_AUTO_VERSION_EVERY:-0}"

exec /usr/local/bin/jiange
