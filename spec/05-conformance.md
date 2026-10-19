# 05 — Conformance suite + release gates [P5]

## `npm test` (node:test, zero Godot dependency — mock the Godot CLI layer)
Harness spawns `build/index.js` over stdio with scripted cases. ALL must pass:
1. `initialize` with `2024-11-05` → echo `2024-11-05`.
2. `initialize` with `2025-03-26` → echo a version the client asked for (negotiation, never dictate).
3. Numeric AND string request IDs echoed verbatim across `initialize`/`tools/list`/`tools/call`.
4. Pipelined `initialize` + `notifications/initialized` + `tools/list` in one write → ordered responses.
5. `notifications/*` → NO response bytes (Fennara leaked internal messages; regression test).
6. `tools/list` shape: every tool has `name`, `description`, `inputSchema`; names are `snake_case`.
7. Unknown tool → `MethodNotFound`, still JSON-RPC with matching ID.
8. stdout purity: every stdout line parses as JSON-RPC; zero non-JSON bytes for the whole session.
9. Response latency: `tools/list` < 2s (catches buffering regressions like Fennara 0.3.4).
10. New tools (01–04) register mock-level contract tests: arg normalization, `..` rejection,
    missing-`project.godot` error, output-cap behavior.

## Live matrix (manual, recorded in `MATRIX.md`)
Same 3-tool smoke (`get_godot_version`, `get_project_info`, newest tool) in:
opencode, Claude Code, ChatGPT desktop/CLI — against colony-sim. Record host version + date + PASS/FAIL.
Release = all green.

## Release checklist
- [ ] `npm test` green, `npm run build` clean, no `console.log` in `src/` (`grep -rn "console.log src"` empty).
- [ ] `MATRIX.md` all green, `CHANGELOG.md` entry, version bump in `package.json` + server `version`.
- [ ] Upstream: open PR for anything generic (installer host docs, conformance harness).
