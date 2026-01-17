# IoT Security & Telemetry — Threat Model and Requirements

## Summary
This document defines a minimal threat model, security goals, recommended authentication & encryption approaches, message schema constraints, and an operational checklist for telemetry collection via `scripts/iot/collector.py`.

### Threat model (short)
- Adversaries: opportunistic attackers on the public internet, misconfigured devices leaking credentials, or malicious devices inside an enterprise network.
- Assets to protect: sensor/telemetry integrity (no forged messages), source/device identity, confidentiality of sensitive telemetry fields, and availability of the ingestion service.
- Assumptions: devices may be low-power (SBCs, MCUs), TLS may impose CPU cost, and some environments require offline key provisioning or pre-shared tokens.

## Security goals
- Authenticate devices before accepting telemetry (prevent spoofing)
- Encrypt channel in transit (TLS for HTTP & MQTT) to avoid eavesdropping
- Enforce message schema and size limits to prevent abuse
- Rotate credentials and support revocation of compromised devices
- Provide minimal operational observability and alerting for anomalies

## Recommended approaches
### Authentication
- Short-term: use per-device API tokens (HTTP `Authorization: Bearer <token>`) or MQTT username/password per device.
- Long-term: support mTLS for devices able to hold private keys; verify CN/subject or use certificate-based identity.
- Registry: maintain a device registry (CSV or KV store) with device_id -> credential/metadata (policy, owner, allowed topics).

### Encryption
- Always enable TLS for HTTP endpoints (Flask) and require TLS for MQTT (broker). For development, use self-signed certs and document how to create them.
- Use modern TLS ciphers; disable old TLS versions (TLS 1.0/1.1).

### Message schema & validation
- Define a compact canonical JSON schema for telemetry messages, e.g.:
  {
    "device_id": "string",
    "ts": 167xxx,
    "metrics": {"temp_c": 21.2, "vbat": 3.7},
    "meta": {"firmware": "v1.2.3"}
  }
- Enforce size limits (e.g., 16KB) and reject oversized messages.
- Sanitize and redact PII fields at ingestion if necessary.

### Rate limiting & quotas
- Rate limit per-device ingestion to mitigate compromised devices and DoS.
- Implement simple token-bucket or leaky-bucket per device with configurable limits.

### Logging & observability
- Log authentication successes/failures, message rejects (schema, size), and anomalous rates.
- Export telemetry to a monitoring stack (Prometheus/Grafana) and configure alerts for high failure rates.

### Credential lifecycle
- Support issuing per-device tokens with expiration and revocation list.
- Provide scripts to rotate device tokens and update device registry.

## Operational checklist (deploy)
- Generate and provision TLS certs for servers; test with sample devices.
- Create device registry and provision a small sample set of devices.
- Enable logging and set up monitoring alerts (auth failure spike, message rate drop, disk usage).
- Implement backup & retention policy for staging storage of telemetry (e.g., keep 7 days by default), and purge old files.

## Developer notes & examples
- See `configs/iot/secure_example.yaml` for example configuration and `scripts/iot/collector.py` for how to enable TLS and token validation.
- For local testing, use the helper scripts:
  - `scripts/dev/generate_dev_certs.sh` — creates a dev CA and server cert/key (idempotent)
  - `scripts/dev/run_local_mqtt_tls_test.sh` — spins up a TLS-enabled Mosquitto container, runs the collector locally, publishes a TLS-protected message, and shows ingestion results.

- CI: `.github/workflows/iot_tls_integration.yml` runs the same flow in CI and verifies ingestion.

## Next steps
1. Add example secure config templates (included in `configs/iot/`).
2. Add `--require-auth` / `--tls-cert` flags to `scripts/iot/collector.py` and unit tests (done).
3. Add integration tests that run a TLS-enabled broker and the collector in Docker and verify authenticated ingestion (done).
4. Add tests for mTLS/client certs and username/password combos (planned).
5. Add monitoring metrics and alert docs.

