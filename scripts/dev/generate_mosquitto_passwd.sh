#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-scripts/dev/certs}"
mkdir -p "$OUT_DIR"
USER=${2:-iot_user}
PASS=${3:-securepassword}
PASSFILE="$OUT_DIR/mosquitto.passwd"

if command -v mosquitto_passwd >/dev/null 2>&1; then
  mosquitto_passwd -b -c "$PASSFILE" "$USER" "$PASS"
  echo "Wrote password file to $PASSFILE ($USER)"
else
  echo "Warning: mosquitto_passwd not found. Install mosquitto-clients to generate password file."
  echo "Fallback: writing cleartext file"
  echo "$USER:$PASS" > "$PASSFILE"
fi

echo "$PASSFILE"
