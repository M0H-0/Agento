"""Heuristic postcondition verifier for `/completion/verify` (MVP_PLAN.md).

The simplest honest version: re-read each mutating action's target on disk
and confirm the expected postcondition (exists / gone). Only checks actually
performed count toward the score; read-only steps carry no filesystem
postcondition. No semantic verification — that is M4.3's LLM judge, and the
shipped TS client (app/src/main/agent/verify.ts) treats any non-200 or parse
failure as an honest skip, never a faked badge.
"""

from pathlib import Path

CREATE_TOOLS = {"create_dir"}
WRITE_TOOLS = {"write_file", "edit_file"}
COPY_TOOLS = {"copy_path"}
MOVE_TOOLS = {"move_path"}
DELETE_TOOLS = {"delete_path"}


def _path_like(value: object) -> bool:
    # Action inputs carry sandbox-resolved ABSOLUTE paths (the registry
    # resolves pathFields before execute), so absolute-path shapes only.
    return (
        isinstance(value, str)
        and len(value) > 2
        and (":" in value or value.startswith("/") or "\\" in value)
    )


def _exists(path: str) -> bool:
    try:
        return Path(path).exists()
    except OSError:
        return False


def verify_step(
    instruction: str,
    step_description: str,
    actions: list,
    before_after: dict,
) -> tuple[float, bool, list[str]]:
    """Returns (completion_score, is_complete, missed_segments)."""
    checked = 0
    missed: list[str] = []

    for action in actions or []:
        if not isinstance(action, dict):
            continue
        tool = action.get("tool")
        action_input = action.get("input")
        if not isinstance(action_input, dict):
            continue
        primary = action_input.get("path")
        dest = action_input.get("to") or action_input.get("dest_path")
        source = action_input.get("from") or action_input.get("source_path")

        if tool in DELETE_TOOLS:
            if not _path_like(primary):
                continue
            checked += 1
            if _exists(primary):
                missed.append(
                    f'"{Path(primary).name}" was supposed to be deleted but is still there.'
                )
            continue

        if tool in CREATE_TOOLS | WRITE_TOOLS | COPY_TOOLS | MOVE_TOOLS:
            target = dest if tool in COPY_TOOLS | MOVE_TOOLS and _path_like(dest) else primary
            if not _path_like(target):
                continue
            checked += 1
            if not _exists(target):
                missed.append(
                    f'"{Path(target).name}" was supposed to exist after this step but does not.'
                )
                continue
            if tool in MOVE_TOOLS and _path_like(source) and source != target:
                checked += 1
                if _exists(source):
                    missed.append(
                        f'"{Path(source).name}" was supposed to move away but is still in place.'
                    )
            continue

        # Read-only / unknown tools carry no filesystem postcondition to check.

    if checked == 0:
        # Honest no-check: a mutating action with no verifiable target must
        # never earn a verified badge. The TS adapter skips pure read-only
        # runs before calling, so reaching here with actions means the paths
        # were unresolvable — report incomplete, not success.
        mutating = {
            "create_dir",
            "write_file",
            "edit_file",
            "move_path",
            "copy_path",
            "delete_path",
        }
        has_mutating = any(
            isinstance(a, dict) and a.get("tool") in mutating for a in (actions or [])
        )
        if has_mutating:
            return 0.0, False, ["Nothing verifiable was found for the mutating step."]
        return 1.0, True, []
    score = round((checked - len(missed)) / checked, 3)
    return score, len(missed) == 0, missed
