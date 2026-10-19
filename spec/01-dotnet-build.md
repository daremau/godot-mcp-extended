# 01 — `dotnet_build` (+ `dotnet_test`) [P1]

## Motivation
Godot 4.x .NET projects (like colony-sim) fail builds silently in the editor. Agents need
structured compiler diagnostics without leaving the MCP session.

## Tools
### `dotnet_build` (required)
- Params: `projectPath` (required), `configuration` (default `"Release"`),
  `target` (optional MSBuild target / project file), `maxDiagnostics` (default 200).
- Behavior:
  1. Resolve build file: `<projectPath>/*.sln`, else `<projectPath>/*.csproj`; exactly-one
     rule — if several `.csproj` and no `.sln`, error listing candidates.
  2. Check `dotnet` on PATH (`dotnet --version`); else error with install guidance.
  3. Run `dotnet build <file> -c <config> --nologo -v q /p:GenerateFullPaths=true`,
     exec timeout 280s, `maxBuffer` 16MB.
  4. Parse lines matching `^(.*)\((\d+)(?:,(\d+))?\):\s(error|warning)\s([A-Z0-9]+):\s(.*)$`
     into `{ file, line, col, severity, code, message }`.
  5. Return text block with JSON: `{ success, errors, warnings, diagnostics: [...], truncated }`.
     Non-zero exit with zero parsed diagnostics → include raw tail (last 50 lines).
- `configuration` allow-list: `Debug|Release` only (blocks `/p:` injection via that param;
  full arg arrays are used throughout regardless).

### `dotnet_test` (include iff <30 lines extra — reuses the same runner)
- Params: `projectPath`, `configuration` (default `Release`), `filter` (optional `--filter` value).
- Same resolve/parse behavior; success = exit 0.

## Acceptance
- [ ] `npm run build` clean.
- [ ] Standalone stdio: `tools/call dotnet_build` on colony-sim returns parsed JSON, `success: true`.
- [ ] Live opencode call on colony-sim returns success; on a project with no `.sln`/`.csproj`
      returns the candidates/no-project error (negative test).
- [ ] Broken C# file → `success: false` with file/line/code parsed (seed a temp copy, don't break colony-sim).
