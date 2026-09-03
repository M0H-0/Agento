"""M0.7 smoke: /health + token auth over the real HTTP stack (docs/05 §1–2).

Boots the actual ASGI app under uvicorn in-process (background thread, port
7899 — 7891 may be held by a dev sidecar) and speaks to it over loopback with
stdlib urllib only. No FastAPI TestClient: it needs httpx, which is not in
STACK.md — that decision is deferred to M4.1, where the real contract tests
begin (docs/07 §2).
"""

import json
import os
import threading
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import uvicorn

from agento_intelligence.main import app

# conftest.py set this before this module was imported, so the EXPECTED_TOKEN
# captured at app-import time matches it.
TOKEN = os.environ["AGENTO_INTELLIGENCE_TOKEN"]
HOST = "127.0.0.1"
PORT = 7899
BASE_URL = f"http://{HOST}:{PORT}"


def _pyproject_version() -> str:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with pyproject.open("rb") as f:
        return str(tomllib.load(f)["project"]["version"])


def _get(path: str, token: str | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(BASE_URL + path)
    if token is not None:
        request.add_header("X-Agento-Token", token)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
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


def test_health_with_valid_token(server):
    status, body = _get("/health", token=TOKEN)
    assert status == 200
    assert body["status"] == "ok"
    assert body["version"] == _pyproject_version()
    assert body["capabilities"] == {
        "docling": False,
        "llm_classifiers": False,
        "trained_models": False,
    }


def test_health_tokenless(server):
    status, body = _get("/health")
    assert status == 403
    assert body["detail"] == "Forbidden: a valid X-Agento-Token header is required."


def test_health_wrong_token(server):
    status, body = _get("/health", token="definitely-wrong-token")
    assert status == 403
    assert body["detail"] == "Forbidden: a valid X-Agento-Token header is required."
