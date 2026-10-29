import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    base_url: str = "https://www.overleaf.com"
    profile_dir: Path = field(default_factory=lambda: Path.home() / ".overleaf-mcp" / "profile")
    download_dir: Path = field(default_factory=lambda: Path.home() / ".overleaf-mcp" / "downloads")
    chrome_path: str | None = None
    headless: bool = False
    timeout_ms: int = 120_000

    def __post_init__(self):
        url = urlsplit(self.base_url)
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in {"", "/"}
            or (url.scheme != "https" and not (local and url.scheme == "http"))
        ):
            raise ValueError(
                "OVERLEAF_BASE_URL must be an HTTPS origin (HTTP allowed on localhost)"
            )
        if not 1000 <= self.timeout_ms <= 600_000:
            raise ValueError("OVERLEAF_TIMEOUT_MS must be between 1000 and 600000")

    @classmethod
    def from_env(cls):
        defaults = cls()
        return cls(
            base_url=os.getenv("OVERLEAF_BASE_URL", defaults.base_url).rstrip("/"),
            profile_dir=Path(os.getenv("OVERLEAF_PROFILE_DIR", defaults.profile_dir)).expanduser(),
            download_dir=Path(
                os.getenv("OVERLEAF_DOWNLOAD_DIR", defaults.download_dir)
            ).expanduser(),
            chrome_path=os.getenv("OVERLEAF_CHROME_PATH") or None,
            headless=os.getenv("OVERLEAF_HEADLESS", "false").lower() == "true",
            timeout_ms=int(os.getenv("OVERLEAF_TIMEOUT_MS", "120000")),
        )
