import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from decision_pitch.server import PITCH, app


HERE = {"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8000"}


def test_the_page_and_three_js_are_served():
    client = TestClient(app())
    assert "Decision Pitch" in client.get("/").text
    assert client.get("/src/main.js").status_code == 200
    assert client.get("/vendor/three/three.module.js").status_code == 200


def test_the_socket_says_hello_with_the_pitch():
    with TestClient(app()).websocket_connect("/ws", headers=HERE) as ws:
        message = ws.receive_json()
    assert message["type"] == "hello"
    assert message["pitch"] == PITCH


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
