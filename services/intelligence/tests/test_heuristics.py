"""MVP /intent/classify + /safety/classify endpoint tests: pure heuristic
functions (fast) plus the real HTTP stack (auth + wire shapes)."""

import json
import os
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn

from agento_intelligence.heuristics import classify_intent, classify_safety
from agento_intelligence.main import app

TOKEN = os.environ["AGENTO_INTELLIGENCE_TOKEN"]
HOST = "127.0.0.1"
PORT = 7903
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


class TestIntentHeuristic:
    def test_document_read(self):
        assert classify_intent("summarize report.pdf") == "document_read"
        assert classify_intent("what does invoice.pdf say") == "document_read"

    def test_web_research(self):
        assert classify_intent("fetch https://example.com and tell me the gist") == "web_research"

    def test_organize(self):
        assert classify_intent("organize my downloads folder by file type") == "organize"

    def test_multi_step_on_conflict(self):
        assert classify_intent("move all PDFs and then summarize them") == "multi_step"

    def test_unsure_fallback(self):
        assert classify_intent("hello there!") == "unsure"


class TestSafetyHeuristic:
    def test_read_only_tools_are_zero(self):
        for tool in ("read_file", "search_files", "semantic_search", "web_fetch"):
            assert classify_safety(tool, {"path": "x.md"})[0] == 0

    def test_create_is_one_overwrite_is_two_delete_is_three(self):
        assert classify_safety("write_file", {"path": "new.md"})[0] == 1
        assert classify_safety("edit_file", {"path": "old.md"})[0] == 2
        assert classify_safety("move_path", {"from": "a", "to": "b"})[0] == 2
        assert classify_safety("delete_path", {"path": "gone.md"})[0] == 3

    def test_traversal_deny_list_escalates(self):
        risk, reason = classify_safety("read_file", {"path": "../../etc/passwd"})
        assert risk == 3
        assert "traversal" in reason

    def test_system_directory_deny_list(self):
        risk, _ = classify_safety("write_file", {"path": "C:/Windows/system32/evil.txt"})
        assert risk == 3

    def test_protected_credential_location(self):
        risk, _ = classify_safety("read_file", {"path": ".ssh/id_rsa"})
        assert risk == 3

    def test_bulk_paths_escalate_unknown_tool(self):
        paths = {"paths": [f"file-{i}.txt" for i in range(30)]}
        risk, reason = classify_safety("mystery_tool", paths)
        assert risk == 3
        assert "30" in reason


class TestIntentEndpoint:
    def test_wire_shape(self, server):
        status, body = _post("/intent/classify", {"message": "organize my downloads"})
        assert status == 200
        assert body == {"intent": "organize", "confidence": "heuristic"}

    def test_tokenless(self, server):
        status, body = _post("/intent/classify", {"message": "x"}, token=None)
        assert status == 403


class TestSafetyEndpoint:
    def test_wire_shape(self, server):
        status, body = _post(
            "/safety/classify", {"tool": "edit_file", "args": {"path": "a.md"}}
        )
        assert status == 200
        assert body["risk"] == 2
        assert isinstance(body["reason"], str) and body["reason"]

    def test_tokenless(self, server):
        status, body = _post("/safety/classify", {"tool": "read_file"}, token=None)
        assert status == 403
