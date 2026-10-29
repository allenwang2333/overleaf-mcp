import base64
import hashlib
import re
from uuid import uuid4

from bridge import Bridge, BrowserError
from config import Settings

MAX_SOURCE_BYTES = 1024 * 1024


def project_id(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{24}", value):
        raise ValueError("project_id must be a 24-character lowercase hexadecimal ID")
    return value


def file_path(value: str) -> str:
    if (
        not value
        or len(value) > 1024
        or "\\" in value
        or any(ord(c) < 32 for c in value)
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError("Use a relative project path, such as main.tex or chapters/intro.tex")
    return value


def source_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in value or len(value.encode()) > MAX_SOURCE_BYTES:
        raise ValueError("Source must be UTF-8 text without NUL, at most 1 MiB")
    return value


def digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


class Overleaf:
    def __init__(self, settings: Settings, bridge: Bridge | None = None):
        self.settings = settings
        self.bridge = bridge or Bridge(settings)

    async def status(self):
        return await self.bridge.call("status")

    async def list_projects(self):
        return await self.bridge.call("list_projects")

    async def list_files(self, project: str):
        return await self.bridge.call("list_files", project_id=project_id(project))

    async def read_file(self, project: str, path: str):
        result = await self.bridge.call(
            "read_file", project_id=project_id(project), path=file_path(path)
        )
        result["sha256"] = digest(result["content"])
        return result

    async def write_file(self, project: str, path: str, content: str, expected_sha256: str):
        if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
            raise ValueError("expected_sha256 must be the hash returned by read_file")
        return await self.bridge.call(
            "write_file",
            project_id=project_id(project),
            path=file_path(path),
            content=source_text(content),
            expected_sha256=expected_sha256,
        )

    async def create_project(self, name: str):
        if not name.strip() or len(name) > 150 or any(ord(c) < 32 for c in name):
            raise ValueError(
                "Project name must contain 1–150 characters without control characters"
            )
        return await self.bridge.call("create_project", name=name.strip())

    async def create_file(self, project: str, path: str, content: str):
        return await self.bridge.call(
            "create_file",
            project_id=project_id(project),
            path=file_path(path),
            content=source_text(content),
        )

    async def compile_project(self, project: str):
        return await self.bridge.call("compile", project_id=project_id(project))

    async def download_pdf(self, project: str):
        project = project_id(project)
        result = await self.bridge.call("download_pdf", project_id=project)
        data = base64.b64decode(result["base64"], validate=True)
        if not data.startswith(b"%PDF-") or len(data) > 25 * 1024 * 1024:
            raise BrowserError("Download is not a valid PDF or exceeds 25 MiB")
        directory = self.settings.download_dir.resolve()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / f"{project}-{uuid4().hex}.pdf"
        with path.open("xb") as output:
            output.write(data)
        return {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
