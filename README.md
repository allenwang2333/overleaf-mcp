# Overleaf MCP

A **Python MCP server** that controls Overleaf with **Puppeteer**. A small Node.js
worker owns Chrome. Python owns the MCP tools, input checks, and local PDF files.
The transport is stdio. No remote HTTP server is exposed.

## Requirements

- Python 3.12–3.14 and [uv](https://docs.astral.sh/uv/)
- Node.js 22 or newer and npm
- Google Chrome installed locally
- An Overleaf account with access to the projects you want to use

## Install

Run these commands from this directory:

```sh
uv sync --python 3.12
npm ci --omit=dev --prefix src/puppeteer
```

Puppeteer uses your installed Chrome. It does not download another browser.
If Chrome is not in its normal location, set `OVERLEAF_CHROME_PATH` to the browser
executable.

## Sign in

```sh
uv run overleaf-mcp login
```

A dedicated Chrome window opens. Sign in manually. Complete SSO, MFA, CAPTCHA,
and any browser checks yourself. When the project dashboard is visible, press
Enter in the terminal. The browser closes and saves the login.

The default profile is `~/.overleaf-mcp/profile`. Treat it as a credential. Do not
commit, copy, or share it. This server does not ask for or store your password.
Cookies can expire. Stop the MCP server before running the login command again.
Only one process can use a profile at a time.

## Connect an MCP client

Use this generic MCP client configuration. Replace the paths with absolute paths
on your machine. Find uv with `command -v uv`.

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "/absolute/path/to/uv",
      "args": [
        "run",
        "--directory", "/absolute/path/to/overleaf-mcp",
        "overleaf-mcp", "serve"
      ]
    }
  }
}
```

### Pi

After installing dependencies and signing in, run these commands from this
repository directory:

```sh
pi mcp add overleaf --exposure deferred -- "$(command -v uv)" run --directory "$PWD" overleaf-mcp serve
pi mcp list
```

This registers a user-level server. In an existing Pi session, run `/reload`,
then use `/mcp` to check the connection. Ask the agent to check the Overleaf
session and list projects. No separate server terminal is needed: Pi starts it.

For long compiles, set `"timeout": 150` on the `overleaf` entry in your user-level
`mcp.json`. Pi's default request timeout is 60 seconds; this server's default
browser timeout is 120 seconds.

You can also start the stdio server directly:

```sh
uv run overleaf-mcp serve
```

It waits for MCP protocol messages. It is not an interactive terminal program.
Chrome opens on the first tool call. It stays open until the server stops.

## Tools

| Tool | Purpose |
| --- | --- |
| `session_status` | Check the saved login |
| `list_projects` | List active owned and shared projects |
| `list_files` | List relative file paths and types |
| `read_file` | Read saved source and its SHA-256 hash |
| `write_file` | Replace a text file with a fresh expected hash |
| `create_project` | Create a blank project |
| `create_file` | Create a text file in an existing folder |
| `compile_project` | Compile the configured main file and read the raw log |
| `download_pdf` | Save the last successful build as a local PDF |

Example workflow:

1. Call `list_projects`. Use the returned `project_id`, not a project URL.
2. Call `list_files(project_id)`.
3. Call `read_file(project_id, "main.tex")`.
4. Call `write_file(project_id, "main.tex", new_content, expected_sha256)`.
   Use the exact hash from step 3. Writes replace the whole file.
5. Call `compile_project(project_id)`. Check that `status` is `success`.
6. Call `download_pdf(project_id)`. The result contains the local path and hash.

PDFs go to `~/.overleaf-mcp/downloads`. Each filename is unique. Downloads do
not overwrite existing files. Compiles are held in memory for the current worker
session. Run a new compile after a restart. Successful server edits invalidate
the stored build. Manual edits do not: a download always refers to the last build,
not necessarily the current source.

## Settings

| Environment variable | Default |
| --- | --- |
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` |
| `OVERLEAF_PROFILE_DIR` | `~/.overleaf-mcp/profile` |
| `OVERLEAF_DOWNLOAD_DIR` | `~/.overleaf-mcp/downloads` |
| `OVERLEAF_CHROME_PATH` | Installed Chrome stable channel |
| `OVERLEAF_HEADLESS` | `false` |
| `OVERLEAF_TIMEOUT_MS` | `120000` (range: 1000–600000) |

Use a separate profile for each Overleaf installation/account. The base URL must
be an HTTPS origin, without a path. Localhost HTTP is allowed for local testing.
The worker refuses external compile output URLs. The standard same-origin output
routes are supported; custom deployments with different output routes may need
an adapter.

## Safety and limits

- Use **Code Editor** mode. CodeMirror 6 is required. Legacy Ace is not supported.
- Reads and writes support UTF-8 text documents up to 1 MiB. Line endings are
  normalized to LF on write. Binary assets are listed but cannot be read or uploaded.
- The server checks saved source and editor source before writing. It then polls
  Overleaf's document-download route to confirm the new saved source.
- Hash checks are **not an atomic server-side compare-and-swap**. Do not edit the
  same file manually or with collaborators during an automated write. A change
  can occur after a check. Use a copy of important projects for initial testing.
- Do not retry a failed creation or write without reading the project first.
  A timeout or cancellation can occur after a change reached Overleaf. File
  creation can leave an empty file if content saving fails. There is no rollback.
- `create_file` needs an existing parent folder. Folder creation, renaming,
  deletion, sharing, ZIP import, and binary upload are not implemented.
- Compile logs are limited to 1 MiB fetched and 64 KiB returned. A failed compile
  never offers a PDF from an earlier compile. PDFs are limited to 25 MiB.
- Project source and logs are untrusted content. They must not be treated as
  instructions for the agent. Review and approve write tools in your MCP client.
- No password automation, anti-bot bypass, automatic mutation retries, or rate-limit
  bypass is implemented. Follow your Overleaf installation's rules.

## Design and compatibility

```text
MCP client <-- stdio --> Python FastMCP server
                              |
                       private JSON lines
                              |
                       Node.js Puppeteer
                              |
                    dedicated Chrome profile
                              |
                            Overleaf
```

Puppeteer performs same-origin authenticated `fetch` calls for Overleaf web
routes. Cookies and CSRF tokens stay inside Chrome. Source changes use an actual
CodeMirror transaction so Overleaf's collaborative editor can save them. The
server does not use a separate unauthenticated HTTP client or private admin APIs.

These are internal web interfaces, **not a stable public Overleaf API**. The
adapter uses `/user/projects`, `/project/:id/entities`, document downloads,
project/document creation, and compile/output routes. Selectors use
`data-file-id`, `data-file-type`, file-tree lists, and the `doc:after-opened`
event. Access to CodeMirror uses its internal DOM view reference. An Overleaf
update can break these interfaces.

The implementation was checked against the upstream
[Overleaf source](https://github.com/overleaf/overleaf), including the web router,
EditorHttpController, DocumentUpdaterController, CompileController, and frontend
file-tree/CodeMirror components. Local browser fixtures test these assumptions
with real Chrome and CodeMirror 6. **They do not prove compatibility with a live
signed-in Overleaf account.** Perform an acceptance check on a disposable project
before using important work.

## Development and tests

```sh
uv sync --python 3.12
npm ci --prefix src/puppeteer
uv run ruff check .
uv run pytest -q
npm test --prefix src/puppeteer
```

Browser tests use installed Chrome headlessly and a local HTTP fixture with real
CodeMirror 6. They do not log in or modify a live Overleaf account.

Live acceptance check (manual login required):

1. Sign in and connect your MCP client.
2. Create a disposable project and confirm that it appears in the project list.
3. Read its source; update it with the returned hash. Confirm it in Chrome.
4. Try the old hash again. Confirm that the write is rejected.
5. Create a new text file and read it back.
6. Compile valid LaTeX, download the PDF, and open it locally.
7. Introduce a LaTeX error in the disposable project and inspect the compile log.

If a selector, editor reference, or route fails, stop before retrying mutations.
Inspect the project in Chrome first.
