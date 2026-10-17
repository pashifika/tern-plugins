import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { CONFIG_NAME, DEFAULT_SHELL, MAX_FILE_BYTES, discoverRoot, execute, load, prepare, save, shellQuote, toggle, validateCommand, type Command } from "./helper";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function project(git = true): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tern-project-commands-")));
  temporaryRoots.push(root);
  if (git) await mkdir(join(root, ".git"));
  return root;
}

async function config(root: string, source: string): Promise<string> {
  const path = join(root, ".omp", CONFIG_NAME);
  await mkdir(join(root, ".omp"), { recursive: true });
  await writeFile(path, source);
  return path;
}

function command(overrides: Partial<Command> = {}): Command {
  return { id: "build", name: "Build", enabled: true, cwd: ".", shell: "/bin/sh", env: {}, run: "printf 'hello\\n'", ...overrides };
}

const COMMENTED_CONFIG = `# Project commands: keep this header
version: 1 # schema comment
commands:
  # First command comment
  - id: build
    name: Build # name comment
    enabled: true # enabled comment
    cwd: .
    shell: /bin/sh
    env:
      TOKEN: original # token comment
      UNCHANGED: keep # untouched env comment
    run: | # script comment
      printf 'original\\n'

  # Second command comment
  - id: test
    name: Test # other command comment
    enabled: true
    run: "printf 'test\\n'"
# End comment
`;

test("loading missing configuration never creates directories; saving explicitly creates version 1", async () => {
  const root = await project();
  const initial = await load(root);
  expect(initial).toEqual({ root, path: join(root, ".omp", CONFIG_NAME), revision: "missing", commands: [] });
  expect(await readdir(root)).toEqual([".git"]);
  const saved = await save({ root, revision: initial.revision, command: command() });
  expect(saved.commands).toEqual([command()]);
  expect(saved.revision).toMatch(/^sha256:/);
  expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  expect(parseDocument(await readFile(saved.path, "utf8")).toJS()).toEqual({ version: 1, commands: [command()] });
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
  expect(await load(root)).toEqual(saved);
});

test("create, edit, rename and toggle preserve unrelated commands and comments", async () => {
  const root = await project();
  const path = await config(root, COMMENTED_CONFIG);
  let snapshot = await load(root);
  const untouched = snapshot.commands[1];
  snapshot = await save({ root, revision: snapshot.revision, command: command({ id: "deploy", name: "Deploy", run: "echo deployed" }) });
  const edited = command({ id: "compile", name: "ビルド 🚀", env: { TOKEN: "new '$value\n日本語🚀", UNCHANGED: "keep", ADDED: "" }, run: "printf '%s\\n' '日本語🚀'\nprintf '%s' \"$TOKEN\"\n" });
  snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: edited });
  expect(snapshot.commands[0]).toEqual(edited);
  expect(snapshot.commands[1]).toEqual(untouched);
  expect(snapshot.commands[2].id).toBe("deploy");
  snapshot = await toggle({ root, revision: snapshot.revision, id: "compile", enabled: false });
  expect(snapshot.commands[0].enabled).toBe(false);
  expect(snapshot.commands).toHaveLength(3);
  expect(snapshot.commands[1]).toEqual(untouched);
  const source = await readFile(path, "utf8");
  for (const comment of ["Project commands: keep this header", "schema comment", "First command comment", "name comment", "enabled comment", "token comment", "untouched env comment", "script comment", "Second command comment", "other command comment", "End comment"]) {
    expect(source).toContain(`# ${comment}`);
  }
  expect(await load(root)).toEqual(snapshot);
});

test("version omission and optional command fields use defaults, and save writes version 1", async () => {
  const root = await project();
  const path = await config(root, "# handwritten\ncommands:\n  - id: build\n    name: Build\n    run: echo hello\n");
  const initial = await load(root);
  expect(initial.commands[0]).toEqual(command({ shell: DEFAULT_SHELL, run: "echo hello" }));
  const updated = await toggle({ root, revision: initial.revision, id: "build", enabled: false });
  expect(updated.commands[0].enabled).toBe(false);
  const document = parseDocument(await readFile(path, "utf8"));
  expect(document.get("version")).toBe(1);
  expect(await readFile(path, "utf8")).toContain("# handwritten");
});

test("malformed YAML refuses load and save without replacing the original bytes", async () => {
  const root = await project();
  const initial = await load(root);
  const source = "version: 1\ncommands: [unterminated\n";
  const path = await config(root, source);
  await expect(load(root)).rejects.toThrow("Invalid YAML");
  await expect(save({ root, revision: initial.revision, command: command() })).rejects.toThrow("Invalid YAML");
  expect(await readFile(path, "utf8")).toBe(source);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test("stale revisions never overwrite external edits or toggles", async () => {
  const root = await project();
  const initial = await load(root);
  const created = await save({ root, revision: initial.revision, command: command() });
  const external = `${await readFile(created.path, "utf8")}# external change\n`;
  await writeFile(created.path, external);
  await expect(save({ root, revision: created.revision, originalId: "build", command: command({ name: "Changed" }) })).rejects.toThrow("changed on disk");
  await expect(toggle({ root, revision: created.revision, id: "build", enabled: false })).rejects.toThrow("changed on disk");
  expect(await readFile(created.path, "utf8")).toBe(external);
  await expect(save({ root, revision: initial.revision, command: command({ id: "other" }) })).rejects.toThrow("changed on disk");
  expect(await readFile(created.path, "utf8")).toBe(external);
});

test("simultaneous writers with one revision cannot both commit", async () => {
  const root = await project();
  const initial = await load(root);
  const results = await Promise.allSettled([
    save({ root, revision: initial.revision, command: command({ id: "first" }) }),
    save({ root, revision: initial.revision, command: command({ id: "second" }) }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" && String(rejected.reason)).toContain("changed on disk");
  expect((await load(root)).commands).toHaveLength(1);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test("an existing lock is bounded and is never automatically deleted", async () => {
  const root = await project();
  const initial = await load(root);
  await mkdir(join(root, ".omp"));
  const lock = `${initial.path}.lock`;
  await writeFile(lock, "leftover-lock\n");
  await expect(save({ root, revision: initial.revision, command: command() })).rejects.toThrow("Configuration is locked");
  expect(await readFile(lock, "utf8")).toBe("leftover-lock\n");
  expect((await load(root)).revision).toBe("missing");
});

interface InvalidCommandCase {
  scenario: string;
  fields: Record<string, unknown>;
  error: RegExp;
}
const invalidCommands: InvalidCommandCase[] = [
  { scenario: "uppercase command ID is refused", fields: { id: "Build" }, error: /id/ },
  { scenario: "underscore command ID is refused", fields: { id: "bad_id" }, error: /id/ },
  { scenario: "leading hyphen command ID is refused", fields: { id: "-build" }, error: /id/ },
  { scenario: "blank command name is refused", fields: { name: " \n " }, error: /name/ },
  { scenario: "blank command script is refused", fields: { run: " \n\t" }, error: /run/ },
  { scenario: "NUL in command script is refused", fields: { run: "echo\0bad" }, error: /NUL/ },
  { scenario: "string enabled is refused", fields: { enabled: "false" }, error: /boolean/ },
  { scenario: "numeric enabled is refused", fields: { enabled: 0 }, error: /boolean/ },
  { scenario: "null enabled is refused", fields: { enabled: null }, error: /boolean/ },
  { scenario: "absolute command cwd is refused", fields: { cwd: "/tmp" }, error: /relative/ },
  { scenario: "parent command cwd is refused", fields: { cwd: "../escape" }, error: /relative/ },
  { scenario: "normalized escaping cwd is refused", fields: { cwd: "sub/../../escape" }, error: /relative/ },
  { scenario: "blank command cwd is refused", fields: { cwd: "" }, error: /cwd/ },
  { scenario: "relative shell is refused", fields: { shell: "zsh" }, error: /absolute/ },
  { scenario: "NUL in shell is refused", fields: { shell: "/bin/sh\0" }, error: /NUL/ },
  { scenario: "hyphen in environment name is refused", fields: { env: { "BAD-NAME": "x" } }, error: /variable name/ },
  { scenario: "digit at start of environment name is refused", fields: { env: { "1BAD": "x" } }, error: /variable name/ },
  { scenario: "numeric environment value is refused", fields: { env: { TOKEN: 12 } }, error: /string/ },
  { scenario: "boolean environment value is refused", fields: { env: { TOKEN: true } }, error: /string/ },
  { scenario: "null environment value is refused", fields: { env: { TOKEN: null } }, error: /string/ },
  { scenario: "NUL environment value is refused", fields: { env: { TOKEN: "a\0b" } }, error: /NUL/ },
  { scenario: "array environment is refused", fields: { env: [] }, error: /mapping/ },
  { scenario: "null environment is refused", fields: { env: null }, error: /mapping/ },
  { scenario: "unknown command field is refused", fields: { unknown: "retain" }, error: /Unsupported/ },
];
test.each(invalidCommands)("$scenario", ({ fields, error }) => {
  expect(() => validateCommand({ ...command(), ...fields })).toThrow(error);
});

test("valid command strings retain whitespace, Unicode and empty environment values", () => {
  expect(validateCommand({ id: "build-2", name: " 日本語🚀 ", run: "\necho hello\n", env: { EMPTY: "", _OK2: " '\"$\n🚀 " } })).toEqual({
    id: "build-2", name: " 日本語🚀 ", run: "\necho hello\n", enabled: true, cwd: ".", shell: DEFAULT_SHELL, env: { EMPTY: "", _OK2: " '\"$\n🚀 " },
  });
});

test("invalid save is rejected before creating a configuration directory", async () => {
  const root = await project();
  const initial = await load(root);
  await expect(save({ root, revision: initial.revision, command: command({ env: { "BAD-NAME": "x" } }) })).rejects.toThrow("Invalid environment variable name");
  expect(await readdir(root)).toEqual([".git"]);
  await expect(toggle({ root, revision: initial.revision, id: "build", enabled: false })).rejects.toThrow("Command not found");
  expect(await readdir(root)).toEqual([".git"]);
});

interface InvalidDocumentCase {
  scenario: string;
  source: string;
  error: RegExp;
}
const invalidDocuments: InvalidDocumentCase[] = [
  { scenario: "future YAML schema is not overwritten", source: "version: 2\ncommands: []\n", error: /version/ },
  { scenario: "string YAML version is not overwritten", source: "version: '1'\ncommands: []\n", error: /version/ },
  { scenario: "unknown YAML metadata is not discarded", source: "version: 1\ncommands: []\nmetadata: retained\n", error: /Unsupported/ },
  { scenario: "duplicate YAML keys are not rewritten", source: "version: 1\ncommands: []\ncommands: []\n", error: /Invalid YAML/ },
  { scenario: "mapping command inventory is not rewritten", source: "version: 1\ncommands: {}\n", error: /sequence/ },
  { scenario: "unknown YAML command fields are not discarded", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    run: echo one\n    unknown: retained\n", error: /Unsupported/ },
  { scenario: "duplicate YAML command IDs are not rewritten", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    run: echo one\n  - id: build\n    name: Another\n    run: echo two\n", error: /Duplicate command id/ },
  { scenario: "shared YAML aliases are not rewritten", source: "version: 1\ncommands:\n  - &shared\n    id: build\n    name: Build\n    run: echo one\n  - *shared\n", error: /aliases/ },
  { scenario: "numeric YAML environment is not rewritten", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    run: echo one\n    env:\n      TOKEN: 1\n", error: /string/ },
  { scenario: "string YAML enabled flag is not rewritten", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    enabled: 'false'\n    run: echo one\n", error: /boolean/ },
];
test.each(invalidDocuments)("$scenario", async ({ source, error }) => {
  const root = await project();
  const path = await config(root, source);
  await expect(load(root)).rejects.toThrow(error);
  await expect(save({ root, revision: "missing", command: command() })).rejects.toThrow(error);
  expect(await readFile(path, "utf8")).toBe(source);
});

test("duplicate create, duplicate rename and missing edit target preserve configuration", async () => {
  const root = await project();
  let current = await load(root);
  current = await save({ root, revision: current.revision, command: command() });
  current = await save({ root, revision: current.revision, command: command({ id: "test" }) });
  const before = await readFile(current.path, "utf8");
  await expect(save({ root, revision: current.revision, command: command() })).rejects.toThrow("Duplicate command id");
  await expect(save({ root, revision: current.revision, originalId: "test", command: command() })).rejects.toThrow("Duplicate command id");
  await expect(save({ root, revision: current.revision, originalId: "missing", command: command() })).rejects.toThrow("Command not found");
  expect(await readFile(current.path, "utf8")).toBe(before);
});

test("configuration size is bounded on both read and save", async () => {
  const root = await project();
  const initial = await load(root);
  await expect(save({ root, revision: initial.revision, command: command({ run: "x".repeat(MAX_FILE_BYTES) }) })).rejects.toThrow("1 MiB limit");
  expect((await load(root)).revision).toBe("missing");
  const source = `#${"x".repeat(MAX_FILE_BYTES)}\n`;
  const path = await config(root, source);
  await expect(load(root)).rejects.toThrow("1 MiB limit");
  expect(await readFile(path, "utf8")).toBe(source);
});

test("discovery selects the nearest config, stops at git roots, and never merges", async () => {
  const root = await project();
  const nested = join(root, "packages", "app");
  const deep = join(nested, "src");
  await mkdir(deep, { recursive: true });
  await config(root, "version: 1\ncommands:\n  - id: root\n    name: Root\n    run: echo root\n");
  expect(await discoverRoot(deep)).toBe(root);
  await config(nested, "version: 1\ncommands:\n  - id: nested\n    name: Nested\n    run: echo nested\n");
  expect((await load(deep)).commands.map(item => item.id)).toEqual(["nested"]);
  const worktree = join(root, "worktree");
  const worktreeDeep = join(worktree, "src");
  await mkdir(worktreeDeep, { recursive: true });
  await writeFile(join(worktree, ".git"), "gitdir: elsewhere\n");
  const snapshot = await load(worktreeDeep);
  expect(snapshot.root).toBe(worktree);
  expect(snapshot.commands).toEqual([]);
  expect(snapshot.revision).toBe("missing");
  expect(await readdir(worktree)).toEqual([".git", "src"]);
});

test("without git or configuration discovery uses the original cwd", async () => {
  const root = await project(false);
  const nested = join(root, "one", "two");
  await mkdir(nested, { recursive: true });
  expect(await discoverRoot(nested)).toBe(nested);
  expect((await load(nested)).root).toBe(nested);
  await expect(load("relative-root")).rejects.toThrow("absolute path");
});

test("a prepared launch rechecks disabled state before executing", async () => {
  const root = await project();
  const marker = join(root, "should-not-exist");
  let snapshot = await load(root);
  snapshot = await save({ root, revision: snapshot.revision, command: command({ run: `touch ${shellQuote(marker)}` }) });
  const prepared = await prepare(root, "build");
  snapshot = await toggle({ root, revision: snapshot.revision, id: "build", enabled: false });
  expect(snapshot.commands[0].enabled).toBe(false);
  await expect(prepare(root, "build")).rejects.toThrow("Command is disabled");
  const child = Bun.spawn(["/bin/sh", "-c", prepared.command], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("Command is disabled");
  expect(await readdir(root)).not.toContain("should-not-exist");
});

test("execution keeps multiline scripts exact, restores env and cwd after login init, and propagates exit", async () => {
  const root = await project();
  const subdirectory = join(root, "working directory");
  await mkdir(subdirectory);
  const shell = join(root, "login shell's wrapper");
  await writeFile(shell, `#!/bin/sh
[ "$1" = "-l" ] || exit 81
shift
export TPC_VALUE='from-login-init'
cd /
exec /bin/sh "$@"
`);
  await chmod(shell, 0o700);
  const output = join(root, "result '🚀'.txt");
  const envValue = "日本語 🚀\n'\"$HOME; literal";
  const inheritedKey = "TPC_TEST_INHERITED_VALUE";
  const original = process.env[inheritedKey];
  process.env[inheritedKey] = "inherited value";
  try {
    const initial = await load(root);
    const run = `cat <<'TPC_LITERAL_END' > ${shellQuote(output)}
exact '"$HOME
日本語🚀
TPC_LITERAL_END
printf '%s\\000' "$TPC_VALUE" "$TPC_TEST_INHERITED_VALUE" "$PWD" >> ${shellQuote(output)}
exit 23
`;
    await save({ root, revision: initial.revision, command: command({ shell, cwd: "working directory", env: { TPC_VALUE: envValue }, run }) });
    expect(await execute(root, "build")).toBe(23);
    expect(await readFile(output, "utf8")).toBe(`exact '"$HOME\n日本語🚀\n${envValue}\0inherited value\0${subdirectory}\0`);
  } finally {
    if (original === undefined) delete process.env[inheritedKey];
    else process.env[inheritedKey] = original;
  }
});

test("cwd symlinks cannot escape the root and nonexistent cwd is not executed", async () => {
  const root = await project();
  const outside = await project();
  await symlink(outside, join(root, "linked"));
  let snapshot = await load(root);
  snapshot = await save({ root, revision: snapshot.revision, command: command({ cwd: "linked" }) });
  await expect(prepare(root, "build")).rejects.toThrow("outside the project root");
  await expect(execute(root, "build")).rejects.toThrow("outside the project root");
  snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: command({ cwd: "not-created" }) });
  await expect(prepare(root, "build")).rejects.toThrow();
  expect(snapshot.commands[0].cwd).toBe("not-created");
});
