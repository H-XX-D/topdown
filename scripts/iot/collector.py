"""
Lightweight IoT collector prototype.
Supports:
- HTTP endpoint (/ingest) for POSTing JSON payloads
- MQTT client subscription to a telemetry topic

Writes normalized entries to `data/iot_staging.jsonl` for downstream processing.

Run examples:
- HTTP: python scripts/iot/collector.py --mode http --port 8000
- MQTT: python scripts/iot/collector.py --mode mqtt --broker test.mosquitto.org --topic test/telemetry

This is a prototype — in production move to proper async servers (uvicorn/fastapi) and robust MQTT libraries & config.
"""

import argparse
import json
import logging
import os
import signal
import sys
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
STAGING = "data/iot_staging.jsonl"


def ensure_data_dir():
    os.makedirs(os.path.dirname(STAGING), exist_ok=True)


def write_staging(record: dict):
    ensure_data_dir()
    with open(STAGING, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# HTTP mode (simple Flask app)
try:
    from flask import Flask, request, jsonify
except Exception:
    Flask = None


def create_app(require_auth: bool = False, token_map: dict = None):
    """Return a Flask-like app configured with optional auth requirements.

    token_map: mapping from token -> device_id (if token maps to device id)
    """
    # If Flask isn't available (test environments), provide a minimal local app
    local_jsonify = None
    if Flask is None:
        class MinimalApp:
            def __init__(self):
                self._routes = {}

            def route(self, path, methods=None):
                def decorator(f):
                    for m in (methods or []):
                        self._routes[(path, m)] = f
                    return f
                return decorator

            def test_client(self):
                # a thin wrapper used by tests
                class DummyClient:
                    def __init__(self, app):
                        self.app = app

                    def post(self, path, json=None, headers=None):
                        class Req:
                            def __init__(self, _json, _headers):
                                self._json = _json
                                self.headers = _headers or {}

                            def get_json(self, force=False):
                                return self._json

                        # attach request to module-level name so handlers can read it
                        global request
                        request = Req(json, headers or {})
                        handler = self.app._routes.get((path, "POST"))
                        if not handler:
                            raise RuntimeError("No handler for %s POST" % path)
                        result = handler()
                        # normalize response to an object with .json and .status_code like Flask's response
                        if isinstance(result, tuple):
                            body, status = result
                        else:
                            body, status = result, 200
                        class Resp:
                            def __init__(self, body, status):
                                self.json = body
                                self.status_code = status
                        return Resp(body, status)

                return DummyClient(self)

        app = MinimalApp()
        def jsonify(d):
            return d
        local_jsonify = jsonify
    else:
        try:
            app = Flask(__name__)
        except TypeError:
            # some test fakes may not accept args
            app = Flask()

    def _validate_token(auth_header: str):
        if not auth_header:
            return False, None
        if not auth_header.lower().startswith("bearer "):
            return False, None
        token = auth_header.split(None, 1)[1].strip()
        if token_map is None:
            return False, None
        device_id = token_map.get(token)
        return (True, device_id) if device_id else (False, None)

    def _json_response(d, status=200):
        # use local_jsonify for test environments or Flask's jsonify when available
        if local_jsonify is not None:
            return local_jsonify(d), status
        try:
            from flask import jsonify
            return jsonify(d), status
        except Exception:
            # if flask isn't importable in the environment (e.g., minimal test fakes),
            # fall back to returning plain dict and status
            return d, status

    @app.route("/ingest", methods=["POST"])
    def ingest():
        if require_auth:
            auth = request.headers.get("Authorization")
            ok, device_id = _validate_token(auth)
            if not ok:
                return _json_response({"error": "unauthorized"}, 401)
        payload = request.get_json(force=True)
        if not payload:
            return _json_response({"error": "invalid json"}, 400)
        entry = normalize(payload, protocol="http")
        # if token provided maps to device_id, set/override device_id
        if require_auth:
            # attempt to re-validate to get device_id
            auth = request.headers.get("Authorization")
            ok, device_id = _validate_token(auth)
            if ok and device_id:
                entry["device_id"] = device_id
        write_staging(entry)
        return _json_response({"status": "ok"}, 200)

    return app


def run_http(port: int = 8000, require_auth: bool = False, token_map: dict = None, tls_cert: str = None, tls_key: str = None):
    if Flask is None:
        logging.error("Flask not installed. Install Flask or run MQTT mode.")
        return
    app = create_app(require_auth=require_auth, token_map=token_map)

    logging.info("Starting HTTP collector on port %d (require_auth=%s)", port, require_auth)
    ssl_context = None
    if tls_cert and tls_key:
        ssl_context = (tls_cert, tls_key)
        logging.info("Using TLS cert=%s key=%s", tls_cert, tls_key)

    app.run(host="0.0.0.0", port=port, ssl_context=ssl_context)


# MQTT mode (optional dependency on paho-mqtt)
try:
    import paho.mqtt.client as mqtt
except Exception:
    mqtt = None


def on_mqtt_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception:
        logging.exception("Failed to decode MQTT payload")
        return
    entry = normalize(payload, protocol="mqtt", topic=msg.topic)
    write_staging(entry)


def run_mqtt(broker: str, topic: str = "telemetry/#", port: int = 1883, tls: bool = False, cafile: str = None, username: str = None, password: str = None):
    if mqtt is None:
        logging.error("paho-mqtt not installed. Install paho-mqtt or run HTTP mode.")
        return
    client = mqtt.Client()
    if username and password:
        client.username_pw_set(username=username, password=password)
        logging.info("Using MQTT username authentication for user %s", username)
    if tls:
        logging.info("Enabling MQTT TLS (cafile=%s)", cafile)
        client.tls_set(ca_certs=cafile)
    client.on_message = on_mqtt_message
    logging.info("Connecting to MQTT broker %s:%d", broker, port)
    client.connect(broker, port)
    client.subscribe(topic)
    client.loop_start()

    def handler(signum, frame):
        logging.info("Shutting down MQTT client")
        client.loop_stop()
        client.disconnect()
        sys.exit(0)

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)
    # keep process alive
    while True:
        signal.pause()


# Normalization helper
def normalize(payload: dict, protocol: str = "http", topic: str = None) -> dict:
    # Basic normalization and schema enforcement for prototype
    out = {}
    out["device_id"] = payload.get("device_id") or payload.get("id") or payload.get("device") or "unknown"
    out["timestamp"] = payload.get("timestamp") or datetime.utcnow().isoformat() + "Z"
    out["metrics"] = payload.get("metrics") or payload.get("payload") or {}
    out["metadata"] = payload.get("metadata") or {}
    out["metadata"]["protocol"] = protocol
    if topic:
        out["metadata"]["topic"] = topic
    return out


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["http", "mqtt"], default="http")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--broker", default="test.mosquitto.org")
    p.add_argument("--topic", default="test/telemetry")
    args = p.parse_args()

    if args.mode == "http":
        run_http(port=args.port)
    else:
        run_mqtt(broker=args.broker, topic=args.topic)
