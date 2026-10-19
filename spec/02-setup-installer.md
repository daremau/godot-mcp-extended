# 02 — Multi-host installer [P2]

## Motivation
Upstream only documents Claude Code. opencode and ChatGPT-family hosts need first-class setup.

## Design: `setup` CLI command (NOT an MCP tool)
- If `process.argv` contains `setup`, the entrypoint runs the installer instead of starting
  the MCP server: `node build/index.js setup --host <h> [--godot-path <p>]`.
- `--host opencode|claude|codex|chatgpt|all` (default: detect-all-installed → error if ambiguous,
  list what was found).
- Per host, write-or-replace ONLY the `godot-mcp` entry; backup existing file to
  `<file>.bak-<yyyymmdd-hhmmss>` first; print restart notice (hot-reload is unreliable — observed).

## Host targets (verify exact paths during implementation; fallback = print manual steps)
| host | file | entry shape |
|---|---|---|
| opencode | `~/.config/opencode/opencode.json` | `mcp["godot-mcp"] = { command: ["node", <abs build/index.js>], type: local, environment: { GODOT_PATH } }` |
| claude | `~/.claude.json` | `mcpServers["godot-mcp"] = { command: "node", args: [<abs>], env: { GODOT_PATH } }` |
| codex | `~/.codex/config.toml` | `[mcp_servers.godot-mcp]` + `command`/`args`/`env` |
| chatgpt (desktop) | OS-specific app config (verify) | same shape as file requires |

- `--godot-path` overrides auto-detect; else reuse the server's `detectGodotPath` order
  (config arg → `GODOT_PATH` env → platform scan). Installer resolves the absolute build path
  from its own location (`build/index.js`), so it keeps working after `npm run build`.
- Idempotent: re-running replaces the entry, keeps one backup per run.

## Acceptance
- [ ] `setup --host opencode` on a scratch `HOME` writes a correct entry; re-run is a no-op diff.
- [ ] Docs: README gains an opencode section + ChatGPT section matching upstream's Claude Code section.
- [ ] Live: fresh opencode session shows `mcp connected server=godot-mcp` from installer-written config.
