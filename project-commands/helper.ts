import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap } from "yaml";

export const MAX_FILE_BYTES = 1024 * 1024;
export const CONFIG_NAME = "tern-commands.yaml";
export const DEFAULT_SHELL = process.platform === "darwin" ? "zsh" : "sh";
const COMMAND_FIELDS: Record<string, true> = { id: true, name: true, enabled: true, execution: true, cwd: true, shell: true, profiles: true, env: true, run: true };
const CONFIG_FIELDS: Record<string, true> = { version: true, commands: true };
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCK_ATTEMPTS = 80;
const LOCK_WAIT_MS = 25;

export interface Command {
  id: string;
  name: string;
  enabled: boolean;
  execution: "background" | "tab";
  cwd: string;
  shell: string;
  profiles: boolean;
  env: Record<string, string>;
  run: string;
}
export interface Snapshot {
  root: string;
  path: string;
  revision: string;
  commands: Command[];
}
export interface SaveRequest {
  root: string;
  revision: string;
  originalId?: string;
  command: unknown;
}
export interface ToggleRequest {
  root: string;
  revision: string;
  id: string;
  enabled: boolean;
}
export interface RemoveRequest {
  root: string;
  revision: string;
  id: string;
}
export interface DeletedCommand {
  source: string;
  index: number;
}
export interface RemoveResult {
  snapshot: Snapshot;
  deleted: DeletedCommand;
}
export interface RestoreRequest {
  root: string;
  revision: string;
  deleted: unknown;
}
export interface PreparedCommand {
  root: string;
  id: string;
  cwd: string;
  name: string;
  execution: Command["execution"];
}
export interface RunResult {
  name: string;
  status: number;
  logPath?: string;
}
interface State {
  snapshot: Snapshot;
  document: Document;
  mode: number;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value instanceof Map) {
    for (const key of value.keys()) {
      if (typeof key !== "string") throw new Error(`${label} keys must be strings`);
    }
    return Object.fromEntries(value);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain mapping`);
  }
  return value as Record<string, unknown>;
}

function allowedFields(value: Record<string, unknown>, fields: Record<string, true>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unsupported ${label} field: ${key}`);
  }
}

function text(value: unknown, label: string, allowBlank = false): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowBlank && !value.trim())) {
    throw new Error(`${label} must be ${allowBlank ? "a" : "a nonblank"} string without NUL`);
  }
  return value;
}

function commandId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error("Command id must match ^[a-z][a-z0-9-]*$");
  }
  return value;
}

function optional(value: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

function staysInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function validateCommand(input: unknown): Command {
  const value = record(input, "Command");
  allowedFields(value, COMMAND_FIELDS, "command");
  const id = commandId(value.id);
  const name = text(value.name, "Command name");
  const run = text(value.run, "Command run");
  const enabled = optional(value, "enabled", true);
  if (typeof enabled !== "boolean") throw new Error("Command enabled must be a boolean");
  const execution = optional(value, "execution", "background");
  if (execution !== "background" && execution !== "tab") {
    throw new Error("Command execution must be background or tab");
  }
  const cwd = text(optional(value, "cwd", "."), "Command cwd");
  const normalizedCwd = normalize(cwd);
  if (isAbsolute(cwd) || normalizedCwd === ".." || normalizedCwd.startsWith(`..${sep}`)) {
    throw new Error("Command cwd must be relative and remain inside the project root");
  }
  const shell = text(optional(value, "shell", DEFAULT_SHELL), "Command shell");
  if (!isAbsolute(shell) && (shell.includes(sep) || shell === "." || shell === "..")) {
    throw new Error("Command shell must be an executable name or an absolute path");
  }
  const profiles = optional(value, "profiles", true);
  if (typeof profiles !== "boolean") throw new Error("Command profiles must be a boolean");
  const envInput = record(optional(value, "env", {}), "Command env");
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(envInput)) {
    if (!ENV_PATTERN.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    entries.push([key, text(value, `Environment variable ${key}`, true)]);
  }
  return { id, name, enabled, execution, cwd, shell, profiles, env: Object.fromEntries(entries), run };
}

async function projectRoot(value: unknown): Promise<string> {
  const root = text(value, "Project root");
  if (!isAbsolute(root)) throw new Error("Project root must be an absolute path");
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Project root must be a directory");
  return canonical;
}

function configPath(root: string): string {
  return join(root, ".omp", CONFIG_NAME);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function discoverRoot(cwd: string): Promise<string> {
  const start = await projectRoot(cwd);
  let current = start;
  for (;;) {
    if (await exists(configPath(current))) return current;
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseConfig(source: string): { document: Document; commands: Command[] } {
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    merge: false,
    uniqueKeys: true,
    resolveKnownTags: false,
    logLevel: "silent",
  });
  if (document.errors.length || document.warnings.length) {
    const error = document.errors[0] ?? document.warnings[0];
    throw new Error(`Invalid YAML: ${error.message}`);
  }
  // Aliases share editable nodes; rejecting them prevents one edit changing other commands.
  visit(document, {
    Alias() { throw new Error("YAML aliases are not supported in command configuration"); },
  });
  const value = record(document.toJS({ mapAsMap: true, maxAliasCount: 0 }), "Configuration");
  allowedFields(value, CONFIG_FIELDS, "configuration");
  if (optional(value, "version", 1) !== 1) throw new Error("Unsupported configuration version; expected version: 1");
  if (!Array.isArray(value.commands)) throw new Error("Configuration commands must be a sequence");
  const commands = value.commands.map(validateCommand);
  const ids = new Set<string>();
  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
    ids.add(command.id);
  }
  return { document, commands };
}

async function readState(root: string): Promise<State> {
  const path = configPath(root);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return {
      snapshot: { root, path, revision: "missing", commands: [] },
      document: parseDocument("version: 1\ncommands: []\n"),
      mode: 0o600,
    };
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Command configuration must be a regular file, not a symlink or directory");
    if (info.size > MAX_FILE_BYTES) throw new Error("Command configuration exceeds the 1 MiB limit");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error("Command configuration exceeds the 1 MiB limit");
    const bytes = buffer.subarray(0, length);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const { document, commands } = parseConfig(source);
    return {
      snapshot: { root, path, revision: revision(bytes), commands },
      document,
      mode: info.mode & 0o777,
    };
  } finally {
    await file.close();
  }
}

export async function load(cwd: string): Promise<Snapshot> {
  return (await readState(await discoverRoot(cwd))).snapshot;
}

function checkRevision(expected: unknown, actual: string): void {
  if (typeof expected !== "string" || expected !== actual) {
    throw new Error("Configuration changed on disk. Reload before saving; no changes were written.");
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (attempt + 1 === LOCK_ATTEMPTS) {
        throw new Error(`Configuration is locked: ${lockPath}. Close the other editor or remove a leftover lock manually after checking that no save is running.`);
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
  if (!lock) throw new Error(`Cannot acquire configuration lock: ${lockPath}`);
  try {
    await lock.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function writeState(state: State): Promise<Snapshot> {
  const { document, snapshot } = state;
  document.set("version", 1);
  const source = document.toString({ lineWidth: 0 });
  const bytes = Buffer.from(source);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Command configuration exceeds the 1 MiB limit");
  const temporary = `${snapshot.path}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const file = await open(temporary, "wx", state.mode);
    temporaryCreated = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Also catch hand edits made while the temporary file was being written.
    checkRevision(snapshot.revision, (await readState(snapshot.root)).snapshot.revision);
    await rename(temporary, snapshot.path);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporary);
  }
  return { ...snapshot, revision: revision(bytes) };
}

function commandSequence(document: Document) {
  const sequence = document.get("commands");
  if (!isSeq(sequence)) throw new Error("Configuration commands must be a sequence");
  return sequence;
}

function updateCommand(document: Document, node: YAMLMap, command: Command): void {
  for (const key of ["id", "name", "enabled", "execution", "cwd", "shell", "profiles", "run"] as const) {
    node.set(key, command[key]);
  }
  const run = node.get("run", true);
  if (isScalar(run) && command.run.includes("\n")) run.type = "BLOCK_LITERAL";
  const env = node.get("env");
  if (isMap(env)) {
    for (const pair of [...env.items]) {
      if (isScalar(pair.key) && !Object.hasOwn(command.env, String(pair.key.value))) env.delete(pair.key.value);
    }
    for (const [key, value] of Object.entries(command.env)) env.set(key, value);
  } else {
    node.set("env", document.createNode(command.env));
  }
}

export async function save(request: SaveRequest): Promise<Snapshot> {
  const root = await projectRoot(request.root);
  const command = validateCommand(request.command);
  const originalId = request.originalId === undefined ? undefined : commandId(request.originalId);
  if (typeof request.revision !== "string") throw new Error("Save requires a configuration revision");
  await mkdir(dirname(configPath(root)), { recursive: true, mode: 0o700 });
  return withLock(configPath(root), async () => {
    const state = await readState(root);
    checkRevision(request.revision, state.snapshot.revision);
    const commands = state.snapshot.commands;
    const index = originalId === undefined ? -1 : commands.findIndex(item => item.id === originalId);
    if (originalId !== undefined && index < 0) throw new Error(`Command not found: ${originalId}`);
    if (commands.some((item, other) => item.id === command.id && other !== index)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    const sequence = commandSequence(state.document);
    if (index < 0) {
      const node = state.document.createNode(command);
      if (!isMap(node)) throw new Error("Command must be a mapping");
      updateCommand(state.document, node, command);
      if (sequence.items.length === 0) sequence.flow = false;
      sequence.add(node);
      commands.push(command);
    } else {
      const node = sequence.items[index];
      if (!isMap(node)) throw new Error("Command must be a mapping");
      updateCommand(state.document, node, command);
      commands[index] = command;
    }
    return writeState(state);
  });
}

export async function toggle(request: ToggleRequest): Promise<Snapshot> {
  const root = await projectRoot(request.root);
  const id = commandId(request.id);
  if (typeof request.enabled !== "boolean") throw new Error("Command enabled must be a boolean");
  if (typeof request.revision !== "string") throw new Error("Toggle requires a configuration revision");
  if (!await exists(configPath(root))) throw new Error(`Command not found: ${id}`);
  return withLock(configPath(root), async () => {
    const state = await readState(root);
    checkRevision(request.revision, state.snapshot.revision);
    const index = state.snapshot.commands.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Command not found: ${id}`);
    const node = commandSequence(state.document).items[index];
    if (!isMap(node)) throw new Error("Command must be a mapping");
    node.set("enabled", request.enabled);
    state.snapshot.commands[index] = { ...state.snapshot.commands[index], enabled: request.enabled };
    return writeState(state);
  });
}

export async function remove(request: RemoveRequest): Promise<RemoveResult> {
  const root = await projectRoot(request.root);
  const id = commandId(request.id);
  if (typeof request.revision !== "string") throw new Error("Remove requires a configuration revision");
  if (!await exists(configPath(root))) {
    checkRevision(request.revision, "missing");
    throw new Error(`Command not found: ${id}`);
  }
  return withLock(configPath(root), async () => {
    const state = await readState(root);
    checkRevision(request.revision, state.snapshot.revision);
    const index = state.snapshot.commands.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Command not found: ${id}`);
    const sequence = commandSequence(state.document);
    const node = sequence.items[index];
    if (!isMap(node)) throw new Error("Command must be a mapping");
    // Only the removed node belongs to Undo; document and sequence comments stay on disk.
    const receipt = parseDocument("version: 1\ncommands: []\n");
    const receiptSequence = commandSequence(receipt);
    receiptSequence.flow = false;
    receiptSequence.add(node);
    const source = receipt.toString({ lineWidth: 0 });
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Deleted command source exceeds the 1 MiB limit");
    sequence.items.splice(index, 1);
    state.snapshot.commands.splice(index, 1);
    return { snapshot: await writeState(state), deleted: { source, index } };
  });
}

export async function restore(request: RestoreRequest): Promise<Snapshot> {
  const root = await projectRoot(request.root);
  if (typeof request.revision !== "string") throw new Error("Restore requires a configuration revision");
  const deleted = record(request.deleted, "Deleted command");
  allowedFields(deleted, { source: true, index: true }, "deleted command");
  if (typeof deleted.index !== "number" || !Number.isSafeInteger(deleted.index) || deleted.index < 0) {
    throw new Error("Deleted command index must be a nonnegative safe integer");
  }
  const originalIndex = deleted.index;
  const source = text(deleted.source, "Deleted command source");
  if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Deleted command source exceeds the 1 MiB limit");
  const receipt = parseConfig(source);
  if (receipt.commands.length !== 1) throw new Error("Deleted command source must contain exactly one command");
  const command = receipt.commands[0];
  const receiptSequence = commandSequence(receipt.document);
  const node = receiptSequence.items[0];
  if (!isMap(node)) throw new Error("Command must be a mapping");
  // Parsing a standalone sequence moves its first item's leading comments onto the sequence.
  if (receiptSequence.commentBefore) {
    node.commentBefore = [receiptSequence.commentBefore, node.commentBefore].filter(Boolean).join("\n");
  }
  await mkdir(dirname(configPath(root)), { recursive: true, mode: 0o700 });
  return withLock(configPath(root), async () => {
    const state = await readState(root);
    checkRevision(request.revision, state.snapshot.revision);
    const commands = state.snapshot.commands;
    if (commands.some(item => item.id === command.id)) throw new Error(`Duplicate command id: ${command.id}`);
    const index = Math.min(originalIndex, commands.length);
    const sequence = commandSequence(state.document);
    if (sequence.items.length === 0) sequence.flow = false;
    sequence.items.splice(index, 0, node);
    commands.splice(index, 0, command);
    return writeState(state);
  });
}

interface ResolvedShell {
  path: string;
  name: string;
}

async function resolveShell(shell: string): Promise<ResolvedShell> {
  const directories = process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/sbin", "/usr/local/sbin", "/usr/sbin", "/sbin"]
    : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  const candidates = isAbsolute(shell)
    ? [shell]
    : [...new Set([...(process.env.PATH?.split(delimiter) ?? []), ...directories])].map(directory => resolve(directory, shell));
  for (const path of candidates) {
    try {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      // Preserve the invocation name (e.g. sh -> bash), but choose flags by the actual executable.
      return { path, name: basename(canonical) };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].some(code => hasCode(error, code))) throw error;
    }
  }
  throw new Error(`Shell executable not found or not executable: ${shell}`);
}

async function runnable(rootInput: string, idInput: string): Promise<{ root: string; cwd: string; command: Command; shell: ResolvedShell }> {
  const root = await projectRoot(rootInput);
  const id = commandId(idInput);
  const { commands } = (await readState(root)).snapshot;
  const command = commands.find(item => item.id === id);
  if (!command) throw new Error(`Command not found: ${id}`);
  if (!command.enabled) throw new Error(`Command is disabled: ${id}`);
  const cwd = await realpath(resolve(root, command.cwd));
  if (!staysInside(root, cwd)) throw new Error("Command cwd resolves outside the project root");
  if (!(await stat(cwd)).isDirectory()) throw new Error("Command cwd must resolve to a directory");
  const shell = await resolveShell(command.shell);
  return { root, cwd, command, shell };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function prepare(root: string, id: string): Promise<PreparedCommand> {
  const runnableCommand = await runnable(root, id);
  const { command } = runnableCommand;
  return { root: runnableCommand.root, id: command.id, cwd: runnableCommand.cwd, name: command.name, execution: command.execution };
}

function startupEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, HISTFILE: "/dev/null" };
  for (const key of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"]) delete env[key];
  return env;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function executeCommand(cwd: string, command: Command, shell: ResolvedShell, logFd?: number): Promise<number> {
  const fish = shell.name === "fish";
  const flags = fish
    ? ["--private", command.profiles ? "--login" : "--no-config"]
    : command.profiles ? ["-l"] : shell.name === "zsh" ? ["-f"] : shell.name === "bash" ? ["--noprofile", "--norc"] : [];
  // Startup files can change cwd/env; restore literal command settings after startup.
  const setup = [fish
    ? `builtin cd -- ${fishQuote(cwd)}; or exit $status`
    : `${shell.name === "zsh" ? "builtin" : "command"} cd ${shellQuote(cwd)} || exit $?`];
  for (const [key, value] of Object.entries(command.env)) {
    setup.push(fish
      ? `builtin set --global --export -- ${key} ${fishQuote(value)}; or exit $status`
      : `export ${key}=${shellQuote(value)} || exit $?`);
  }
  const child = Bun.spawn([shell.path, ...flags, "-c", `${setup.join("\n")}\n${command.run}`], {
    cwd,
    env: startupEnvironment(),
    stdin: logFd === undefined ? "inherit" : "ignore",
    stdout: logFd ?? "inherit",
    stderr: logFd ?? "inherit",
  });
  return child.exited;
}

export async function execute(root: string, id: string): Promise<number> {
  const { cwd, command, shell } = await runnable(root, id);
  return executeCommand(cwd, command, shell);
}

export async function run(root: string, id: string): Promise<RunResult> {
  const { cwd, command, shell } = await runnable(root, id);
  const directory = await mkdtemp(join(tmpdir(), "tern-project-commands-"));
  const logPath = join(directory, "output.log");
  let retainLog = false;
  try {
    const log = await open(logPath, "wx", 0o600);
    try {
      // One shared descriptor preserves stdout/stderr writes without pipe-size limits.
      retainLog = true;
      const status = await executeCommand(cwd, command, shell, log.fd);
      retainLog = status !== 0;
      return status === 0 ? { name: command.name, status } : { name: command.name, status, logPath };
    } catch (error) {
      await log.write(`Command execution failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return { name: command.name, status: 1, logPath };
    } finally {
      await log.close();
    }
  } finally {
    if (!retainLog) await rm(directory, { recursive: true, force: true });
  }
}

export async function terminal(root: string, id: string): Promise<number> {
  const { cwd, command, shell } = await runnable(root, id);
  const status = await executeCommand(cwd, command, shell);
  process.stdout.write(`\n[Project Commands] Exit status: ${status}\nPress Enter to finish.\n`);
  for await (const chunk of Bun.stdin.stream()) {
    if (chunk.includes(10) || chunk.includes(13)) break;
  }
  return status;
}

export async function rpc(input: unknown): Promise<Snapshot | RemoveResult | PreparedCommand | RunResult> {
  const request = record(input, "Request");
  switch (request.op) {
    case "load": return load(text(request.cwd, "Request cwd"));
    case "save": return save({ root: request.root as string, revision: request.revision as string, originalId: request.originalId as string | undefined, command: request.command });
    case "toggle": return toggle({ root: request.root as string, revision: request.revision as string, id: request.id as string, enabled: request.enabled as boolean });
    case "remove": return remove({ root: request.root as string, revision: request.revision as string, id: request.id as string });
    case "restore": return restore({ root: request.root as string, revision: request.revision as string, deleted: request.deleted });
    case "prepare": return prepare(text(request.root, "Project root"), text(request.id, "Command id"));
    case "run": return run(text(request.root, "Project root"), text(request.id, "Command id"));
    default: throw new Error("Unknown request operation");
  }
}

async function readRequest(): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of Bun.stdin.stream()) {
    length += chunk.length;
    if (length > MAX_FILE_BYTES * 2) throw new Error("Request exceeds the 2 MiB limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (import.meta.main) {
  try {
    const [mode, root, id, ...extra] = process.argv.slice(2);
    if (mode === "rpc" && root === undefined) {
      const result = await rpc(await readRequest());
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (mode === "execute" && root !== undefined && id !== undefined && extra.length === 0) {
      process.exitCode = await execute(root, id);
    } else if (mode === "terminal" && root !== undefined && id !== undefined && extra.length === 0) {
      process.exitCode = await terminal(root, id);
    } else {
      throw new Error("Usage: bun helper.ts rpc | bun helper.ts execute <absolute-root> <command-id> | bun helper.ts terminal <absolute-root> <command-id>");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
