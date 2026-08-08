#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/megabot"
BACKUP_DIR="${APP_DIR}/backups"
TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"

cd "${APP_DIR}"

mkdir -p "${BACKUP_DIR}"

if [[ -f .env ]]; then
  cp -p .env "${BACKUP_DIR}/env-${TIMESTAMP}"
  chmod 600 "${BACKUP_DIR}/env-${TIMESTAMP}"
  echo "Environment backup: ${BACKUP_DIR}/env-${TIMESTAMP}"
fi

if [[ ! -f .env ]]; then
  echo "ERROR: ${APP_DIR}/.env is missing." >&2
  exit 1
fi

npm ci
npm run lint
npm run build
for backup_attempt in {1..5}; do
  if npm run db:sheets:backup; then
    break
  fi
  if [[ "${backup_attempt}" == "5" ]]; then
    echo "ERROR: Google Sheets database backup failed after 5 attempts." >&2
    exit 1
  fi
  sleep 3
done

export APP_REVISION="$(git rev-parse HEAD)"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

for attempt in {1..20}; do
  if HEALTH_JSON="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/health)"; then
    echo "${HEALTH_JSON}" | grep -F "\"revision\":\"$(git rev-parse HEAD)\"" >/dev/null || {
      echo "ERROR: health endpoint reports a stale revision: ${HEALTH_JSON}" >&2
      exit 1
    }
    echo "MegaBot is healthy."
    pm2 status megabot
    exit 0
  fi
  sleep 1
done

echo "ERROR: MegaBot did not become healthy after restart." >&2
pm2 logs megabot --lines 100 --nostream
exit 1
