#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync, statSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { runSetup } from './setup.js';
import { parseHookPort, HookConnection } from './hook_client.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private hookConn: { port: number; conn: HookConnection } | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
    'max_diagnostics': 'maxDiagnostics',
    'duration_seconds': 'durationSeconds',
    'fail_on_error': 'failOnError',
    'max_depth': 'maxDepth',
    'source_scene': 'sourceScene',
    'source_node': 'sourceNode',
    'signal_name': 'signalName',
    'target_node': 'targetNode',
    'method_name': 'methodName',
    'script_path': 'scriptPath',
    'new_name': 'newName',
    'property': 'property',
    'value': 'value',
    'content': 'content',
    'template': 'template',
    'overwrite': 'overwrite',
    'subdir': 'subdir',
    'extensions': 'extensions',
    'limit': 'limit',
    'offset': 'offset',
    'action': 'action',
    'hold_ms': 'holdMs',
    'include_image': 'includeImage',
    'preset': 'preset',
    'do_export': 'doExport',
    'pattern': 'pattern',
    'test_timeout': 'testTimeout',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.3.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  private validateClassName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Validate a GDScript identifier (signal, method, input action, node name).
   */
  private validateIdentifier(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Validate an offline scene node path like "root" or "root/Player/Sprite".
   * Rejects "..", absolute hook-style paths are handled separately.
   */
  private validateSceneNodePath(p: string): boolean {
    if (!p || p.includes('..')) return false;
    if (p === 'root') return true;
    if (!p.startsWith('root/')) return false;
    return /^[A-Za-z0-9_\/@\- ]+$/.test(p);
  }

  /**
   * Validate a node property name, allowing sub-names like "position:x".
   */
  private validatePropertyName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*(:[A-Za-z_][A-Za-z0-9_]*)*$/.test(name);
  }

  /**
   * Ensure a project-relative file path stays inside the project directory.
   * Returns the absolute path, or null when it escapes / is invalid.
   */
  private resolveInsideProject(projectPath: string, relPath: string): string | null {
    if (!relPath || relPath.includes('..')) return null;
    const cleaned = relPath.replace(/^res:\/\//, '').replace(/^\/+/, '');
    if (!cleaned || cleaned.includes('..')) return null;
    const abs = normalize(join(projectPath, cleaned));
    const base = normalize(projectPath);
    if (abs !== base && !abs.startsWith(base + '/')) return null;
    return abs;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Resolve the Godot executable path, honoring an explicit override first.
   * Public so the multi-host installer (setup.ts) reuses the same detection order.
   * @returns The resolved path, or null when none is valid.
   */
  public async resolveGodotPath(override?: string): Promise<string | null> {
    if (override) {
      const normalized = normalize(override);
      if (await this.isValidGodotPath(normalized)) {
        this.godotPath = normalized;
        return normalized;
      }
      return null;
    }
    await this.detectGodotPath();
    return this.godotPath;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'dotnet_build',
          description: 'Build the .NET solution/project of a Godot 4.x game and return structured compiler diagnostics',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              configuration: {
                type: 'string',
                description: 'Optional: MSBuild configuration, Debug or Release (defaults to Release)',
              },
              target: {
                type: 'string',
                description: 'Optional: specific .sln or .csproj file name within the project directory',
              },
              maxDiagnostics: {
                type: 'number',
                description: 'Optional: maximum diagnostics to return (defaults to 200)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'dotnet_test',
          description: 'Run dotnet test for a Godot 4.x .NET project and return structured results',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              configuration: {
                type: 'string',
                description: 'Optional: MSBuild configuration, Debug or Release (defaults to Release)',
              },
              filter: {
                type: 'string',
                description: 'Optional: test filter expression passed to --filter',
              },
              maxDiagnostics: {
                type: 'number',
                description: 'Optional: maximum diagnostics to return (defaults to 200)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project_capture',
          description: 'Run a Godot project headless for a fixed duration, parse [SIGNAL] JSON markers from output, and return an exit verdict',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: specific scene to run',
              },
              durationSeconds: {
                type: 'number',
                description: 'Optional: max run time in seconds (defaults to 30, max 280)',
              },
              failOnError: {
                type: 'boolean',
                description: 'Optional: verdict errors-seen when Godot error lines appear (defaults to true)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'hook_exec',
          description: 'Send an allow-listed command (tree|read|shot|quit|press|stats) to the opt-in signal_hook in a running game. Requires an active run_project session with the hook installed.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Hook command: tree, read, shot, quit, press, or stats',
              },
              target: {
                type: 'string',
                description: 'Optional: node path for tree/read (absolute like /root/Main or relative to the current scene, defaults to ".")',
              },
              expression: {
                type: 'string',
                description: 'Required for read: read-only Expression evaluated on the target node',
              },
              maxDepth: {
                type: 'number',
                description: 'Optional: subtree depth for tree (defaults to 3)',
              },
              action: {
                type: 'string',
                description: 'Required for press: InputMap action name to press/release',
              },
              holdMs: {
                type: 'number',
                description: 'Optional for press: how long to hold the action in ms (defaults to 120)',
              },
              includeImage: {
                type: 'boolean',
                description: 'Optional for shot: include base64 PNG in the response (defaults to true)',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'dump_scene',
          description: 'Parse a .tscn scene file statically (no Godot run) and return its node tree with properties',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project (e.g. main.tscn)' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'list_assets',
          description: 'List files inside a Godot project with optional extension filter and paging',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              subdir: { type: 'string', description: 'Optional subdirectory relative to project (defaults to project root)' },
              extensions: { type: 'array', items: { type: 'string' }, description: 'Optional list like ["png","gd","tscn"]' },
              limit: { type: 'number', description: 'Optional max entries (defaults to 200, max 1000)' },
              offset: { type: 'number', description: 'Optional paging offset (defaults to 0)' },
              recursive: { type: 'boolean', description: 'Recurse into subdirectories (defaults to true)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_project_settings',
          description: 'Read project.godot and return parsed sections (application, autoload, input, etc.) capped for AI use',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'set_node_property',
          description: 'Set a property on a node in an existing scene (offline, headless Godot)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              nodePath: { type: 'string', description: 'Node path like root/Player (root = scene root)' },
              property: { type: 'string', description: 'Property name, sub-names allowed like position:x' },
              value: { description: 'New value (primitives, arrays, or res:// resource path strings)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'property', 'value'],
          },
        },
        {
          name: 'remove_node',
          description: 'Remove a node (and its children) from an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              nodePath: { type: 'string', description: 'Node path like root/Player (cannot be root)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'rename_node',
          description: 'Rename a node in an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              nodePath: { type: 'string', description: 'Node path like root/Player' },
              newName: { type: 'string', description: 'New node name (identifier)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'newName'],
          },
        },
        {
          name: 'duplicate_node',
          description: 'Duplicate a node in an existing scene as a sibling',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              nodePath: { type: 'string', description: 'Node path like root/Player' },
              newName: { type: 'string', description: 'Optional name for the copy (defaults to <name>Copy)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'instance_scene',
          description: 'Instance a source .tscn into another scene under a parent node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Target scene file relative to project' },
              parentNodePath: { type: 'string', description: 'Parent path like root or root/Level' },
              sourceScene: { type: 'string', description: 'Source .tscn path relative to project' },
              nodeName: { type: 'string', description: 'Optional name for the instance' },
            },
            required: ['projectPath', 'scenePath', 'parentNodePath', 'sourceScene'],
          },
        },
        {
          name: 'create_script',
          description: 'Create a new GDScript file in the project from a template or inline content',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              filePath: { type: 'string', description: 'Script path relative to project, e.g. scripts/player.gd' },
              template: { type: 'string', description: 'Optional template: empty|Node|Node2D|Node3D|CharacterBody2D|autoload (defaults to Node)' },
              content: { type: 'string', description: 'Optional full file content (overrides template, max 100KB)' },
              overwrite: { type: 'boolean', description: 'Allow overwriting an existing file (defaults to false)' },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'attach_script',
          description: 'Attach an existing GDScript to a node in a scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              nodePath: { type: 'string', description: 'Node path like root/Player' },
              scriptPath: { type: 'string', description: 'Script path relative to project, e.g. scripts/player.gd' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
          },
        },
        {
          name: 'connect_signal',
          description: 'Connect a signal from one node to a method on another node in a scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file relative to project' },
              sourceNode: { type: 'string', description: 'Emitting node path like root/Button' },
              signalName: { type: 'string', description: 'Signal name, e.g. pressed' },
              targetNode: { type: 'string', description: 'Receiving node path like root/Main' },
              methodName: { type: 'string', description: 'Method name on the target, e.g. _on_button_pressed' },
            },
            required: ['projectPath', 'scenePath', 'sourceNode', 'signalName', 'targetNode', 'methodName'],
          },
        },
        {
          name: 'check_script',
          description: 'Parse a GDScript file with Godot --check-only and return structured errors',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              filePath: { type: 'string', description: 'Script path relative to project' },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'run_tests',
          description: 'Discover test scenes/scripts (*test*.tscn, *test*.gd, GUT) and run them headless with a summary',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              pattern: { type: 'string', description: 'Optional substring filter for test file names' },
              testTimeout: { type: 'number', description: 'Optional per-scene timeout seconds (defaults to 20, max 60)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'export_check',
          description: 'Validate export_presets.cfg and optionally run a real export (doExport=true)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              preset: { type: 'string', description: 'Optional preset name to validate/export (defaults to all presets validation)' },
              doExport: { type: 'boolean', description: 'Actually run godot --export-release (defaults to false, validation only)' },
            },
            required: ['projectPath'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'dotnet_build':
          return await this.handleDotnetBuild(request.params.arguments);
        case 'dotnet_test':
          return await this.handleDotnetTest(request.params.arguments);
        case 'run_project_capture':
          return await this.handleRunProjectCapture(request.params.arguments);
        case 'hook_exec':
          return await this.handleHookExec(request.params.arguments);
        case 'dump_scene':
          return await this.handleDumpScene(request.params.arguments);
        case 'list_assets':
          return await this.handleListAssets(request.params.arguments);
        case 'get_project_settings':
          return await this.handleGetProjectSettings(request.params.arguments);
        case 'set_node_property':
          return await this.handleSetNodeProperty(request.params.arguments);
        case 'remove_node':
          return await this.handleRemoveNode(request.params.arguments);
        case 'rename_node':
          return await this.handleRenameNode(request.params.arguments);
        case 'duplicate_node':
          return await this.handleDuplicateNode(request.params.arguments);
        case 'instance_scene':
          return await this.handleInstanceScene(request.params.arguments);
        case 'create_script':
          return await this.handleCreateScript(request.params.arguments);
        case 'attach_script':
          return await this.handleAttachScript(request.params.arguments);
        case 'connect_signal':
          return await this.handleConnectSignal(request.params.arguments);
        case 'check_script':
          return await this.handleCheckScript(request.params.arguments);
        case 'run_tests':
          return await this.handleRunTests(request.params.arguments);
        case 'export_check':
          return await this.handleExportCheck(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
        this.dropHookConn();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe', env: this.hookEnv(args.projectPath) });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    this.dropHookConn();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse(
        'Invalid rootNodeType',
        ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse(
        'Invalid nodeType',
        ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Resolve the .NET build file for a Godot project: preferred .sln, else single .csproj.
   * @returns The build file name, or an object describing ambiguity/absence.
   */
  private resolveDotnetBuildFile(projectPath: string): { file: string } | { missing: true } | { ambiguous: string[] } {
    let entries: string[];
    try {
      entries = readdirSync(projectPath);
    } catch {
      return { missing: true };
    }

    const isFile = (name: string): boolean => {
      try {
        return statSync(join(projectPath, name)).isFile();
      } catch {
        return false;
      }
    };

    const solutions = entries.filter((e) => e.endsWith('.sln') && isFile(e)).sort();
    if (solutions.length > 0) {
      return { file: solutions[0] };
    }

    const projects = entries.filter((e) => e.endsWith('.csproj') && isFile(e)).sort();
    if (projects.length === 1) {
      return { file: projects[0] };
    }
    if (projects.length > 1) {
      return { ambiguous: projects };
    }
    return { missing: true };
  }

  /**
   * Check that the dotnet CLI is available.
   * @returns Version string, or null when unavailable.
   */
  private async checkDotnet(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('dotnet', ['--version'], { timeout: 30000 });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Parse MSBuild full-path diagnostic lines into structured entries.
   */
  private parseDotnetDiagnostics(output: string): Array<{ file: string; line: number; col: number; severity: string; code: string; message: string }> {
    const diagnostics: Array<{ file: string; line: number; col: number; severity: string; code: string; message: string }> = [];
    const pattern = /^(.*)\((\d+)(?:,(\d+))?\):\s(error|warning)\s([A-Za-z0-9]+):\s(.*)$/;
    for (const rawLine of output.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const match = pattern.exec(line);
      if (match) {
        diagnostics.push({
          file: match[1],
          line: parseInt(match[2], 10),
          col: match[3] !== undefined ? parseInt(match[3], 10) : 0,
          severity: match[4],
          code: match[5],
          message: match[6],
        });
      }
    }
    return diagnostics;
  }

  /**
   * Shared runner for dotnet build/test with structured diagnostics.
   */
  private async runDotnetCommand(
    verb: 'build' | 'test',
    args: any,
    extraArgs: string[]
  ) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    const configuration = args.configuration ?? 'Release';
    if (configuration !== 'Debug' && configuration !== 'Release') {
      return this.createErrorResponse(
        `Invalid configuration: ${configuration}`,
        ['Use "Debug" or "Release"']
      );
    }

    const maxDiagnostics = args.maxDiagnostics ?? 200;

    const resolved = this.resolveDotnetBuildFile(args.projectPath);
    if ('missing' in resolved) {
      return this.createErrorResponse(
        `No .sln or .csproj found in ${args.projectPath}`,
        ['Godot 4.x .NET projects generate a .sln next to project.godot — open the project in the Godot editor once to create it']
      );
    }
    if ('ambiguous' in resolved) {
      return this.createErrorResponse(
        `Multiple .csproj files found and no .sln: ${resolved.ambiguous.join(', ')}`,
        ['Pass one explicitly via the "target" parameter']
      );
    }

    let buildFile = resolved.file;
    if (args.target) {
      if (!this.validatePath(args.target) || args.target.includes('/') || args.target.includes('\\')) {
        return this.createErrorResponse(
          'Invalid target: must be a plain .sln or .csproj file name, not a path',
          ['Pass e.g. "MyGame.sln" without directories']
        );
      }
      buildFile = args.target;
    }

    const dotnetVersion = await this.checkDotnet();
    if (!dotnetVersion) {
      return this.createErrorResponse(
        'The dotnet CLI was not found on PATH',
        ['Install the .NET SDK matching your Godot .NET version', 'Ensure "dotnet --version" works in a terminal']
      );
    }

    const cmdArgs = [verb, join(args.projectPath, buildFile), '-c', configuration, '--nologo', '-v', 'q', ...extraArgs];
    this.logDebug(`Running: dotnet ${cmdArgs.join(' ')}`);

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const result = await execFileAsync('dotnet', cmdArgs, {
        timeout: 280000,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
    } catch (error: unknown) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      stdout = execError.stdout ?? '';
      stderr = execError.stderr ?? '';
      exitCode = execError.code ?? 1;
      if (execError.killed) {
        return this.createErrorResponse(
          `dotnet ${verb} timed out after 280s`,
          ['Build once from a terminal to warm the NuGet/MSBuild caches, then retry']
        );
      }
    }

    const diagnostics = this.parseDotnetDiagnostics(`${stdout}\n${stderr}`);
    // MSBuild often repeats each diagnostic (e.g. across stdout/stderr): dedupe identical entries.
    const seen = new Set<string>();
    const unique = diagnostics.filter((d) => {
      const key = `${d.file}:${d.line}:${d.col}:${d.severity}:${d.code}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const errors = unique.filter((d) => d.severity === 'error').length;
    const warnings = unique.filter((d) => d.severity === 'warning').length;
    const truncated = unique.length > maxDiagnostics;
    const result: any = {
      success: exitCode === 0 && errors === 0,
      verb,
      buildFile,
      configuration,
      dotnetVersion,
      exitCode,
      errors,
      warnings,
      diagnostics: unique.slice(0, maxDiagnostics),
      truncated,
    };
    if (!result.success && unique.length === 0) {
      const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-50).join('\n');
      result.rawTail = tail;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  /**
   * Handle the dotnet_build tool
   * @param args Tool arguments
   */
  private async handleDotnetBuild(args: any) {
    return await this.runDotnetCommand('build', args, ['/p:GenerateFullPaths=true']);
  }

  /**
   * Handle the dotnet_test tool
   * @param args Tool arguments
   */
  private async handleDotnetTest(args: any) {
    const filterArgs: string[] = [];
    const filter = this.normalizeParameters(args).filter;
    if (filter) {
      filterArgs.push('--filter', String(filter));
    }
    return await this.runDotnetCommand('test', args, filterArgs);
  }

  /**
   * Handle the run_project_capture tool (spec 03): headless fixed-duration run with
   * [SIGNAL] marker parsing and an exit verdict. Refuses when a run is already active.
   * @param args Tool arguments
   */
  private async handleRunProjectCapture(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    if (this.activeProcess) {
      return this.createErrorResponse(
        'A Godot project run is already active',
        ['Use stop_project to end it before starting a capture']
      );
    }

    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        return this.createErrorResponse(
          'Could not find a valid Godot executable path',
          [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]
        );
      }
    }

    // Duration cap 280s keeps the tool inside the 300s host timeout (see spec 03).
    const durationSeconds = Math.min(Math.max(Number(args.durationSeconds ?? 30) || 30, 1), 280);
    const failOnError = args.failOnError ?? true;

    const cmdArgs = ['--headless', '--path', args.projectPath];
    if (args.scene && this.validatePath(args.scene)) {
      cmdArgs.push(args.scene);
    }
    this.logDebug(`Capturing Godot run for ${durationSeconds}s: ${args.projectPath}`);

    const startedAt = Date.now();
    const child = spawn(this.godotPath, cmdArgs, { stdio: 'pipe', env: this.hookEnv(args.projectPath) });
    const lines: string[] = [];
    const events: any[] = [];
    let invalidMarkers = 0;
    const MAX_LINES = 2000;
    const ERROR_PATTERN = /(Godot Engine v.*ERROR|SCRIPT ERROR|ERROR:)/;

    const pushLine = (stream: string, text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (lines.length < MAX_LINES) {
        lines.push(`${stream}: ${trimmed}`);
      }
      const marker = /^\[SIGNAL\]\s*(\{.*\})\s*$/.exec(trimmed);
      if (marker) {
        try {
          events.push(JSON.parse(marker[1]));
        } catch {
          invalidMarkers += 1;
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) pushLine('OUT', line);
    });
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) pushLine('ERR', line);
    });
    // Register as the active process so concurrent runs are refused and cleanup kills it.
    this.activeProcess = { process: child, output: [], errors: [] };
    const tracked = this.activeProcess;

    const exit = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited; the exit handler below resolves.
        }
        resolve({ code: null, signal: 'SIGKILL', timedOut: true });
      }, durationSeconds * 1000);
      child.on('exit', (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        pushLine('ERR', `failed to start Godot process: ${err.message}`);
        resolve({ code: 1, signal: null, timedOut: false });
      });
    });

    if (this.activeProcess === tracked) {
      this.activeProcess = null;
      this.dropHookConn();
    }

    let errorCount = 0;
    for (const line of lines) {
      if (ERROR_PATTERN.test(line)) errorCount += 1;
    }

    let verdict: string;
    if (exit.timedOut) {
      verdict = 'timeout';
    } else if ((exit.code ?? 1) !== 0 || exit.signal) {
      verdict = 'crashed';
    } else if (failOnError && errorCount > 0) {
      verdict = 'errors-seen';
    } else {
      verdict = 'clean-exit';
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              verdict,
              exitCode: exit.code,
              signal: exit.signal,
              durationMs: Date.now() - startedAt,
              events,
              invalidMarkers,
              errorCount,
              logTail: lines.slice(-50),
              truncated: lines.length >= MAX_LINES,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Environment for spawning a game run: activates the opt-in signal hook
   * (hook/signal_hook.gd) only when the project contains signal_hook.gd.
   */
  private hookEnv(projectPath: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    try {
      if (existsSync(join(projectPath, 'signal_hook.gd'))) {
        env.SIGNAL_HOOK = '1';
        this.logDebug('signal_hook.gd present: SIGNAL_HOOK=1 for this run');
      }
    } catch {
      // Ignore filesystem errors; run proceeds without the hook.
    }
    return env;
  }

  /**
   * Find the hook TCP port printed by a running game ([SIGNAL-PORT] <port>).
   */
  private findHookPort(): number | null {
    if (!this.activeProcess) return null;
    return parseHookPort(this.activeProcess.output);
  }

  /**
   * Drop the cached hook connection (game exited, port changed, or command failed).
   */
  private dropHookConn(): void {
    if (this.hookConn) {
      try {
        this.hookConn.conn.close();
      } catch {
        // Ignore close errors.
      }
      this.hookConn = null;
    }
  }

  /**
   * Handle the hook_exec tool (spec 04).
   * @param args Tool arguments
   */
  private async handleHookExec(args: any) {
    args = this.normalizeParameters(args);

    const command = String(args.command ?? '');
    if (!['tree', 'read', 'shot', 'quit', 'press', 'stats'].includes(command)) {
      return this.createErrorResponse(
        `Invalid command: ${command || '(missing)'}`,
        ['Use one of: tree, read, shot, quit, press, stats']
      );
    }
    if (command === 'read' && !args.expression) {
      return this.createErrorResponse(
        'The read command requires an expression',
        ['Pass e.g. {"command": "read", "target": ".", "expression": "position"}']
      );
    }
    if (command === 'press' && !args.action) {
      return this.createErrorResponse(
        'The press command requires an action',
        ['Pass e.g. {"command": "press", "action": "jump", "holdMs": 120}']
      );
    }
    if (command === 'press' && !this.validateIdentifier(String(args.action))) {
      return this.createErrorResponse(
        'Invalid action name',
        ['Action must be an InputMap identifier like jump or move_left']
      );
    }

    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot run.',
        ['Use run_project to start the game first, with signal_hook.gd installed (see README)']
      );
    }

    const port = this.findHookPort();
    if (!port) {
      return this.createErrorResponse(
        'The running game has no active signal hook.',
        [
          'Copy hook/signal_hook.gd to the project as res://signal_hook.gd and add it as an autoload',
          'Restart the run via run_project after installing the hook',
        ]
      );
    }

    try {
      if (!this.hookConn || this.hookConn.port !== port) {
        this.dropHookConn();
        this.hookConn = { port, conn: new HookConnection(port) };
      }
      const response = await this.hookConn.conn.request({
        command,
        target: args.target ?? '.',
        expression: args.expression ?? '',
        maxDepth: args.maxDepth ?? 3,
        action: args.action ?? '',
        holdMs: args.holdMs ?? 120,
        includeImage: args.includeImage ?? true,
      });
      if (command === 'quit') this.dropHookConn();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      this.dropHookConn();
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Hook request failed: ${message}`,
        ['The game may have exited — use get_debug_output to check', 'Restart via run_project and retry']
      );
    }
  }

  private requireProject(args: any): { error: any } | { projectFile: string } {
    if (!args.projectPath) {
      return { error: this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory']) };
    }
    if (!this.validatePath(args.projectPath)) {
      return { error: this.createErrorResponse('Invalid project path', ['Provide a valid path without ".."']) };
    }
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return { error: this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file']) };
    }
    return { projectFile };
  }

  private async handleDumpScene(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    if (!args.scenePath || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Valid scenePath is required', ['Pass e.g. "main.tscn" relative to project']);
    }
    const abs = this.resolveInsideProject(args.projectPath, args.scenePath);
    if (!abs || !existsSync(abs)) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Use list_assets to find .tscn files']);
    }
    try {
      const text = (await import('fs')).readFileSync(abs, 'utf8');
      if (text.length > 512 * 1024) {
        return this.createErrorResponse('Scene file too large to dump (>512KB)', ['Split the scene or inspect sub-scenes']);
      }
      const nodes: any[] = [];
      const header = text.split('\n')[0]?.slice(0, 200) ?? '';
      const nodeBlocks = text.match(/\[node[^\]]*\][^\[]*/g) ?? [];
      for (const block of nodeBlocks.slice(0, 500)) {
        const firstLine = block.split('\n')[0] ?? '';
        const name = /name="([^"]+)"/.exec(firstLine)?.[1] ?? '';
        const type = /type="([^"]+)"/.exec(firstLine)?.[1] ?? '';
        const parent = /parent="([^"]*)"/.exec(firstLine)?.[1] ?? null;
        const props: Record<string, string> = {};
        for (const line of block.split('\n').slice(1, 30)) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_\/:]*)\s*=\s*(.+)\s*$/.exec(line.trim());
          if (m) props[m[1]] = m[2].slice(0, 500);
        }
        let fullPath: string;
        if (parent === null) fullPath = 'root';
        else if (parent === '.') fullPath = `root/${name}`;
        else fullPath = `root/${parent}/${name}`;
        nodes.push({ name, type, parent, path: fullPath, properties: props });
        if (nodes.length >= 500) break;
      }
      const truncated = nodeBlocks.length > nodes.length;
      return { content: [{ type: 'text', text: JSON.stringify({ scene: args.scenePath, header, totalBlocks: nodeBlocks.length, nodes, truncated }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to dump scene: ${error?.message || 'Unknown error'}`, ['Verify the .tscn file is readable']);
    }
  }

  private async handleListAssets(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    const subdir = args.subdir ?? '';
    if (subdir && !this.validatePath(subdir)) {
      return this.createErrorResponse('Invalid subdir', ['Provide a path without ".."']);
    }
    const baseAbs = subdir ? this.resolveInsideProject(args.projectPath, subdir) : normalize(args.projectPath);
    if (!baseAbs || !existsSync(baseAbs)) {
      return this.createErrorResponse(`Directory does not exist: ${subdir || args.projectPath}`, ['Use get_project_info to see top-level layout']);
    }
    const extensions = Array.isArray(args.extensions) ? args.extensions.map((e: string) => String(e).toLowerCase().replace(/^\./, '')) : [];
    const limit = Math.min(Math.max(Number(args.limit ?? 200) || 200, 1), 1000);
    const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
    const recursive = args.recursive ?? true;
    const out: Array<{ path: string; size: number; ext: string }> = [];
    let total = 0;
    const walk = (dir: string, rel: string): void => {
      let entries: any[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.godot') || e.name === '.git') continue;
        if (e.name.startsWith('.') && e.isDirectory()) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const absPath = join(dir, e.name);
        if (e.isDirectory()) { if (recursive) walk(absPath, relPath); }
        else if (e.isFile()) {
          const ext = (e.name.split('.').pop() ?? '').toLowerCase();
          if (extensions.length > 0 && !extensions.includes(ext)) continue;
          total += 1;
          if (total > offset && out.length < limit) {
            let size = 0;
            try { size = statSync(absPath).size; } catch { size = 0; }
            out.push({ path: relPath, size, ext });
          }
        }
      }
    };
    walk(baseAbs, subdir);
    return { content: [{ type: 'text', text: JSON.stringify({ total, offset, limit, truncated: total > offset + out.length, assets: out }, null, 2) }] };
  }

  private async handleGetProjectSettings(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    try {
      const fs = await import('fs');
      const text = fs.readFileSync(join(args.projectPath, 'project.godot'), 'utf8');
      if (text.length > 100 * 1024) {
        return this.createErrorResponse('project.godot too large (>100KB)', ['Read it directly from disk']);
      }
      const sections: Record<string, Record<string, string>> = {};
      let current = '';
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith(';')) continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) { current = sec[1]; sections[current] = sections[current] ?? {}; continue; }
        const kv = /^([^=]+)=(.*)$/.exec(line);
        if (kv && current) sections[current][kv[1].trim().slice(0, 200)] = kv[2].trim().slice(0, 1000);
      }
      return { content: [{ type: 'text', text: JSON.stringify({ sections, sectionCount: Object.keys(sections).length }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read settings: ${error?.message || 'Unknown error'}`, ['Verify project.godot is readable']);
    }
  }

  private async runSceneOp(op: string, args: any, required: string[], params: any) {
    args = this.normalizeParameters(args);
    for (const k of required) {
      if (args[k] === undefined || args[k] === '') {
        return this.createErrorResponse('Missing required parameters', [`Provide ${required.join(', ')}`]);
      }
    }
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    if (!this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid scenePath', ['Provide a path without ".."']);
    }
    const sceneAbs = this.resolveInsideProject(args.projectPath, args.scenePath);
    if (!sceneAbs || !existsSync(sceneAbs)) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Use list_assets to find .tscn files']);
    }
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH']);
      }
      const { stdout, stderr } = await this.executeOperation(op, params, args.projectPath);
      if (stderr && /Failed to:/.test(stderr)) {
        return this.createErrorResponse(`Operation ${op} failed: ${stderr.slice(0, 2000)}`, ['Use dump_scene to inspect the scene first']);
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, operation: op, output: stdout.slice(0, 4000) }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Operation ${op} failed: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed']);
    }
  }

  private async handleSetNodeProperty(args: any) {
    args = this.normalizeParameters(args);
    if (args.nodePath && !this.validateSceneNodePath(args.nodePath)) {
      return this.createErrorResponse('Invalid nodePath', ['Use like "root/Player"']);
    }
    if (args.property && !this.validatePropertyName(args.property)) {
      return this.createErrorResponse('Invalid property name', ['Use like "position" or "position:x"']);
    }
    if (args.value === undefined) {
      return this.createErrorResponse('Missing value', ['Provide the new property value']);
    }
    return this.runSceneOp('set_node_property', args, ['projectPath', 'scenePath', 'nodePath', 'property'], { scenePath: args.scenePath, nodePath: args.nodePath, property: args.property, value: args.value });
  }

  private async handleRemoveNode(args: any) {
    args = this.normalizeParameters(args);
    if (!args.nodePath || !this.validateSceneNodePath(args.nodePath) || args.nodePath === 'root') {
      return this.createErrorResponse('Invalid nodePath', ['Use like "root/Player"; cannot remove root']);
    }
    return this.runSceneOp('remove_node', args, ['projectPath', 'scenePath', 'nodePath'], { scenePath: args.scenePath, nodePath: args.nodePath });
  }

  private async handleRenameNode(args: any) {
    args = this.normalizeParameters(args);
    if (!args.nodePath || !this.validateSceneNodePath(args.nodePath)) {
      return this.createErrorResponse('Invalid nodePath', ['Use like "root/Player"']);
    }
    if (!args.newName || !this.validateIdentifier(args.newName)) {
      return this.createErrorResponse('Invalid newName', ['Use an identifier like Player2']);
    }
    return this.runSceneOp('rename_node', args, ['projectPath', 'scenePath', 'nodePath'], { scenePath: args.scenePath, nodePath: args.nodePath, newName: args.newName });
  }

  private async handleDuplicateNode(args: any) {
    args = this.normalizeParameters(args);
    if (!args.nodePath || !this.validateSceneNodePath(args.nodePath) || args.nodePath === 'root') {
      return this.createErrorResponse('Invalid nodePath', ['Use like "root/Player"; cannot duplicate root']);
    }
    if (args.newName && !this.validateIdentifier(args.newName)) {
      return this.createErrorResponse('Invalid newName', ['Use an identifier or omit it']);
    }
    return this.runSceneOp('duplicate_node', args, ['projectPath', 'scenePath', 'nodePath'], { scenePath: args.scenePath, nodePath: args.nodePath, newName: args.newName ?? '' });
  }

  private async handleInstanceScene(args: any) {
    args = this.normalizeParameters(args);
    if (!args.parentNodePath || !this.validateSceneNodePath(args.parentNodePath)) {
      return this.createErrorResponse('Invalid parentNodePath', ['Use like "root" or "root/Level"']);
    }
    if (!args.sourceScene || !this.validatePath(args.sourceScene)) {
      return this.createErrorResponse('Valid sourceScene is required', ['Pass a .tscn path relative to project']);
    }
    if (args.nodeName && !this.validateIdentifier(args.nodeName)) {
      return this.createErrorResponse('Invalid nodeName', ['Use an identifier or omit it']);
    }
    const srcAbs = this.resolveInsideProject(args.projectPath, args.sourceScene);
    if (!srcAbs || !existsSync(srcAbs)) {
      return this.createErrorResponse(`Source scene does not exist: ${args.sourceScene}`, ['Use list_assets to find .tscn files']);
    }
    const targetAbs = this.resolveInsideProject(args.projectPath, args.scenePath);
    if (targetAbs && srcAbs === targetAbs) {
      return this.createErrorResponse('Cannot instance a scene into itself (circular reference)', ['Create a separate component scene, e.g. props/crate.tscn, then instance it']);
    }
    return this.runSceneOp('instance_scene', args, ['projectPath', 'scenePath', 'parentNodePath'], { scenePath: args.scenePath, parentNodePath: args.parentNodePath, sourceScene: args.sourceScene, nodeName: args.nodeName ?? '' });
  }

  private async handleCreateScript(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    if (!args.filePath || !this.validatePath(args.filePath)) {
      return this.createErrorResponse('Valid filePath is required', ['Pass e.g. "scripts/player.gd"']);
    }
    if (!args.filePath.endsWith('.gd')) {
      return this.createErrorResponse('filePath must end with .gd', ['Pass e.g. "scripts/player.gd"']);
    }
    const abs = this.resolveInsideProject(args.projectPath, args.filePath);
    if (!abs) {
      return this.createErrorResponse('Invalid filePath (escapes project)', ['Keep the path inside the project']);
    }
    try {
      const fs = await import('fs');
      if (existsSync(abs) && !args.overwrite) {
        return this.createErrorResponse(`File already exists: ${args.filePath}`, ['Pass overwrite:true to replace it']);
      }
      let content: string = args.content ?? '';
      if (content && content.length > 100 * 1024) {
        return this.createErrorResponse('content too large (>100KB)', ['Split into smaller scripts']);
      }
      if (!content) {
        const templates: Record<string, string> = {
          empty: 'extends RefCounted\n',
          Node: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
          Node2D: 'extends Node2D\n\nfunc _ready() -> void:\n\tpass\n',
          Node3D: 'extends Node3D\n\nfunc _ready() -> void:\n\tpass\n',
          CharacterBody2D: 'extends CharacterBody2D\n\nfunc _physics_process(_delta: float) -> void:\n\tpass\n',
          autoload: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
        };
        const t = String(args.template ?? 'Node');
        if (!(t in templates)) {
          return this.createErrorResponse(`Unknown template: ${t}`, [`Use one of: ${Object.keys(templates).join(', ')}`]);
        }
        content = templates[t];
      }
      fs.mkdirSync(dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file: args.filePath, bytes: content.length }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create script: ${error?.message || 'Unknown error'}`, ['Verify write permissions']);
    }
  }

  private async handleAttachScript(args: any) {
    args = this.normalizeParameters(args);
    if (!args.nodePath || !this.validateSceneNodePath(args.nodePath)) {
      return this.createErrorResponse('Invalid nodePath', ['Use like "root/Player"']);
    }
    if (!args.scriptPath || !this.validatePath(args.scriptPath) || !args.scriptPath.endsWith('.gd')) {
      return this.createErrorResponse('Valid scriptPath is required', ['Pass e.g. "scripts/player.gd"']);
    }
    const scriptAbs = this.resolveInsideProject(args.projectPath, args.scriptPath);
    if (!scriptAbs || !existsSync(scriptAbs)) {
      return this.createErrorResponse(`Script does not exist: ${args.scriptPath}`, ['Use create_script first']);
    }
    return this.runSceneOp('attach_script', args, ['projectPath', 'scenePath', 'nodePath'], { scenePath: args.scenePath, nodePath: args.nodePath, scriptPath: args.scriptPath });
  }

  private async handleConnectSignal(args: any) {
    args = this.normalizeParameters(args);
    for (const [k, v] of [['sourceNode', args.sourceNode], ['targetNode', args.targetNode]] as Array<[string, string]>) {
      if (!v || !this.validateSceneNodePath(v)) {
        return this.createErrorResponse(`Invalid ${k}`, ['Use like "root/Button"']);
      }
    }
    if (!args.signalName || !this.validateIdentifier(args.signalName)) {
      return this.createErrorResponse('Invalid signalName', ['Use an identifier like pressed']);
    }
    if (!args.methodName || !this.validateIdentifier(args.methodName)) {
      return this.createErrorResponse('Invalid methodName', ['Use an identifier like _on_pressed']);
    }
    const req2 = this.requireProject(args);
    if ('error' in req2) return req2.error;
    if (!this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid scenePath', ['Provide a path without ".."']);
    }
    const sceneAbs2 = this.resolveInsideProject(args.projectPath, args.scenePath);
    if (!sceneAbs2 || !existsSync(sceneAbs2)) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Use list_assets to find .tscn files']);
    }
    // TS-side edit: PackedScene.pack() does not reliably persist runtime connect() calls,
    // so append a [connection] block directly (validated, no arbitrary content).
    try {
      const fs2 = await import('fs');
      const text: string = fs2.readFileSync(sceneAbs2, 'utf8');
      const toTscn = (p: string): string => {
        if (p === 'root') return '.';
        return p.replace(/^root\//, '');
      };
      const from = toTscn(args.sourceNode);
      const to = toTscn(args.targetNode);
      const line = `[connection signal="${args.signalName}" from="${from}" to="${to}" method="${args.methodName}"]`;
      if (text.includes(line)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, alreadyConnected: true }, null, 2) }] };
      }
      if (!text.includes(`name="${args.sourceNode === 'root' ? '' : args.sourceNode.split('/').pop()}"`) && args.sourceNode !== 'root') {
        // Soft check only; node names may repeat. dump_scene is authoritative.
      }
      const next = text.replace(/\s*$/, '') + '\n\n' + line + '\n';
      if (next.length > 512 * 1024) {
        return this.createErrorResponse('Scene file too large to edit safely', ['Split the scene']);
      }
      fs2.writeFileSync(sceneAbs2, next);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, connection: line }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`connect_signal failed: ${error?.message || 'Unknown error'}`, ['Verify write permissions']);
    }
  }

  private async handleCheckScript(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    if (!args.filePath || !this.validatePath(args.filePath)) {
      return this.createErrorResponse('Valid filePath is required', ['Pass a .gd path relative to project']);
    }
    const abs = this.resolveInsideProject(args.projectPath, args.filePath);
    if (!abs || !existsSync(abs)) {
      return this.createErrorResponse(`Script does not exist: ${args.filePath}`, ['Use list_assets to find .gd files']);
    }
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH']);
      }
      const resPath = 'res://' + args.filePath.replace(/^res:\/\//, '').replace(/^\/+/, '');
      let stdout = '';
      let stderr = '';
      try {
        const r = await execFileAsync(this.godotPath, ['--headless', '--path', args.projectPath, '--check-only', '--script', resPath], { timeout: 60000 });
        stdout = r.stdout ?? '';
        stderr = r.stderr ?? '';
      } catch (e: any) {
        stdout = e.stdout ?? '';
        stderr = e.stderr ?? '';
      }
      const combined = `${stdout}\n${stderr}`;
      const errors: Array<{ file: string; line: number; message: string }> = [];
      for (const line of combined.split('\n')) {
        const m = /(SCRIPT ERROR|ERROR|Parse Error)[^:]*:\s*(.*)/i.exec(line);
        if (m) errors.push({ file: args.filePath, line: 0, message: line.trim().slice(0, 1000) });
        if (errors.length >= 50) break;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: errors.length === 0, file: args.filePath, errors, truncated: errors.length >= 50, logTail: combined.trim().split('\n').slice(-20) }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`check_script failed: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed']);
    }
  }

  private async handleRunTests(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    const pattern = args.pattern ? String(args.pattern).toLowerCase() : '';
    const perScene = Math.min(Math.max(Number(args.testTimeout ?? 20) || 20, 5), 60);
    const found: string[] = [];
    const walk = (dir: string, rel: string): void => {
      if (found.length >= 200) return;
      let entries: any[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === '.godot' || e.name === '.git' || e.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const absPath = join(dir, e.name);
        if (e.isDirectory()) walk(absPath, relPath);
        else if (e.isFile()) {
          const low = e.name.toLowerCase();
          const isTest = low.includes('test') && (low.endsWith('.tscn') || low.endsWith('.gd'));
          if (isTest && (!pattern || low.includes(pattern))) found.push(relPath);
        }
      }
    };
    walk(args.projectPath, '');
    const gutPresent = existsSync(join(args.projectPath, 'addons', 'gut', 'gut_cmdln.gd'));
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH']);
    }
    const results: any[] = [];
    const scenes = found.filter((f) => f.endsWith('.tscn')).slice(0, 5);
    for (const scene of scenes) {
      try {
        const child = spawn(this.godotPath, ['--headless', '--path', args.projectPath, scene, '--quit-after', '60'], { stdio: 'pipe' });
        const chunks: string[] = [];
        child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
        child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
        const code: number | null = await new Promise((resolve) => {
          const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } resolve(124); }, perScene * 1000);
          child.on('exit', (c: number | null) => { clearTimeout(t); resolve(c ?? 1); });
          child.on('error', () => { clearTimeout(t); resolve(1); });
        });
        const tail = chunks.join('').split('\n').slice(-20);
        results.push({ file: scene, exitCode: code, success: code === 0, logTail: tail });
      } catch (e: any) {
        results.push({ file: scene, exitCode: 1, success: false, error: e?.message });
      }
    }
    const scripts = found.filter((f) => f.endsWith('.gd')).slice(0, 20);
    return { content: [{ type: 'text', text: JSON.stringify({ gutPresent, totalFound: found.length, truncated: found.length >= 200, scenesRun: results, scriptTests: scripts, summary: `${results.filter((r) => r.success).length}/${results.length} scenes passed` }, null, 2) }] };
  }

  private async handleExportCheck(args: any) {
    args = this.normalizeParameters(args);
    const req = this.requireProject(args);
    if ('error' in req) return req.error;
    const cfgPath = join(args.projectPath, 'export_presets.cfg');
    if (!existsSync(cfgPath)) {
      return this.createErrorResponse('No export_presets.cfg found', ['Configure an export preset in the Godot editor first']);
    }
    try {
      const fs = await import('fs');
      const text = fs.readFileSync(cfgPath, 'utf8');
      const presets: Array<{ name: string; platform: string; exportPath: string }> = [];
      let cur: any = null;
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        const sec = /^\[preset\.\d+\]$/.exec(line);
        if (sec) { if (cur?.name) presets.push(cur); cur = { name: '', platform: '', exportPath: '' }; continue; }
        if (!cur) continue;
        const kv = /^([^=]+)=(.*)$/.exec(line);
        if (!kv) continue;
        const k = kv[1].trim();
        let v = kv[2].trim().replace(/^"|"$/g, '');
        if (k === 'name') cur.name = v;
        if (k === 'platform') cur.platform = v;
        if (k === 'export_path') cur.exportPath = v;
      }
      if (cur?.name) presets.push(cur);
      const wanted = args.preset ? presets.filter((p) => p.name === args.preset) : presets;
      if (args.preset && wanted.length === 0) {
        return this.createErrorResponse(`Preset not found: ${args.preset}`, [`Available: ${presets.map((p) => p.name).join(', ') || '(none)'}`]);
      }
      if (!args.doExport) {
        return { content: [{ type: 'text', text: JSON.stringify({ mode: 'validation-only', presets, checked: wanted.map((p) => ({ name: p.name, platform: p.platform, exportPath: p.exportPath })) }, null, 2) }] };
      }
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH']);
      }
      const target = wanted[0];
      if (!target) return this.createErrorResponse('No presets to export', ['Add an export preset first']);
      try {
        const r = await execFileAsync(this.godotPath, ['--headless', '--path', args.projectPath, '--export-release', target.name, target.exportPath], { timeout: 280000, maxBuffer: 16 * 1024 * 1024 });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, preset: target.name, stdout: (r.stdout ?? '').slice(-2000), stderr: (r.stderr ?? '').slice(-2000) }, null, 2) }] };
      } catch (e: any) {
        return this.createErrorResponse(`Export failed for preset ${target.name}: ${(e.stderr ?? e.message ?? '').toString().slice(0, 2000)}`, ['Open the project in the editor and run the export once manually']);
      }
    } catch (error: any) {
      return this.createErrorResponse(`export_check failed: ${error?.message || 'Unknown error'}`, ['Verify export_presets.cfg is readable']);
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server (or the multi-host installer when `setup` is passed)
const server = new GodotServer();
const cliArgs = process.argv.slice(2);
if (cliArgs.includes('setup')) {
  runSetup(
    cliArgs.filter((a) => a !== 'setup'),
    __filename,
    (override?: string) => server.resolveGodotPath(override)
  ).then((code) => process.exit(code));
} else {
  server.run().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to run server:', errorMessage);
    process.exit(1);
  });
}
