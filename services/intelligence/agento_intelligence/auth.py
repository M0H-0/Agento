"""Per-launch token authentication, enforced globally by the app (docs/05 §1)."""

import secrets

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN_HEADER = "X-Agento-Token"


class TokenAuthMiddleware:
    """Every HTTP request must carry the per-launch token; 403 otherwise.

    Added at app level, so every route inherits it. Fails closed: when no
    expected token is configured, all requests are refused.
    """

    def __init__(self, app: ASGIApp, expected_token: str | None) -> None:
        self.app = app
        self.expected_token = expected_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        if not self._token_matches(Headers(scope=scope).get(TOKEN_HEADER)):
            response = JSONResponse(
                {"detail": f"Forbidden: a valid {TOKEN_HEADER} header is required."},
                status_code=403,
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)

    def _token_matches(self, supplied: str | None) -> bool:
        if self.expected_token is None or supplied is None:
            return False
        return secrets.compare_digest(
            supplied.encode("utf-8"), self.expected_token.encode("utf-8")
        )
