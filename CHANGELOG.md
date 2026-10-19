# Changelog

## 0.2.0 — extended v1 (2026-10-19)

Forked from `Coding-Solo/godot-mcp`, renamed to `godot-mcp-extended`.

- `dotnet_build` / `dotnet_test`: structured MSBuild diagnostics (file/line/col/code)
  for Godot 4.x .NET projects, with dedup, output caps, and solution discovery.
- `setup` CLI: multi-host installer (`--host opencode|claude|codex|chatgpt|all`)
  with config backup, GODOT_PATH resolution, idempotent rewrites, and manual steps
  where config paths vary.
- `run_project_capture`: headless fixed-duration runs with `[SIGNAL]` marker parsing
  and `timeout|clean-exit|crashed|errors-seen` verdicts; refuses concurrent runs.
- Opt-in runtime hook (`hook/signal_hook.gd`, never auto-installed, dormant without
  `SIGNAL_HOOK=1`, localhost-only, allow-listed `tree|read|shot|quit`) plus `hook_exec`
  with a persistent TCP client and per-tool `read` token blocklist.
- Conformance suite (`npm test`, 14 tests, zero-Godot with mocked CLI): version
  negotiation, ID echo, pipelining, notification silence, stdout purity, latency guard.
- Docs: opencode + ChatGPT/Codex setup sections, runtime hook guide with security boundary.
