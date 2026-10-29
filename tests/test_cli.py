from unittest.mock import AsyncMock

import pytest

import cli
from bridge import BrowserError
from config import Settings


@pytest.mark.parametrize(
    "status, message",
    [
        ({"authenticated": False, "message": "Login check interrupted by page navigation."},
         "Login check interrupted by page navigation"),
        ({"authenticated": False}, "Login was not confirmed"),
    ],
)
async def test_login_preserves_failure_reason_and_closes_browser(monkeypatch, status, message):
    bridge = AsyncMock()
    bridge.call.side_effect = [None, status]
    monkeypatch.setattr(cli, "Bridge", lambda settings: bridge)
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    with pytest.raises(BrowserError, match=message):
        await cli.login(Settings())
    bridge.close.assert_awaited_once()


async def test_login_confirms_saved_session(monkeypatch, capsys):
    bridge = AsyncMock()
    bridge.call.side_effect = [None, {"authenticated": True}]
    monkeypatch.setattr(cli, "Bridge", lambda settings: bridge)
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    await cli.login(Settings())
    assert "Login saved" in capsys.readouterr().out
    bridge.close.assert_awaited_once()
