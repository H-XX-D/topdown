#!/usr/bin/env bash
set -euo pipefail

CERT_DIR=${1:-scripts/dev/certs}
CONTAINER_NAME=mosq-tls-local

echo "Generating dev certs (if absent)"
bash scripts/dev/generate_dev_certs.sh "$CERT_DIR"

echo "Starting mosquitto TLS broker (container: $CONTAINER_NAME)"
docker run -d --name $CONTAINER_NAME -p 8883:8883 -v "$(pwd)/$CERT_DIR:/mosquitto/config" eclipse-mosquitto:2.0
sleep 3

echo "Starting collector (background)"
nohup python3 scripts/iot/collector.py --mode mqtt --broker localhost --port 8883 --topic test/telemetry --tls True --cafile $CERT_DIR/ca.crt > results/collector_local.log 2>&1 &
COL_PID=$!

echo "Publishing test message"
mosquitto_pub -h localhost -p 8883 --cafile $CERT_DIR/ca.crt -t test/telemetry -m '{"device_id":"iot-local-1","metrics":{"t":123}}'
sleep 2

if [ -f data/iot_staging.jsonl ]; then
  echo "Staging file contents:"
  tail -n 50 data/iot_staging.jsonl
else
  echo "No staging file found, check collector logs:"; tail -n 200 results/collector_local.log
fi

echo "Cleaning up"
docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true
kill $COL_PID || true

echo "Done"
