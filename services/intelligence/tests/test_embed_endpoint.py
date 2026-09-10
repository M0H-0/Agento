"""MVP /embed/embed endpoint tests over the real HTTP stack.

The real fastembed model (~90 MB download) is NOT pulled into the suite —
the model getter is monkeypatched with a deterministic fake, which keeps the
suite offline and fast. A real-model smoke runs by hand once (MVP step 5).
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn

from agento_intelligence import embed as embed_module
from agento_intelligence.main import app

TOKEN = os.environ["AGENTO_INTELLIGENCE_TOKEN"]
HOST = "127.0.0.1"
PORT = 7902
BASE_URL = f"http://{HOST}:{PORT}"


def _post(path: str, payload: dict, token: str | None = TOKEN) -> tuple[int, dict]:
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if token is not None:
        request.add_header("X-Agento-Token", token)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


@pytest.fixture(scope="module")
def server():
    uvicorn_server = uvicorn.Server(
        uvicorn.Config(app, host=HOST, port=PORT, log_level="warning")
    )
    thread = threading.Thread(target=uvicorn_server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10.0
    while not uvicorn_server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not uvicorn_server.started:
        uvicorn_server.should_exit = True
        thread.join(timeout=5.0)
        raise RuntimeError(f"uvicorn did not start listening on {BASE_URL} in 10s")
    yield uvicorn_server
    uvicorn_server.should_exit = True
    thread.join(timeout=5.0)


class FakeModel:
    """Deterministic stand-in: one dim per 'a'-'e' count, so vector contents
    are assertable and distinguishable."""

    def embed(self, texts):
        vectors = []
        for text in texts:
            lowered = text.lower()
            vector = [float(lowered.count(letter)) for letter in "abcde"]
            vectors.append(iter([__import__("numpy").array(vector)]).__next__())
        return iter(vectors)


@pytest.fixture(autouse=True)
def fake_model(monkeypatch):
    monkeypatch.setattr(embed_module, "_get_model", lambda: FakeModel())


def test_embed_two_texts(server):
    status, body = _post("/embed/embed", {"texts": ["ab", "b"]})
    assert status == 200
    assert body["vectors"] == [[1.0, 1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0]]


def test_embed_empty_list(server):
    status, body = _post("/embed/embed", {"texts": []})
    assert status == 200
    assert body["vectors"] == []


def test_embed_batch_too_large(server):
    status, body = _post(
        "/embed/embed", {"texts": ["a"] * (embed_module.MAX_BATCH_TEXTS + 1)}
    )
    assert status == 422
    assert "batch" in body["detail"].lower()


def test_embed_rejects_non_list(server):
    status, body = _post("/embed/embed", {"texts": "not-a-list"})
    assert status == 422


def test_embed_tokenless(server):
    status, body = _post("/embed/embed", {"texts": ["x"]}, token=None)
    assert status == 403
    assert body["detail"] == "Forbidden: a valid X-Agento-Token header is required."


def test_embed_empty_list_never_touches_model(monkeypatch):
    def exploding():
        raise AssertionError("_get_model must not run for an empty batch")

    monkeypatch.setattr(embed_module, "_get_model", exploding)
    assert embed_module.embed_texts([]) == []


def test_embed_model_load_failure_is_503(server, monkeypatch):
    def broken():
        raise embed_module.EmbeddingError("The embedding model could not be loaded.", 503)

    # _get_model is monkeypatched by the autouse fixture; the embed path calls
    # it only when the module-level model is unset — force the failure branch.
    monkeypatch.setattr(embed_module, "_get_model", broken)
    status, body = _post("/embed/embed", {"texts": ["x"]})
    assert status == 503
    assert "could not be" in body["detail"]
