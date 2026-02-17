#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
DO_PULL="${DO_PULL:-1}"

echo "==> Deploying PoolOrbit backend from: ${APP_DIR}"
cd "${APP_DIR}"

if [[ "${DO_PULL}" == "1" ]]; then
  echo "==> Pulling latest code from branch: ${BRANCH}"
  git fetch origin
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
else
  echo "==> Skipping git pull (DO_PULL=${DO_PULL})"
fi

echo "==> Installing dependencies"
npm ci

echo "==> Running migrations"
npm run migrate

echo "==> Starting/restarting PM2 processes"
pm2 start ecosystem.config.cjs --update-env

echo "==> Saving PM2 process list"
pm2 save

echo "==> Done"
echo "PM2 status:"
pm2 status
