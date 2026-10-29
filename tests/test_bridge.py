import asyncio

import pytest

from bridge import Bridge, BrowserError
from config import Settings


async def test_serializes_requests_and_cleans_up(tmp_path):
    worker = tmp_path / "worker.mjs"
    worker.write_text("""
import {createInterface} from 'node:readline';
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(JSON.stringify({ok: true, result: request.params}) + '\\n');
}
""")
    bridge = Bridge(Settings(profile_dir=tmp_path / "profile"), worker)
    try:
        results = await asyncio.gather(*(bridge.call("echo", n=n) for n in range(10)))
        assert results == [{"n": n} for n in range(10)]
        process = bridge.process
    finally:
        await bridge.close()
    assert process.returncode == 0


async def test_cancel_discards_worker_and_late_reply(tmp_path):
    worker = tmp_path / "worker.mjs"
    worker.write_text("""
import {createInterface} from 'node:readline';
for await (const line of createInterface({input: process.stdin})) {
  const {method} = JSON.parse(line);
  if (method !== 'launch') await new Promise(resolve => setTimeout(resolve, 1000));
  process.stdout.write(JSON.stringify({ok: true, result: method}) + '\\n');
}
""")
    bridge = Bridge(Settings(profile_dir=tmp_path / "profile"), worker)
    task = asyncio.create_task(bridge.call("slow"))
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert bridge.process is None
    assert await bridge.call("next") == "next"
    await bridge.close()


async def test_worker_error_is_not_retried(tmp_path):
    worker = tmp_path / "worker.mjs"
    worker.write_text("""
import {createInterface} from 'node:readline';
for await (const line of createInterface({input: process.stdin})) {
  const {method} = JSON.parse(line);
  process.stdout.write(JSON.stringify(method === 'launch'
    ? {ok: true, result: null} : {ok: false, error: 'conflict'}) + '\\n');
}
""")
    bridge = Bridge(Settings(profile_dir=tmp_path / "profile"), worker)
    try:
        with pytest.raises(BrowserError, match="conflict"):
            await bridge.call("write_file")
    finally:
        await bridge.close()
