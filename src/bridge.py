"""Serialized, private JSON-lines protocol. Only MCP uses Python's stdout."""

import asyncio
import json
from pathlib import Path

from config import Settings

WORKER_DIR = Path(__file__).parent / "puppeteer"
WORKER_PATH = WORKER_DIR / "worker.mjs"


class BrowserError(RuntimeError):
    pass


class Bridge:
    def __init__(self, settings: Settings, worker_path: Path = WORKER_PATH):
        self.settings = settings
        self.worker_path = worker_path
        self.process: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()

    async def _start(self):
        self.settings.profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.process = await asyncio.create_subprocess_exec(
                "node",
                str(self.worker_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=None,
                limit=40 * 1024 * 1024,
            )
        except FileNotFoundError:
            raise BrowserError("Node.js is missing. Install Node.js 22 or newer.") from None
        await self._exchange(
            "launch",
            {
                "base_url": self.settings.base_url,
                "profile_dir": str(self.settings.profile_dir.resolve()),
                "chrome_path": self.settings.chrome_path,
                "headless": self.settings.headless,
                "timeout_ms": self.settings.timeout_ms,
            },
        )

    async def call(self, method: str, **params):
        async with self.lock:
            try:
                async with asyncio.timeout(self.settings.timeout_ms / 1000 + 15):
                    if self.process is None or self.process.returncode is not None:
                        await self._start()
                    return await self._exchange(method, params)
            except (TimeoutError, asyncio.CancelledError) as exc:
                # A late reply must never become the next call's reply. Do not retry writes.
                await self._close_unlocked()
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise BrowserError(
                    "Browser request timed out. A change may have been applied. "
                    "Read the project before retrying."
                ) from None
            except (BrokenPipeError, ConnectionError, ValueError, OSError):
                await self._close_unlocked()
                raise BrowserError(
                    "Browser worker disconnected. Read the project before retrying changes."
                ) from None

    async def _exchange(self, method, params):
        process = self.process
        assert process is not None and process.stdin is not None and process.stdout is not None
        process.stdin.write((json.dumps({"method": method, "params": params}) + "\n").encode())
        await process.stdin.drain()
        line = await process.stdout.readline()
        if not line:
            raise ConnectionError("Worker exited")
        response = json.loads(line)
        if not response["ok"]:
            raise BrowserError(response["error"])
        return response["result"]

    async def close(self):
        async with self.lock:
            await self._close_unlocked()

    async def _close_unlocked(self):
        process, self.process = self.process, None
        if process is None or process.returncode is not None:
            return
        assert process.stdin is not None
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
