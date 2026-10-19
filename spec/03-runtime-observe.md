# 03 — Runtime observation [P3]

## Constraint (accepted limitation)
The repo's architecture is CLI-spawn per call: no persistent editor/game connection exists.
Live in-memory state of a detached running game is NOT reachable from a `--script` run.
So P3 observes via structured run-and-capture, not via live attachment.

## Tool: `run_project_capture`
- Params: `projectPath` (required), `scene` (optional), `durationSeconds` (default 30, max 300),
  `failOnError` (default true).
- Behavior:
  1. Spawn `godot --headless --path <proj> [scene]` with a marker-protocol parser on stdout:
     lines matching `^\[SIGNAL\]\s*(\{.*\})\s*$` are parsed as JSON events
     `{ t, kind, data }`; everything else is kept as log tail (cap per spec 00 §4).
  2. Kill at `durationSeconds`; collect exit code/signal.
  3. Verdict: `timeout` | `clean-exit` | `crashed` (non-zero/signal) | `errors-seen`
     (`Godot Engine v.*ERROR|SCRIPT ERROR` in output when `failOnError`).
  4. Return JSON: `{ verdict, exitCode, durationMs, events: [...], logTail, errorCount }`.
- Reuses `activeProcess` machinery; refuses if a run is already active (error with `stop_project` hint).
- Document the marker protocol in README with a 5-line GDScript snippet (`print("[SIGNAL]...")`).

## Explicitly out of scope for P3
- Screenshots (headless dummy renderer returns blank), live node-tree reads, input injection.
  Those need the opt-in hook → spec 04.

## Acceptance
- [ ] Live call on colony-sim (or a fixture project) returns a `timeout`/`clean-exit` verdict
      with parsed `[SIGNAL]` events from a marker-printing scene.
- [ ] Crash fixture (scene with `printerr` + quit(1)) → `crashed` with error tail.
- [ ] Second call during an active run → clean refusal error.
