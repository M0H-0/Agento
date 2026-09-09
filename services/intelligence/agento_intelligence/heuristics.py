"""Heuristic intent + safety classifiers for the MVP endpoints (MVP_PLAN.md).

Keyword/regex rules only — deliberately NO ML in the safety/intent path
today: a same-day model on the approval-adjacent surface is a liability, and
the MVP plan keeps this purely heuristic (an LLM fallback can layer on top
later without changing the wire shapes). The TS rule table in the tool
registry remains the approval floor; `/safety/classify` mirrors it as an
independent second opinion and never gates anything in the loop.
"""

import re

# --- Intent ---------------------------------------------------------------

# Ordered scoring rules: each pattern list contributes one hit per match.
INTENT_RULES: list[tuple[str, list[str]]] = [
    (
        "document_read",
        [r"\bread\b", r"\bsummar\w*", r"\bextract\b", r"\bwhat does\b", r"\bopen\b.*\b(doc|document|pdf|report)\b"],
    ),
    (
        "web_research",
        [r"\bfetch\b", r"\bwebsite\b", r"\bweb(page|site)?\b", r"https?://", r"\blook ?up\b", r"\bonline\b"],
    ),
    (
        "organize",
        [r"\borganiz\w*\b", r"\btidy\b", r"\bsort\b", r"\bmove\b", r"\brearrange\w*\b", r"\brename\b", r"\bclean ?up\b", r"\bgroup\b", r"\bfolder(s)?\b.*\bby\b"],
    ),
    (
        "file_operation",
        [r"\bcreate\b", r"\bwrite\b", r"\bmake\b", r"\bcopy\b", r"\bdelete\b", r"\bremove\b", r"\bedit\b", r"\bsave\b"],
    ),
]


def classify_intent(message: str) -> str:
    """Score keyword hits per category; ties across categories → multi_step,
    nothing matching → 'unsure'. Informational only — the loop never blocks."""
    lowered = message.lower()
    scores: dict[str, int] = {}
    for label, patterns in INTENT_RULES:
        scores[label] = sum(1 for pattern in patterns if re.search(pattern, lowered))
    hits = {label: count for label, count in scores.items() if count > 0}
    if len(hits) >= 2:
        return "multi_step"
    if len(hits) == 1:
        return next(iter(hits))
    return "unsure"


# --- Safety ---------------------------------------------------------------

READ_ONLY_TOOLS = {
    "list_dir", "read_file", "search_files", "read_document",
    "summarize_document", "web_fetch", "semantic_search", "ask_user", "emit_plan",
}
RISK_ONE_TOOLS = {"create_dir", "write_file"}
RISK_TWO_TOOLS = {"edit_file", "move_path", "copy_path"}

# Deny-list patterns scanned over every string arg: traversal escapes and
# system locations are destructive-intent signals regardless of tool.
DENY_PATTERNS: list[tuple[str, str]] = [
    (r"(\.\.[\\/])+|\.\.%2f", "path traversal attempt"),
    (r"[Cc]:[\\/]Windows|[\\/]Windows[\\/]|system32", "system directory"),
    (r"[Pp]rogram Files", "system directory"),
    (r"\.ssh|id_rsa|\.gnupg|\.aws|credentials", "protected credential location"),
]

# A path-heavy call touching more than this many paths is bulk-destructive
# territory (docs/05 rule table: bulk > 25 → 3).
BULK_PATH_THRESHOLD = 25


def _string_values(args: object) -> list[str]:
    if isinstance(args, str):
        return [args]
    if isinstance(args, dict):
        values: list[str] = []
        for value in args.values():
            values.extend(_string_values(value))
        return values
    if isinstance(args, list):
        values = []
        for value in args:
            values.extend(_string_values(value))
        return values
    return []


def classify_safety(tool: str, args: object) -> tuple[int, str]:
    """Independent rule-table mirror. Returns (risk 0-3, plain-language
    reason). Never consulted for approval decisions in the MVP — audit only."""
    joined = " ".join(_string_values(args))
    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, joined):
            return 3, f"Refused heuristic: {reason} in the arguments."
    if tool in READ_ONLY_TOOLS:
        return 0, "Read-only tool — nothing on disk changes."
    if tool in RISK_ONE_TOOLS:
        return 1, "Creates new content; reversible via the checkpoint."
    if tool in RISK_TWO_TOOLS:
        return 2, "Overwrites or relocates existing content; reversible via the checkpoint."
    if tool == "delete_path":
        return 3, "Deletes content — the checkpoint keeps it for undo, but the action is destructive."
    # Unknown tool: count path-like strings as a bulk signal, else assume safe.
    path_like = [value for value in _string_values(args) if re.search(r"\.[a-z0-9]{1,6}$|[\\/]", value)]
    if len(path_like) > BULK_PATH_THRESHOLD:
        return 3, f"Bulk operation touching {len(path_like)} paths."
    return 0, "Unknown tool with no destructive signals in the arguments."
