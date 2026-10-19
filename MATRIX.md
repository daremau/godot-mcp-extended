# Live host matrix (spec 05)

Same smoke test everywhere: `get_godot_version` + `get_project_info` + newest tool,
against `/home/darem/game-dev/colony-sim` (Godot 4.7 mono).

| Host | Version | Date | Result | Notes |
|---|---|---|---|---|
| opencode | 2.0.32 | 2026-10-19 | PASS (core) | `mcp connected, tools=14→18`; `get_godot_version`, `get_project_info`, `dotnet_build` (success + error paths) verified live |
| opencode | 2.0.32 | 2026-10-19 | PENDING (new tools) | `run_project_capture`, `hook_exec` verified standalone only — MCP server processes were killed during testing and opencode does not respawn/reload without restart; re-verify after restart |
| Claude Code | 2.1.303 | 2026-10-19 | PASS | `claude mcp list` shows `✔ Connected`; one-shot `-p` session called `get_godot_version` (4.7.stable.mono.official.5b4e0cb0f) + `dotnet_build` on fixture (success, 0 errors, 0 warnings) |
| Codex CLI | 0.162.1 | 2026-10-19 | PASS | `codex exec --sandbox workspace-write` called `get_godot_version` (same version string) + `run_project_capture` on sigok fixture (`clean-exit`, 2 SIGNAL events) |
| ChatGPT desktop/CLI | — | — | UNTESTED | manual steps only (config paths vary); needs a live session |

Standalone coverage (no host needed, `npm test` green, 14 tests): protocol negotiation
2024-11-05 + 2025-03-26, string/numeric ID echo, pipelining, notification silence,
stdout purity, <2s latency guard, tool contracts, capture verdicts with mocked Godot CLI,
hook framing/persistence against a live headless game.
