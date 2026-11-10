#!/bin/sh
# Uppcoder start hook. The FastAPI guide documents this file: if it is in the
# app folder, the platform uses it instead of the framework default
# (https://portal.uppcoder.com/guides/deploy-fastapi-postgresql).
# Go stacks have no published default, so this is the start entry point.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cd "$ROOT"

if [ ! -d server ]; then
  echo "startup-app.sh: expected the Jiange repo root (server/ is missing)" >&2
  exit 1
fi

# The embedded web UI is committed on this branch, so a plain Go build is enough.
CGO_ENABLED=0 go build -C server -o "$ROOT/jiange" ./cmd/jiange

exec "$ROOT/run.sh"
