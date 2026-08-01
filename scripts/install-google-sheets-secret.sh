#!/usr/bin/env bash
set -euo pipefail

SOURCE_FILE="${1:-}"
TARGET_DIR="/opt/megabot/secrets"
TARGET_FILE="$TARGET_DIR/google-service-account.json"

if [[ -z "$SOURCE_FILE" || ! -f "$SOURCE_FILE" ]]; then
  echo "Usage: sudo bash scripts/install-google-sheets-secret.sh /path/to/uploaded-key.json" >&2
  exit 1
fi

install -d -m 700 "$TARGET_DIR"
install -m 600 "$SOURCE_FILE" "$TARGET_FILE"
echo "Installed Google service account key at $TARGET_FILE"
echo "Add GOOGLE_SERVICE_ACCOUNT_FILE=$TARGET_FILE to /opt/megabot/.env"
