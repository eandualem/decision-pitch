import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from decision_pitch.server import PITCH, app, main


HERE = {"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8000"}


def test_the_page_and_three_js_are_served():
    client = TestClient(app())
    assert "Decision Pitch" in client.get("/").text
    assert client.get("/src/main.js").status_code == 200
    assert client.get("/vendor/three/three.module.js").status_code == 200


def test_the_socket_says_hello_then_streams_the_match():
    with TestClient(app()).websocket_connect("/ws", headers=HERE) as ws:
        hello = ws.receive_json()
        snapshot = ws.receive_json()
    assert hello["type"] == "hello" and hello["pitch"] == PITCH
    assert [len(team["players"]) for team in hello["teams"]] == [11, 11]
    assert [(team["manager"], team["assistants"]) for team in hello["teams"]] == [("Built-in", [])] * 2
    assert snapshot["type"] == "snapshot" and len(snapshot["players"]) == 22


@pytest.mark.parametrize(
    "headers",
    [
        HERE | {"origin": "http://example.com"},
        {"host": "example.com", "origin": "http://example.com"},
    ],
)
def test_only_this_page_on_this_computer_may_connect(headers):
    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(app()).websocket_connect("/ws", headers=headers):
            pass
    assert closed.value.code == 1008


@pytest.mark.parametrize("value", ["0", "-5", "inf", "nan"])
def test_the_half_length_must_be_a_positive_number_of_seconds(value):
    with pytest.raises(SystemExit) as stopped:
        main(["--headless", "--half-length", value])
    assert stopped.value.code == 2
