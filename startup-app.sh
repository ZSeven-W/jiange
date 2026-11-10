#!/bin/sh
# Uppcoder start hook (documented for FastAPI; used if the platform looks for it).
# No compile: exec the prebuilt binary via run.sh.
# https://portal.uppcoder.com/guides/deploy-fastapi-postgresql
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cd "$ROOT"
exec "$ROOT/run.sh"
