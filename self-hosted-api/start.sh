#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "Run: node setup.mjs" >&2
  exit 1
fi
exec node --env-file=.env server.mjs
