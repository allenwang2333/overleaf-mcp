import argparse
import asyncio
from dataclasses import replace

from bridge import Bridge, BrowserError
from config import Settings
from server import create_server


async def login(settings: Settings):
    bridge = Bridge(replace(settings, headless=False))
    try:
        await bridge.call("login")
        print("Sign in in the browser. Complete any verification yourself.")
        await asyncio.to_thread(input, "When the project dashboard is visible, press Enter here: ")
        status = await bridge.call("status")
        if not status["authenticated"]:
            raise BrowserError("Login was not confirmed. Run the login command again.")
        print(f"Login saved in {settings.profile_dir}")
    finally:
        await bridge.close()


def main():
    parser = argparse.ArgumentParser(description="Overleaf MCP server (stdio)")
    parser.add_argument("command", nargs="?", choices=["serve", "login"], default="serve")
    args = parser.parse_args()
    try:
        settings = Settings.from_env()
        if args.command == "login":
            asyncio.run(login(settings))
        else:
            create_server(settings).run(transport="stdio")
    except (ValueError, BrowserError) as exc:
        parser.exit(1, f"{exc}\n")
    except KeyboardInterrupt:
        pass
