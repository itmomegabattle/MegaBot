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

BOT_STOPPED=false
restart_bot_on_error() {
  if [[ "${BOT_STOPPED}" == "true" ]]; then
    echo "Deployment failed while MegaBot was stopped; starting the built revision." >&2
    export APP_REVISION="$(git rev-parse HEAD)"
    pm2 startOrReload ecosystem.config.cjs --update-env || true
    pm2 save || true
  fi
}
trap restart_bot_on_error ERR

# Capture a verified recovery point while the current process is still alive.
# If it is writing at this exact moment, wait until the snapshot becomes ready.
PRE_STOP_BACKUP=""
for backup_attempt in {1..5}; do
  if npm run db:sheets:backup; then
    PRE_STOP_BACKUP="$(ls -t "${BACKUP_DIR}"/google-sheets-database-*.json | head -n 1)"
    break
  fi
  if [[ "${backup_attempt}" == "5" ]]; then
    echo "ERROR: Could not create a verified pre-stop database backup after 5 attempts." >&2
    exit 1
  fi
  sleep 3
done

# Stop the only database writer, then verify that shutdown did not interrupt a
# snapshot. If it did, recover the just-created copy before starting new code.
pm2 stop megabot
BOT_STOPPED=true
POST_STOP_BACKUP_OK=false
for backup_attempt in {1..5}; do
  if npm run db:sheets:backup; then
    POST_STOP_BACKUP_OK=true
    break
  fi
  sleep 3
done
if [[ "${POST_STOP_BACKUP_OK}" != "true" ]]; then
  echo "Database snapshot was interrupted during shutdown; restoring ${PRE_STOP_BACKUP}." >&2
  npm run db:sheets:restore -- "${PRE_STOP_BACKUP}" --confirm
fi

export APP_REVISION="$(git rev-parse HEAD)"
pm2 startOrReload ecosystem.config.cjs --update-env
BOT_STOPPED=false
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
