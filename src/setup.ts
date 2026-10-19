/**
 * Multi-host installer for godot-mcp-extended (spec 02).
 *
 * Invoked as: node build/index.js setup --host <opencode|claude|codex|chatgpt|all> [--godot-path <p>]
 * Writes ONLY the godot-mcp entry of each host config, backs up first, prints restart notice.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

export type SetupHost = 'opencode' | 'claude' | 'codex' | 'chatgpt';

const ENTRY_KEY = 'godot-mcp';

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}.bak-${timestamp()}`;
  copyFileSync(path, backup);
  console.error(`[SETUP] Backed up ${path} -> ${backup}`);
}

function loadJson(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Existing config at ${path} is not valid JSON; refusing to modify it. Back it up manually first.`);
  }
}

function saveJson(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function home(): string {
  return process.env.HOME ?? homedir();
}

function entryFor(serverJs: string, godotPath: string): { command: string[]; env: Record<string, string> } {
  return { command: ['node', serverJs], env: { GODOT_PATH: godotPath } };
}

function writeOpencode(serverJs: string, godotPath: string): string {
  const path = join(home(), '.config', 'opencode', 'opencode.json');
  backupFile(path);
  const cfg = loadJson(path);
  cfg.mcp = cfg.mcp ?? {};
  cfg.mcp[ENTRY_KEY] = {
    command: ['node', serverJs],
    enabled: true,
    type: 'local',
    environment: { GODOT_PATH: godotPath },
    timeout: 300000,
  };
  saveJson(path, cfg);
  return path;
}

function writeClaude(serverJs: string, godotPath: string): string {
  const path = join(home(), '.claude.json');
  backupFile(path);
  const cfg = loadJson(path);
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[ENTRY_KEY] = {
    command: 'node',
    args: [serverJs],
    env: { GODOT_PATH: godotPath },
  };
  saveJson(path, cfg);
  return path;
}

function writeCodex(serverJs: string, godotPath: string): string {
  const dir = join(home(), '.codex');
  const path = join(dir, 'config.toml');
  mkdirSync(dir, { recursive: true });
  const block = `[mcp_servers.${ENTRY_KEY}]\ncommand = "node"\nargs = ["${serverJs}"]\n\n[mcp_servers.${ENTRY_KEY}.env]\nGODOT_PATH = "${godotPath}"\n`;
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (existing.includes(ENTRY_KEY)) {
      throw new Error(`config.toml already mentions ${ENTRY_KEY}; edit ${path} manually to avoid corrupting TOML.`);
    }
    backupFile(path);
    writeFileSync(path, existing.replace(/\s*$/, '') + '\n\n' + block);
  } else {
    writeFileSync(path, block);
  }
  return path;
}

function chatgptManual(serverJs: string, godotPath: string): string {
  return [
    'ChatGPT host config paths vary by app version; no file was written.',
    'Add a local MCP server manually with:',
    `  command: node ${serverJs}`,
    `  env: GODOT_PATH=${godotPath}`,
    'Then restart the ChatGPT app/CLI.',
  ].join('\n');
}

function detectHosts(): SetupHost[] {
  const found: SetupHost[] = [];
  if (existsSync(join(home(), '.config', 'opencode', 'opencode.json'))) found.push('opencode');
  if (existsSync(join(home(), '.claude.json'))) found.push('claude');
  if (existsSync(join(home(), '.codex', 'config.toml'))) found.push('codex');
  return found;
}

function parseArgs(argv: string[]): { hosts: SetupHost[] | 'all'; godotPath?: string } {
  let hostArg: string | undefined;
  let godotPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && i + 1 < argv.length) hostArg = argv[++i];
    else if (argv[i] === '--godot-path' && i + 1 < argv.length) godotPath = argv[++i];
    else if (argv[i].startsWith('--host=')) hostArg = argv[i].slice('--host='.length);
    else if (argv[i].startsWith('--godot-path=')) godotPath = argv[i].slice('--godot-path='.length);
  }
  if (!hostArg || hostArg === 'all') return { hosts: 'all', godotPath };
  const valid: SetupHost[] = ['opencode', 'claude', 'codex', 'chatgpt'];
  const hosts = hostArg.split(',').map((h) => h.trim()) as SetupHost[];
  for (const h of hosts) {
    if (!valid.includes(h)) throw new Error(`Unknown host: ${h}. Use opencode|claude|codex|chatgpt|all.`);
  }
  return { hosts, godotPath };
}

/**
 * Run the installer. serverJs must be the absolute path of the built server entrypoint.
 * resolveGodotPath supplies GODOT_PATH resolution (server's own detection order).
 */
export async function runSetup(
  rawArgs: string[],
  serverJs: string,
  resolveGodotPath: (override?: string) => Promise<string | null>
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(rawArgs);
  } catch (error: unknown) {
    console.error(`[SETUP] ${error instanceof Error ? error.message : 'Bad arguments'}`);
    console.error('[SETUP] Usage: node build/index.js setup --host opencode|claude|codex|chatgpt|all [--godot-path <p>]');
    return 2;
  }

  let hosts: SetupHost[];
  if (parsed.hosts === 'all') {
    hosts = ['opencode', 'claude', 'codex', 'chatgpt'];
  } else {
    hosts = parsed.hosts;
  }
  if (hosts.length === 0) {
    const detected = detectHosts();
    if (detected.length === 1) {
      hosts = detected;
    } else {
      console.error(`[SETUP] Found host configs: ${detected.join(', ') || '(none)'}. Pass --host explicitly.`);
      return 2;
    }
  }

  const absServerJs = resolve(serverJs);
  const godotPath = await resolveGodotPath(parsed.godotPath);
  if (!godotPath) {
    console.error('[SETUP] Could not resolve a Godot executable. Pass --godot-path <p> or set GODOT_PATH.');
    return 1;
  }

  let failed = false;
  for (const host of hosts) {
    try {
      if (host === 'chatgpt') {
        console.error(chatgptManual(absServerJs, godotPath));
        continue;
      }
      const written =
        host === 'opencode'
          ? writeOpencode(absServerJs, godotPath)
          : host === 'claude'
            ? writeClaude(absServerJs, godotPath)
            : writeCodex(absServerJs, godotPath);
      console.error(`[SETUP] ${host}: wrote ${written}`);
    } catch (error: unknown) {
      failed = true;
      console.error(`[SETUP] ${host} FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.error('[SETUP] Done. Restart each host app/session so it reloads MCP config (hot-reload is unreliable).');
  return failed ? 1 : 0;
}
