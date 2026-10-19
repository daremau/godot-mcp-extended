# 00 — Shared conventions (normative for specs 01–05)

Applies to every new tool, op, test, and doc in `godot-mcp-extended`.
Upstream patterns observed in `src/index.ts` / `src/scripts/godot_operations.gd` are the baseline.

## 1. Tool contract (TypeScript sidecar)
- Tool names are `snake_case` in `ListTools`. Both `snake_case` and `camelCase` args must be
  accepted: add every new param key to `parameterMappings` (and it flows into the reverse map).
- Every handler MUST follow this order:
  1. `normalizeParameters(args)`
  2. required-arg check → `createErrorResponse` naming the missing arg
  3. `validatePath()` on every path arg (rejects `..`)
  4. `project.godot` existence check for project-scoped tools
  5. do the work; return `{ content: [{ type: 'text', text }] }` or `createErrorResponse(msg, solutions)`
- Error responses ALWAYS use `createErrorResponse(message, possibleSolutions)` — never throw
  raw errors to the client (only `Unknown tool` uses `McpError`).
- Dispatch: add `case '<tool>'` in the `CallToolRequestSchema` switch, same position order as `ListTools`.
- Never use shell interpolation: `execFile`/`spawn` with arg arrays only (established pattern).

## 2. Logging / protocol hygiene (the Fennara lesson)
- `console.error` ONLY. No `console.log` anywhere — stdout is pure JSON-RPC.
- Long work must answer in <30s or return a pollable result; never let the host time out silently.
- Every stdio change must pass spec 05 conformance before merge.

## 3. Security posture (upstream RCE fix d4cc0f9 is the law)
- NO arbitrary GDScript / C# / shell execution from tool args. Ever.
- New GDScript ops are allow-listed `match` arms with fixed semantics; class names validated
  via `validateClassName()`; node paths validated (no `..`, must be relative).
- `Expression` (specs 03–04) is read-only: no `set`, no method calls with side effects, capped
  instruction count where the API allows.

## 4. Output discipline
- Cap all unbounded output: default 200 items / 100KB, with `truncated: true` + counts.
  paging params (`limit`, `offset`) where listing-like.
- Structured results are single `text` blocks containing JSON (matches upstream style).

## 5. Build / test loop
- `npm run build` (`tsc` + `scripts/build.js` copies `godot_operations.gd` to `build/scripts`).
  Both `src` and `build` changes ship together; never hand-edit `build/`.
- Verify per spec: standalone stdio handshake, then live call in opencode
  (`godot-mcp` entry, `GODOT_PATH` set), against `/home/darem/game-dev/colony-sim`.
