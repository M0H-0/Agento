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
