# 04 — Runtime control via opt-in hook [P4 — CONDITIONAL]

## Gate
Build ONLY if spec 03 is merged and clean. If the hook design sprawls during this spec's
implementation, cut control and ship observation-only. One paragraph in the release notes,
no guilt.

## Design: `signal_hook.gd` (shipped, NEVER auto-installed)
- File lives in repo (`hook/signal_hook.gd`) + README install steps (copy to project, add as
  autoload). The sidecar NEVER writes it into a user project — explicit user opt-in only.
- Dormant by default: activates ONLY when env `SIGNAL_HOOK=1` is present. `run_project` /
  `run_project_capture` set it automatically when `<projectPath>/signal_hook.gd` exists;
  otherwise the hook file is inert.
- Transport: hook opens TCP loopback on an ephemeral port, prints `^\[SIGNAL-PORT\] (\d+)$`;
  sidecar parses the port from captured stdout and speaks length-prefixed JSON. Localhost only.
- Allow-listed commands ONLY (mirrors the upstream RCE fix — no `load()`, no script exec):
  `tree` (capped subtree dump: path, type, visible, position), `read` (Expression-eval,
  read-only: property gets + pure arithmetic; result JSON-serialized, capped depth),
  `shot` (viewport capture → project-local `.signal/shot-<ts>.png`, returns path),
  `quit` (graceful). Unknown command → error, connection stays up.
- `read` hardening: reject source containing `set_`, `load`, `OS.`, `FileAccess`, `DirAccess`,
  `Engine.`; cap to one expression, 2s eval budget enforced client-side by closing on timeout.

## Tools (sidecar side)
- `hook_exec`: params `command` (`tree|read|shot|quit`), `target` (node path for
  tree/read), `expression` (for read), `maxDepth` (for tree). No `projectPath`: the server
  tracks a single active run, so the tool operates on that run. Errors if no live run
  with an active hook port.
- Requires an active `run_project` session (`run_project_capture` exits too fast to query);
  refuses otherwise.

## Acceptance
- [ ] Fixture project + hook: `tree` returns root subtree, `read` evaluates `2+2` and a node
      property, `shot` returns a valid PNG path, malicious `read` (`OS.execute`) is rejected.
- [ ] Hook file present but `SIGNAL_HOOK` unset → hook dormant, game unaffected.
- [ ] Security review paragraph in README (what the hook CAN do, and the localhost-only boundary).
