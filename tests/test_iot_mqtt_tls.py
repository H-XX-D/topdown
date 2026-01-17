import types
import signal
import pytest

from scripts.iot import collector as coll


class FakeClient:
    def __init__(self):
        self.tls_set_called = False
        self.tls_args = None
        self.username = None
        self.password = None
        self.connected = False
        self.subscribed = None
        self.loop_started = False

    def username_pw_set(self, username=None, password=None):
        self.username = username
        self.password = password

    def tls_set(self, ca_certs=None):
        self.tls_set_called = True
        self.tls_args = ca_certs

    def on_message(self, *args, **kwargs):
        pass

    def connect(self, broker, port):
        self.connected = (broker, port)

    def subscribe(self, topic):
        self.subscribed = topic

    def loop_start(self):
        self.loop_started = True

    def loop_stop(self):
        self.loop_started = False

    def disconnect(self):
        self.connected = False


def test_run_mqtt_sets_tls_and_credentials(monkeypatch):
    fake = FakeClient()

    # monkeypatch mqtt.Client to return our fake
    fake_module = types.SimpleNamespace(Client=lambda: fake)
    monkeypatch.setattr(coll, "mqtt", fake_module)

    # monkeypatch signal.pause to raise SystemExit so run_mqtt exits quickly
    monkeypatch.setattr(signal, "pause", lambda: (_ for _ in ()).throw(SystemExit()))

    with pytest.raises(SystemExit):
        coll.run_mqtt(broker="test-broker.local", topic="t/#", port=8883, tls=True, cafile="/path/to/ca.crt", username="u", password="p")

    # validate that tls and username/password were set on fake client
    assert fake.tls_set_called is True
    assert fake.tls_args == "/path/to/ca.crt"
    assert fake.username == "u"
    assert fake.password == "p"
    assert fake.connected == ("test-broker.local", 8883)
    assert fake.subscribed == "t/#"
