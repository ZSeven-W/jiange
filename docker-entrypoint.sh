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

# Persist an auto-generated 32-byte key on first boot so single-node Docker
# setups can save encrypted AI / SSO / Webhook secrets out of the box.
if [ -z "${JIANGE_SECRET_KEY:-}" ]; then
	key_file="${JIANGE_SECRET_KEY_FILE:-/data/.secret-key}"
	mkdir -p "$(dirname "$key_file")"
	if [ ! -s "$key_file" ]; then
		tmp_key="${key_file}.tmp.$$"
		(
			umask 077
			od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$tmp_key"
		)
		chmod 600 "$tmp_key"
		mv -f "$tmp_key" "$key_file"
	fi
	JIANGE_SECRET_KEY="$(tr -d ' \r\n' < "$key_file")"
	export JIANGE_SECRET_KEY
	echo "[jiange] JIANGE_SECRET_KEY not set; using persistent key at ${key_file} (set JIANGE_SECRET_KEY explicitly in multi-replica production)" >&2
fi

export JIANGE_SECURE_COOKIES="${JIANGE_SECURE_COOKIES:-true}"
export JIANGE_AUTO_VERSION_EVERY="${JIANGE_AUTO_VERSION_EVERY:-0}"

exec /usr/local/bin/jiange
