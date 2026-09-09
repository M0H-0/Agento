"""Pydantic models for the HTTP contracts (docs/05 §2).

These are the source of truth for the wire shapes; `src/main/ipc/` mirrors
them in Zod. Any change updates code + docs in the same commit (AGENTS.md rule 6).
"""

from typing import Literal

from pydantic import BaseModel


class Capabilities(BaseModel):
    docling: bool = False
    llm_classifiers: bool = False
    trained_models: bool = False


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    capabilities: Capabilities


# MVP cut (MVP_PLAN.md, 2026-09-10) — document + embed + heuristic endpoints.
# The M4 frozen contracts in docs/05 remain the full-build target; docs/05
# carries a dated "MVP cut" section for these shapes.


class ExtractRequest(BaseModel):
    path: str


class ExtractResponse(BaseModel):
    text: str
    truncated: bool = False


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
