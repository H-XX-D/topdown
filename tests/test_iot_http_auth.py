import json
from pathlib import Path

import pytest

from scripts.iot import collector as coll


def test_http_auth_rejects_and_accepts(tmp_path, monkeypatch):
    staging = tmp_path / "staging.jsonl"
    # monkeypatch global STAGING to use temp file
    monkeypatch.setattr(coll, "STAGING", str(staging))

    # create a minimal DummyFlask to use when flask is not installed
    class DummyClient:
        def __init__(self, app):
            self.app = app

        def post(self, path, json=None, headers=None):
            # set a faux request object on the collector module
            class Req:
                def __init__(self, _json, _headers):
                    self._json = _json
                    self.headers = _headers or {}

                def get_json(self, force=False):
                    return self._json

            monkeypatch.setattr(coll, "request", Req(json, headers or {}), raising=False)
            handler = self.app._routes.get((path, "POST"))
            assert handler is not None
            result = handler()
            # result may be (body, status) or body
            if isinstance(result, tuple):
                body, status = result
            else:
                body, status = result, 200
            class Resp:
                def __init__(self, body, status):
                    self.json = body
                    self.status_code = status
            return Resp(body, status)

    class DummyFlask:
        def __init__(self):
            self._routes = {}

        def route(self, path, methods=None):
            def decorator(f):
                for m in (methods or []):
                    self._routes[(path, m)] = f
                return f
            return decorator

        def test_client(self):
            return DummyClient(self)

    # monkeypatch Flask if real Flask not available
    monkeypatch.setattr(coll, "Flask", DummyFlask)

    token_map = {"devtoken-ABC123": "device-001"}
    app = coll.create_app(require_auth=True, token_map=token_map)
    client = app.test_client()

    r = client.post("/ingest", json={"metrics": {"t": 1}})
    assert r.status_code == 401

    r = client.post("/ingest", headers={"Authorization": "Bearer devtoken-ABC123"}, json={"metrics": {"t": 1}})
    assert r.status_code == 200

    # verify staging file contains device_id set by token_map
    assert staging.exists()
    lines = staging.read_text().strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec.get("device_id") == "device-001"


def test_http_no_auth_ok_when_disabled(tmp_path, monkeypatch):
    staging = tmp_path / "staging2.jsonl"
    monkeypatch.setattr(coll, "STAGING", str(staging))

    app = coll.create_app(require_auth=False, token_map=None)
    client = app.test_client()

    r = client.post("/ingest", json={"device_id": "raw-device", "metrics": {"t": 2}})
    assert r.status_code == 200
    rec = json.loads(staging.read_text())
    assert "raw-device" in staging.read_text()
