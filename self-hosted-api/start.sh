#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required. Install Node.js, then run this script again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js 24 or newer with npm, then run this script again." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 24 ]; then
  echo "Node.js 24 or newer is required; found Node.js $(node --version)." >&2
  exit 1
fi

if [ ! -f node_modules/nodemailer/package.json ]; then
  echo "Installing API dependencies..."
  npm install --no-audit --no-fund
fi

if [ ! -f .env ]; then
  echo "Creating a new local .env with generated license and session secrets..."
  node setup.mjs
  echo "Add SMTP, Shopier, and optional AI settings to .env when you need those features."
fi

exec node --env-file=.env server.mjs
