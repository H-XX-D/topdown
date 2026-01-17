#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-scripts/dev/certs}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# Create CA
if [[ ! -f ca.key || ! -f ca.crt ]]; then
  openssl genrsa -out ca.key 2048
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=Parametrix Dev CA" -out ca.crt
  echo "Created CA at $OUT_DIR/ca.crt"
else
  echo "CA already exists, skipping"
fi

# Create server key and cert signed by CA
if [[ ! -f server.key || ! -f server.crt ]]; then
  openssl genrsa -out server.key 2048
  openssl req -new -key server.key -subj "/CN=parametrix-mosquitto" -out server.csr
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -sha256
  echo "Created server cert and key at $OUT_DIR/server.crt, $OUT_DIR/server.key"
else
  echo "Server cert/key already exist, skipping"
fi

# Create mosquitto config that uses the certs
cat > mosquitto.conf <<'EOF'
listener 8883
cafile /mosquitto/config/ca.crt
certfile /mosquitto/config/server.crt
keyfile /mosquitto/config/server.key
allow_anonymous true

# optional logging
log_type all
EOF

echo "Wrote mosquitto.conf to $OUT_DIR/mosquitto.conf"

echo "Done. Use the files under $OUT_DIR to run a TLS-enabled Mosquitto broker."
