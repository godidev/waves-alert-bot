#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="waves-alerts-bot"

cd "$ROOT_DIR"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "Error: pm2 is not installed or not in PATH"
  exit 1
fi

echo "[deploy] Installing dependencies"
npm ci

if [[ "${RUN_CHECKS:-0}" == "1" ]]; then
  echo "[deploy] Running full CI checks"
  npm run check:ci
else
  echo "[deploy] Building project"
  npm run build
fi

echo "[deploy] Restarting PM2 app: $APP_NAME"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --only "$APP_NAME"
pm2 save

echo "[deploy] Current PM2 status"
pm2 status "$APP_NAME"

echo "[deploy] Recent logs"
pm2 logs "$APP_NAME" --lines 30 --nostream

echo "[deploy] Done"
