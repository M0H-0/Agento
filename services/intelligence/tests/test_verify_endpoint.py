"""MVP /completion/verify endpoint tests: postcondition heuristics over real
temp files plus the real HTTP stack (wire shape + auth)."""

import json
import os
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn

from agento_intelligence.main import app
from agento_intelligence.verify import verify_step

TOKEN = os.environ["AGENTO_INTELLIGENCE_TOKEN"]
HOST = "127.0.0.1"
PORT = 7904
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


class TestVerifyStepHeuristic:
    def test_existing_target_passes(self, tmp_path):
        target = tmp_path / "summary.md"
        target.write_text("content", encoding="utf-8")
        score, is_complete, missed = verify_step(
            "write a summary",
            "execution",
            [{"tool": "write_file", "input": {"path": str(target)}, "result": None}],
            {},
        )
        assert is_complete is True
        assert score == 1.0
        assert missed == []

    def test_missing_target_fails_with_plain_language(self, tmp_path):
        score, is_complete, missed = verify_step(
            "write a summary",
            "execution",
            [{"tool": "write_file", "input": {"path": str(tmp_path / "gone.md")}, "result": None}],
            {},
        )
        assert is_complete is False
        assert score == 0.0
        assert "gone.md" in missed[0]
        assert "supposed to exist" in missed[0]

    def test_delete_checks_absence(self, tmp_path):
        kept = tmp_path / "kept.txt"
        kept.write_text("x", encoding="utf-8")
        deleted = tmp_path / "deleted.txt"  # never created → correctly absent

        ok = verify_step(
            "delete the draft",
            "execution",
            [{"tool": "delete_path", "input": {"path": str(deleted)}, "result": None}],
            {},
        )
        assert ok[1] is True

        bad = verify_step(
            "delete the draft",
            "execution",
            [{"tool": "delete_path", "input": {"path": str(kept)}, "result": None}],
            {},
        )
        assert bad[1] is False
        assert "still there" in bad[2][0]

    def test_move_checks_destination_and_source(self, tmp_path):
        source = tmp_path / "a.md"
        source.write_text("x", encoding="utf-8")
        dest = tmp_path / "b.md"
        dest.write_text("x", encoding="utf-8")  # pretend the move happened
        score, is_complete, missed = verify_step(
            "rename a to b",
            "execution",
            [{"tool": "move_path", "input": {"from": str(source), "to": str(dest)}, "result": None}],
            {},
        )
        # dest exists (pass) but source is still in place (fail) → 0.5.
        assert is_complete is False
        assert score == 0.5
        assert "move away" in missed[0]

    def test_relative_paths_are_not_checked(self):
        score, is_complete, missed = verify_step(
            "anything", "execution",
            [{"tool": "write_file", "input": {"path": "relative.md"}, "result": None}], {},
        )
        # Only absolute (sandbox-resolved) paths are verifiable — a mutating
        # step with no checkable target is incomplete, never a false badge.
        assert is_complete is False
        assert score == 0.0
        assert missed

    def test_read_only_step_has_nothing_to_check(self):
        score, is_complete, missed = verify_step(
            "read the report", "execution",
            [{"tool": "read_file", "input": {"path": "C:/nowhere/x.md"}, "result": None}], {},
        )
        assert (score, is_complete, missed) == (1.0, True, [])


class TestVerifyEndpoint:
    def test_wire_shape_matches_ts_client(self, server, tmp_path):
        target = tmp_path / "out.md"
        target.write_text("x", encoding="utf-8")
        status, body = _post(
            "/completion/verify",
            {
                "instruction": "write the summary",
                "step_description": "execution",
                "actions": [{"tool": "write_file", "input": {"path": str(target)}, "result": "done"}],
                "before_after": {"before": None, "after": None},
            },
        )
        assert status == 200
        assert body == {"completion_score": 1.0, "is_complete": True, "missed_segments": []}

    def test_empty_actions_are_complete(self, server):
        status, body = _post("/completion/verify", {"instruction": "hi", "actions": []})
        assert status == 200
        assert body["is_complete"] is True

    def test_tokenless(self, server):
        status, body = _post("/completion/verify", {"instruction": "x"}, token=None)
        assert status == 403
