from unittest.mock import AsyncMock

import pytest

from bridge import BrowserError
from config import Settings
from service import Overleaf, digest, file_path, project_id, source_text

PROJECT = "a" * 24


@pytest.fixture
def service(tmp_path):
    bridge = AsyncMock()
    return Overleaf(Settings(download_dir=tmp_path / "downloads"), bridge)


@pytest.mark.parametrize("value", ["", "../x", "/x", "a//b", "a/./b", "a\\b", "a\x00b", "a/../b"])
def test_reject_bad_paths(value):
    with pytest.raises(ValueError):
        file_path(value)


@pytest.mark.parametrize(
    "value", ["", "x" * 24, PROJECT + "/", "https://www.overleaf.com/project/" + PROJECT]
)
def test_reject_bad_ids(value):
    with pytest.raises(ValueError):
        project_id(value)


def test_source_normalization_and_limit():
    assert source_text("a\r\nb\r") == "a\nb\n"
    for value in ["\x00", "é" * (512 * 1024 + 1)]:
        with pytest.raises(ValueError):
            source_text(value)


@pytest.mark.parametrize(
    "value", ["http://example.com", "https://user:pass@overleaf.com",
              "https://overleaf.com/a", "https://overleaf.com?x=1"]
)
def test_reject_bad_origins(value):
    with pytest.raises(ValueError):
        Settings(base_url=value)


async def test_read_hashes_source(service):
    service.bridge.call.return_value = {"content": "hello π"}
    assert (await service.read_file(PROJECT, "main.tex"))["sha256"] == digest("hello π")


async def test_write_validation_precedes_browser(service):
    with pytest.raises(ValueError):
        await service.write_file(PROJECT, "main.tex", "x", "bad")
    service.bridge.call.assert_not_called()


async def test_write_normalizes_line_endings(service):
    await service.write_file(PROJECT, "main.tex", "a\r\n", digest(""))
    service.bridge.call.assert_awaited_once_with(
        "write_file", project_id=PROJECT, path="main.tex", content="a\n", expected_sha256=digest("")
    )


async def test_download_is_local_unique_and_validated(service):
    service.bridge.call.return_value = {"base64": "JVBERi0xLjcK"}
    first = await service.download_pdf(PROJECT)
    second = await service.download_pdf(PROJECT)
    assert first["path"] != second["path"]
    assert first["bytes"] == 9
    assert first["sha256"] == second["sha256"]
    assert len(list(service.settings.download_dir.glob("*.pdf"))) == 2


async def test_reject_non_pdf(service):
    service.bridge.call.return_value = {"base64": "PGh0bWw+"}
    with pytest.raises(BrowserError, match="valid PDF"):
        await service.download_pdf(PROJECT)
    assert not service.settings.download_dir.exists()


@pytest.mark.parametrize("name", ["", "  ", "x" * 151, "bad\nname"])
async def test_reject_bad_project_names(service, name):
    with pytest.raises(ValueError):
        await service.create_project(name)
    service.bridge.call.assert_not_called()
