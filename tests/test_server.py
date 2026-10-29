from unittest.mock import AsyncMock

from server import create_server
from service import Overleaf


async def test_tool_contract_and_annotations():
    server = create_server(service=AsyncMock(spec=Overleaf))
    tools = {tool.name: tool for tool in await server.list_tools()}
    assert set(tools) == {
        "session_status", "list_projects", "list_files", "read_file", "write_file",
        "create_project", "create_file", "compile_project", "download_pdf",
    }
    assert tools["read_file"].annotations.readOnlyHint is True
    assert tools["write_file"].annotations.destructiveHint is True
    assert "expected_sha256" in tools["write_file"].inputSchema["required"]
    assert tools["create_project"].annotations.idempotentHint is False


async def test_call_routes_to_service():
    service = AsyncMock(spec=Overleaf)
    service.list_projects.return_value = {"projects": []}
    server = create_server(service=service)
    await server.call_tool("list_projects", {})
    service.list_projects.assert_awaited_once()


async def test_invalid_id_never_reaches_service():
    service = AsyncMock(spec=Overleaf)
    server = create_server(service=service)
    try:
        await server.call_tool("read_file", {"project_id": "../bad", "path": "main.tex"})
    except Exception:
        pass
    service.read_file.assert_not_called()
