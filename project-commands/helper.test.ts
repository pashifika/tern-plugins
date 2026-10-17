import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { CONFIG_NAME, DEFAULT_SHELL, MAX_FILE_BYTES, discoverRoot, execute, load, prepare, remove, restore, run, save, shellQuote, terminal, toggle, validateCommand, type Command, type DeletedCommand, type RemoveResult, type Snapshot } from "./helper";

const temporaryRoots: string[] = [];
const helperPath = join(import.meta.dir, "helper.ts");

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
  return { id: "build", name: "Build", enabled: true, execution: "background", cwd: ".", shell: "/bin/sh", profiles: false, env: {}, run: "printf 'hello\\n'", ...overrides };
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
  expect(initial.commands[0]).toEqual(command({ shell: DEFAULT_SHELL, profiles: true, run: "echo hello" }));
  const updated = await toggle({ root, revision: initial.revision, id: "build", enabled: false });
  expect(updated.commands[0].enabled).toBe(false);
  const document = parseDocument(await readFile(path, "utf8"));
  expect(document.get("version")).toBe(1);
  expect(await readFile(path, "utf8")).toContain("# handwritten");
});

test("execution choice persists through save, edit and toggle", async () => {
  const root = await project();
  let snapshot = await load(root);
  snapshot = await save({ root, revision: snapshot.revision, command: command({ execution: "tab" }) });
  expect((await load(root)).commands[0].execution).toBe("tab");
  expect(await prepare(root, "build")).toEqual({ root, id: "build", cwd: root, name: "Build", execution: "tab" });
  snapshot = await toggle({ root, revision: snapshot.revision, id: "build", enabled: false });
  expect(snapshot.commands[0].execution).toBe("tab");
  snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: command({ execution: "background" }) });
  expect(parseDocument(await readFile(snapshot.path, "utf8")).toJS().commands[0].execution).toBe("background");
  expect(await prepare(root, "build")).toEqual({ root, id: "build", cwd: root, name: "Build", execution: "background" });
  const before = await readFile(snapshot.path, "utf8");
  await expect(save({ root, revision: snapshot.revision, originalId: "build", command: { ...command(), execution: "shell" } })).rejects.toThrow("execution");
  expect(await readFile(snapshot.path, "utf8")).toBe(before);
});

test("profile loading defaults On and persists through create, edit and toggle", async () => {
  const root = await project();
  const { profiles: omitted, ...withoutProfiles } = command();
  let snapshot = await save({ root, revision: (await load(root)).revision, command: withoutProfiles });
  expect(snapshot.commands[0].profiles).toBe(true);
  expect(parseDocument(await readFile(snapshot.path, "utf8")).toJS().commands[0].profiles).toBe(true);
  for (const profiles of [false, true]) {
    snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: command({ profiles }) });
    expect((await load(root)).commands[0].profiles).toBe(profiles);
    snapshot = await toggle({ root, revision: snapshot.revision, id: "build", enabled: false });
    expect(snapshot.commands[0].profiles).toBe(profiles);
    expect(parseDocument(await readFile(snapshot.path, "utf8")).toJS().commands[0].profiles).toBe(profiles);
  }
});

const DELETION_CONFIG = `# Current project header
version: 1 # Current schema comment
commands: # Current inventory comment
  - id: build
    name: Build # Build name comment
    run: touch forbidden

  # Test command comment
  - id: test
    name: "日本語 Test" # Test name comment
    enabled: false # Test enabled comment
    execution: tab
    cwd: work
    shell: /bin/sh
    profiles: false # Test profiles comment
    env:
      TOKEN: "literal '$HOME" # Test env comment
      EMPTY: ""
    run: | # Test run comment
      printf '%s\\n' "$TOKEN"
      exit 7

  # Deploy command comment
  - id: deploy
    name: Deploy # Deploy name comment
    run: echo deploy
# Current document footer
`;
const DELETED_TEST_COMMAND = {
  id: "test", name: "日本語 Test", enabled: false, execution: "tab", cwd: "work",
  shell: "/bin/sh", profiles: false, env: { TOKEN: "literal '$HOME", EMPTY: "" },
  run: "printf '%s\\n' \"$TOKEN\"\nexit 7\n",
};
const deletionCases = [
  {
    scenario: "deleting the first command preserves the remaining order and omitted fields on Undo",
    source: DELETION_CONFIG, id: "build", index: 0, remaining: ["test", "deploy"],
    raw: { id: "build", name: "Build", run: "touch forbidden" },
    comments: ["Build name comment"], retainedComments: ["Current project header", "Current schema comment", "Current inventory comment", "Current document footer", "Test name comment", "Deploy name comment"],
  },
  {
    scenario: "deleting the middle command restores every field and its YAML comments at the original index",
    source: DELETION_CONFIG, id: "test", index: 1, remaining: ["build", "deploy"],
    raw: DELETED_TEST_COMMAND,
    comments: ["Test command comment", "Test name comment", "Test enabled comment", "Test profiles comment", "Test env comment", "Test run comment"],
    retainedComments: ["Current project header", "Current schema comment", "Current inventory comment", "Current document footer", "Build name comment", "Deploy name comment"],
  },
  {
    scenario: "deleting the final row preserves its leading comment and restores the original order",
    source: DELETION_CONFIG, id: "deploy", index: 2, remaining: ["build", "test"],
    raw: { id: "deploy", name: "Deploy", run: "echo deploy" },
    comments: ["Deploy command comment", "Deploy name comment"],
    retainedComments: ["Current project header", "Current schema comment", "Current inventory comment", "Current document footer", "Build name comment", "Test name comment"],
  },
  {
    scenario: "deleting the only command writes a valid empty list and Undo restores omitted defaults",
    source: "# Current project header\nversion: 1\ncommands:\n  - id: build\n    name: Build # Build name comment\n    run: touch forbidden\n# Current document footer\n",
    id: "build", index: 0, remaining: [], raw: { id: "build", name: "Build", run: "touch forbidden" },
    comments: ["Build name comment"], retainedComments: ["Current project header", "Current document footer"],
  },
];
test.each(deletionCases)("$scenario", async ({ source, id, index, remaining, raw, comments, retainedComments }) => {
  const root = await project();
  const path = await config(root, source);
  await chmod(path, 0o640);
  const initial = await load(root);
  const removed = await remove({ root, revision: initial.revision, id });
  expect(removed.snapshot.commands.map(item => item.id)).toEqual(remaining);
  expect(removed.snapshot.revision).not.toBe(initial.revision);
  expect(removed.deleted.index).toBe(index);
  expect(parseDocument(removed.deleted.source).toJS()).toEqual({ version: 1, commands: [raw] });
  const afterDelete = await readFile(path, "utf8");
  expect(parseDocument(afterDelete).errors).toEqual([]);
  expect(parseDocument(afterDelete).toJS().commands.map((item: Command) => item.id)).toEqual(remaining);
  for (const comment of comments) {
    expect(removed.deleted.source).toContain(`# ${comment}`);
    expect(afterDelete).not.toContain(`# ${comment}`);
  }
  for (const comment of retainedComments) {
    expect(afterDelete).toContain(`# ${comment}`);
    expect(removed.deleted.source).not.toContain(`# ${comment}`);
  }
  expect(await load(root)).toEqual(removed.snapshot);
  await expect(prepare(root, id)).rejects.toThrow(`Command not found: ${id}`);
  await expect(run(root, id)).rejects.toThrow(`Command not found: ${id}`);
  await expect(execute(root, id)).rejects.toThrow(`Command not found: ${id}`);
  expect(await readdir(root)).not.toContain("forbidden");
  const restored = await restore({ root, revision: removed.snapshot.revision, deleted: removed.deleted });
  expect(restored.commands).toEqual(initial.commands);
  expect(parseDocument(await readFile(path, "utf8")).toJS()).toEqual(parseDocument(source).toJS());
  for (const comment of [...comments, ...retainedComments]) {
    expect(await readFile(path, "utf8")).toContain(`# ${comment}`);
  }
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  expect(await load(root)).toEqual(restored);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test("Undo preserves intervening saves, toggles and externally reloaded document edits", async () => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  let current = await save({ root, revision: removed.snapshot.revision, originalId: "build", command: command({ name: "Edited Build", run: "echo changed" }) });
  current = await toggle({ root, revision: current.revision, id: "deploy", enabled: false });
  current = await save({ root, revision: current.revision, command: command({ id: "added", name: "Added" }) });
  const external = (await readFile(path, "utf8")).replace("Current project header", "Externally edited header").replace("name: Deploy", "name: External Deploy");
  await writeFile(path, `${external}# External footer\n`);
  current = await load(root);
  const restored = await restore({ root, revision: current.revision, deleted: removed.deleted });
  expect(restored.commands).toEqual([current.commands[0], { ...DELETED_TEST_COMMAND }, ...current.commands.slice(1)]);
  const source = await readFile(path, "utf8");
  expect(source).toContain("# Externally edited header");
  expect(source).not.toContain("# Current project header");
  expect(source).toContain("# External footer");
  expect(source).toContain("# Test command comment");
  expect(parseDocument(source).toJS().commands[1]).toEqual(DELETED_TEST_COMMAND);
  expect(await load(root)).toEqual(restored);
});

interface DeletionMutationCase {
  scenario: string;
  mutate: (root: string, revision: string, deleted: DeletedCommand) => Promise<unknown>;
  expectedIds: string[];
}
const deletionMutations: DeletionMutationCase[] = [
  {
    scenario: "remove", mutate: (root, revision) => remove({ root, revision, id: "build" }),
    expectedIds: ["deploy"],
  },
  {
    scenario: "restore", mutate: (root, revision, deleted) => restore({ root, revision, deleted }),
    expectedIds: ["build", "test", "deploy"],
  },
];
test.each(deletionMutations)("stale $scenario refuses external changes until Reload, then edits only its target", async ({ mutate, expectedIds }) => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  const external = `${await readFile(path, "utf8")}# External change\n`;
  await writeFile(path, external);
  await expect(mutate(root, removed.snapshot.revision, removed.deleted)).rejects.toThrow("changed on disk");
  expect(await readFile(path, "utf8")).toBe(external);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
  await mutate(root, (await load(root)).revision, removed.deleted);
  expect((await load(root)).commands.map(item => item.id)).toEqual(expectedIds);
  expect(await readFile(path, "utf8")).toContain("# External change");
});

test.each(deletionMutations)("stale $scenario refuses to recreate a configuration removed from disk", async ({ mutate }) => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  await rm(path);
  await expect(mutate(root, removed.snapshot.revision, removed.deleted)).rejects.toThrow("changed on disk");
  expect(await readdir(join(root, ".omp"))).toEqual([]);
  expect((await load(root)).revision).toBe("missing");
});

test("Reload of a removed configuration permits restoring just the deleted command", async () => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  await rm(join(root, ".omp"), { recursive: true });
  const current = await load(root);
  expect(current.revision).toBe("missing");
  const restored = await restore({ root, revision: current.revision, deleted: removed.deleted });
  expect(restored.commands).toEqual([DELETED_TEST_COMMAND]);
  expect(parseDocument(await readFile(path, "utf8")).toJS()).toEqual({ version: 1, commands: [DELETED_TEST_COMMAND] });
});

test("missing delete targets never produce a receipt or create missing configuration directories", async () => {
  const root = await project();
  await expect(remove({ root, revision: "missing", id: "build" })).rejects.toThrow("Command not found: build");
  expect(await readdir(root)).toEqual([".git"]);
  const path = await config(root, DELETION_CONFIG);
  const initial = await load(root);
  await expect(remove({ root, revision: initial.revision, id: "absent" })).rejects.toThrow("Command not found: absent");
  expect(await readFile(path, "utf8")).toBe(DELETION_CONFIG);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test("duplicate restore preserves the current command and leaves the receipt reusable after the collision is removed", async () => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  const replacement = await save({ root, revision: removed.snapshot.revision, command: command({ id: "test", name: "Replacement" }) });
  const before = await readFile(path, "utf8");
  const receipt = JSON.stringify(removed.deleted);
  await expect(restore({ root, revision: replacement.revision, deleted: removed.deleted })).rejects.toThrow("Duplicate command id: test");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(JSON.stringify(removed.deleted)).toBe(receipt);
  const cleared = await remove({ root, revision: replacement.revision, id: "test" });
  const restored = await restore({ root, revision: cleared.snapshot.revision, deleted: removed.deleted });
  expect(restored.commands.map(item => item.id)).toEqual(["build", "test", "deploy"]);
  expect(restored.commands[1]).toEqual(DELETED_TEST_COMMAND);
});

test("multiple deletion receipts restore in LIFO order without rolling back an unrelated toggle", async () => {
  const root = await project();
  await config(root, DELETION_CONFIG);
  const last = await remove({ root, revision: (await load(root)).revision, id: "deploy" });
  const first = await remove({ root, revision: last.snapshot.revision, id: "build" });
  expect(first.snapshot.commands.map(item => item.id)).toEqual(["test"]);
  const changed = await toggle({ root, revision: first.snapshot.revision, id: "test", enabled: true });
  const undoFirst = await restore({ root, revision: changed.revision, deleted: first.deleted });
  expect(undoFirst.commands.map(item => item.id)).toEqual(["build", "test"]);
  const undoLast = await restore({ root, revision: undoFirst.revision, deleted: last.deleted });
  expect(undoLast.commands.map(item => item.id)).toEqual(["build", "test", "deploy"]);
  expect(undoLast.commands[1]).toEqual({ ...DELETED_TEST_COMMAND, enabled: true });
  expect(await load(root)).toEqual(undoLast);
});

test.each([
  { scenario: "original index past a shortened list", index: 2 },
  { scenario: "largest safe receipt index", index: Number.MAX_SAFE_INTEGER },
])("restore appends at current length for $scenario", async ({ index }) => {
  const root = await project();
  await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "deploy" });
  const shorter = await remove({ root, revision: removed.snapshot.revision, id: "build" });
  const restored = await restore({ root, revision: shorter.snapshot.revision, deleted: { ...removed.deleted, index } });
  expect(restored.commands.map(item => item.id)).toEqual(["test", "deploy"]);
});

const VALID_DELETED_SOURCE = "version: 1\ncommands:\n  - id: restored\n    name: Restored\n    run: echo restored\n";
const malformedReceipts = [
  { scenario: "null receipt", deleted: null, error: /mapping/ },
  { scenario: "array receipt", deleted: [], error: /mapping/ },
  { scenario: "unknown receipt field", deleted: { source: VALID_DELETED_SOURCE, index: 0, extra: true }, error: /Unsupported/ },
  { scenario: "missing index", deleted: { source: VALID_DELETED_SOURCE }, error: /nonnegative safe integer/ },
  { scenario: "negative index", deleted: { source: VALID_DELETED_SOURCE, index: -1 }, error: /nonnegative safe integer/ },
  { scenario: "fractional index", deleted: { source: VALID_DELETED_SOURCE, index: 0.5 }, error: /nonnegative safe integer/ },
  { scenario: "unsafe index", deleted: { source: VALID_DELETED_SOURCE, index: Number.MAX_SAFE_INTEGER + 1 }, error: /nonnegative safe integer/ },
  { scenario: "infinite index", deleted: { source: VALID_DELETED_SOURCE, index: Infinity }, error: /nonnegative safe integer/ },
  { scenario: "NaN index", deleted: { source: VALID_DELETED_SOURCE, index: NaN }, error: /nonnegative safe integer/ },
  { scenario: "string index", deleted: { source: VALID_DELETED_SOURCE, index: "0" }, error: /nonnegative safe integer/ },
  { scenario: "missing source", deleted: { index: 0 }, error: /source.*string/ },
  { scenario: "non-string source", deleted: { source: {}, index: 0 }, error: /source.*string/ },
  { scenario: "blank source", deleted: { source: " ", index: 0 }, error: /source.*string/ },
  { scenario: "NUL source", deleted: { source: "\0", index: 0 }, error: /NUL/ },
  { scenario: "over-limit UTF-8 source", deleted: { source: `#${"界".repeat(Math.ceil(MAX_FILE_BYTES / 3))}\n${VALID_DELETED_SOURCE}`, index: 0 }, error: /1 MiB limit/ },
  { scenario: "malformed YAML source", deleted: { source: "version: 1\ncommands: [", index: 0 }, error: /Invalid YAML/ },
  { scenario: "unsupported source version", deleted: { source: "version: 2\ncommands: []\n", index: 0 }, error: /version/ },
  { scenario: "empty command source", deleted: { source: "version: 1\ncommands: []\n", index: 0 }, error: /exactly one command/ },
  { scenario: "multiple command source", deleted: { source: DELETION_CONFIG, index: 0 }, error: /exactly one command/ },
  { scenario: "invalid command source", deleted: { source: VALID_DELETED_SOURCE.replace("echo restored", "''"), index: 0 }, error: /run/ },
  { scenario: "aliased command source", deleted: { source: "version: 1\ncommands: [&command {id: restored, name: Restored, run: echo restored}, *command]\n", index: 0 }, error: /aliases/ },
];
test.each(malformedReceipts)("restore rejects $scenario without changing current bytes", async ({ deleted, error }) => {
  const root = await project();
  await expect(restore({ root, revision: "missing", deleted })).rejects.toThrow(error);
  expect(await readdir(root)).toEqual([".git"]);
  const path = await config(root, DELETION_CONFIG);
  await expect(restore({ root, revision: (await load(root)).revision, deleted })).rejects.toThrow(error);
  expect(await readFile(path, "utf8")).toBe(DELETION_CONFIG);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test.each(deletionMutations)("filesystem permission failure during $scenario preserves bytes and permits retry", async ({ mutate, expectedIds }) => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const removed = await remove({ root, revision: (await load(root)).revision, id: "test" });
  const before = await readFile(path, "utf8");
  await chmod(join(root, ".omp"), 0o500);
  try {
    await expect(mutate(root, removed.snapshot.revision, removed.deleted)).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await chmod(join(root, ".omp"), 0o700);
  }
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
  await mutate(root, removed.snapshot.revision, removed.deleted);
  expect((await load(root)).commands.map(item => item.id)).toEqual(expectedIds);
});

test("delete serialization failure never writes bytes or returns a successful receipt", async () => {
  const root = await project();
  const source = `version: 1\ncommands:\n- id: keep\n  name: Keep\n  run: |-\n${"    x\n".repeat(140000)}- id: remove\n  name: Remove\n  run: echo remove\n`;
  expect(Buffer.byteLength(source)).toBeLessThan(MAX_FILE_BYTES);
  const path = await config(root, source);
  const initial = await load(root);
  await expect(remove({ root, revision: initial.revision, id: "remove" })).rejects.toThrow("1 MiB limit");
  expect(await readFile(path, "utf8")).toBe(source);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

test("restore refuses a combined document over the write limit without consuming its receipt", async () => {
  const root = await project();
  const current = await save({ root, revision: "missing", command: command({ run: "x".repeat(700000) }) });
  const before = await readFile(current.path, "utf8");
  const deleted = { index: 0, source: VALID_DELETED_SOURCE.replace("echo restored", "x".repeat(400000)) };
  const receipt = JSON.stringify(deleted);
  await expect(restore({ root, revision: current.revision, deleted })).rejects.toThrow("1 MiB limit");
  expect(await readFile(current.path, "utf8")).toBe(before);
  expect(JSON.stringify(deleted)).toBe(receipt);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
});

async function rpcRequest(request: unknown) {
  const child = Bun.spawn([process.execPath, helperPath, "rpc"], {
    stdin: Buffer.from(JSON.stringify(request)), stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, stdout, stderr };
}

test("RPC remove and restore persist mutations across helper processes without storing undo receipts on disk", async () => {
  const root = await project();
  const path = await config(root, DELETION_CONFIG);
  const initial = await load(root);
  const deletion = await rpcRequest({ op: "remove", root, revision: initial.revision, id: "test" });
  expect(deletion.status).toBe(0);
  expect(deletion.stderr).toBe("");
  const removed: RemoveResult = JSON.parse(deletion.stdout);
  expect(removed.snapshot).toEqual(await load(root));
  expect(removed.snapshot.commands.map(item => item.id)).toEqual(["build", "deploy"]);
  expect(removed.deleted.index).toBe(1);
  expect(parseDocument(removed.deleted.source).toJS()).toEqual({ version: 1, commands: [DELETED_TEST_COMMAND] });
  const preparation = await rpcRequest({ op: "prepare", root, id: "test" });
  expect(preparation).toEqual({ status: 1, stdout: "", stderr: "Command not found: test\n" });
  const execution = await rpcRequest({ op: "run", root, id: "test" });
  expect(execution).toEqual({ status: 1, stdout: "", stderr: "Command not found: test\n" });
  const restoration = await rpcRequest({ op: "restore", root, revision: removed.snapshot.revision, deleted: removed.deleted });
  expect(restoration.status).toBe(0);
  expect(restoration.stderr).toBe("");
  const restored: Snapshot = JSON.parse(restoration.stdout);
  expect(restored).toEqual(await load(root));
  expect(restored.commands).toEqual(initial.commands);
  const beforeDuplicate = await readFile(path, "utf8");
  const duplicate = await rpcRequest({ op: "restore", root, revision: restored.revision, deleted: removed.deleted });
  expect(duplicate).toEqual({ status: 1, stdout: "", stderr: "Duplicate command id: test\n" });
  expect(await readFile(path, "utf8")).toBe(beforeDuplicate);
  expect(await readdir(join(root, ".omp"))).toEqual([CONFIG_NAME]);
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
  { scenario: "unknown execution mode is refused", fields: { execution: "shell" }, error: /execution/ },
  { scenario: "null execution mode is refused", fields: { execution: null }, error: /execution/ },
  { scenario: "boolean execution mode is refused", fields: { execution: true }, error: /execution/ },
  { scenario: "blank execution mode is refused", fields: { execution: "" }, error: /execution/ },
  { scenario: "string profiles is refused", fields: { profiles: "false" }, error: /profiles.*boolean/ },
  { scenario: "numeric profiles is refused", fields: { profiles: 0 }, error: /profiles.*boolean/ },
  { scenario: "null profiles is refused", fields: { profiles: null }, error: /profiles.*boolean/ },
  { scenario: "absolute command cwd is refused", fields: { cwd: "/tmp" }, error: /relative/ },
  { scenario: "parent command cwd is refused", fields: { cwd: "../escape" }, error: /relative/ },
  { scenario: "normalized escaping cwd is refused", fields: { cwd: "sub/../../escape" }, error: /relative/ },
  { scenario: "blank command cwd is refused", fields: { cwd: "" }, error: /cwd/ },
  { scenario: "relative shell path is refused", fields: { shell: "./zsh" }, error: /executable name or an absolute path/ },
  { scenario: "nested relative shell path is refused", fields: { shell: "bin/fish" }, error: /executable name or an absolute path/ },
  { scenario: "current directory as shell is refused", fields: { shell: "." }, error: /executable name or an absolute path/ },
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
    id: "build-2", name: " 日本語🚀 ", run: "\necho hello\n", enabled: true, execution: "background", cwd: ".", shell: DEFAULT_SHELL, profiles: true, env: { EMPTY: "", _OK2: " '\"$\n🚀 " },
  });
});

test.each(["zsh", "fish", "/opt/homebrew/bin/fish", "/a directory/my-shell"])("shell %s is accepted without rewriting the selection", shell => {
  expect(validateCommand(command({ shell })).shell).toBe(shell);
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
  { scenario: "invalid YAML execution mode is not rewritten", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    execution: shell\n    run: echo one\n", error: /execution/ },
  { scenario: "string YAML profiles flag is not rewritten", source: "version: 1\ncommands:\n  - id: build\n    name: Build\n    profiles: 'false'\n    run: echo one\n", error: /profiles.*boolean/ },
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

async function helper(mode: "execute" | "terminal" | "rpc", root: string, env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, helperPath, mode, ...(mode === "rpc" ? [] : [root, "build"])], {
    env: { ...process.env, ...env },
    stdin: mode === "rpc" ? Buffer.from(JSON.stringify({ op: "run", root, id: "build" })) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, stdout, stderr };
}

async function shellEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home");
  const zdot = join(root, "zdot");
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  await Promise.all([home, zdot, join(configHome, "fish"), join(dataHome, "fish")].map(path => mkdir(path, { recursive: true })));
  return { HOME: home, ZDOTDIR: zdot, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome };
}

interface ProfileExecutionCase {
  scenario: string;
  shell: string;
  native: string;
  profiles: boolean | undefined;
  enabled: boolean;
  profileValue: string;
  startup: string | null;
}
const profileExecutions: ProfileExecutionCase[] = [
  { shell: "bash", native: `[[ -n "$BASH_VERSION" ]] || exit 93\nnative=bash\n`, startup: "bash-profile\n" },
  { shell: "zsh", native: `[[ -n "$ZSH_VERSION" ]] || exit 93\nnative=zsh\n`, startup: "zsh-env\nzsh-profile\nzsh-login\n" },
  { shell: "fish", native: `set -l native fish\ntest "$fish_private_mode" = 1; or exit 94\n`, startup: "fish-config\n" },
].flatMap(({ shell, native, startup }) => [
  { scenario: `${shell} default loads isolated profiles and preserves literal env, cwd, status and history`, shell, native, profiles: undefined, enabled: true, profileValue: "profile-value", startup },
  { scenario: `${shell} profiles On loads isolated profiles and preserves literal env, cwd, status and history`, shell, native, profiles: true, enabled: true, profileValue: "profile-value", startup },
  { scenario: `${shell} profiles Off skips startup and preserves literal env, cwd, status and history`, shell, native, profiles: false, enabled: false, profileValue: "", startup: null },
]);

test.each(profileExecutions)("$scenario", async ({ shell, native, profiles, enabled, profileValue, startup }) => {
  const root = await project();
  const env = await shellEnvironment(root);
  const home = env.HOME!;
  const zdot = env.ZDOTDIR!;
  const fishConfig = join(env.XDG_CONFIG_HOME!, "fish", "config.fish");
  const working = join(root, "working 'directory 🚀");
  await mkdir(working);
  const startupMarker = join(root, "startup");
  const output = join(root, "result");
  const common = `export TPC_PROFILE=profile-value TPC_VALUE=profile-value\ncd /\n`;
  const startupFiles: Record<string, string> = {
    [join(home, ".bash_profile")]: `printf 'bash-profile\\n' >> "$TPC_TEST_STARTUP"\nshopt -q login_shell || exit 91\ncase $- in *i*) exit 92;; esac\n${common}`,
    [join(home, ".bash_login")]: `printf 'unexpected bash-login\\n' >> "$TPC_TEST_STARTUP"\n`,
    [join(home, ".profile")]: `printf 'unexpected profile\\n' >> "$TPC_TEST_STARTUP"\n`,
    [join(home, ".bashrc")]: `printf 'unexpected bashrc\\n' >> "$TPC_TEST_STARTUP"\n`,
    [join(zdot, ".zshenv")]: `printf 'zsh-env\\n' >> "$TPC_TEST_STARTUP"\n${common}`,
    [join(zdot, ".zprofile")]: `printf 'zsh-profile\\n' >> "$TPC_TEST_STARTUP"\n[[ -o login && ! -o interactive ]] || exit 92\n${common}`,
    [join(zdot, ".zlogin")]: `printf 'zsh-login\\n' >> "$TPC_TEST_STARTUP"\n${common}`,
    [join(zdot, ".zshrc")]: `printf 'unexpected zshrc\\n' >> "$TPC_TEST_STARTUP"\n`,
    [fishConfig]: `printf 'fish-config\\n' >> "$TPC_TEST_STARTUP"\nstatus is-login; or exit 91\nstatus is-interactive; and exit 92\nset --global --export TPC_PROFILE profile-value\nset --global --export TPC_VALUE profile-value\ncd /\n`,
  };
  const injected = join(home, "injected-env");
  startupFiles[injected] = `printf 'unexpected injected-env\\n' >> "$TPC_TEST_STARTUP"\n`;
  for (const [path, source] of Object.entries(startupFiles)) await writeFile(path, source);
  const histories: Record<string, string> = {
    [join(home, ".bash_history")]: "bash history must remain unchanged\n",
    [join(home, ".zsh_history")]: "home history must remain unchanged\n",
    [join(zdot, ".zsh_history")]: "zsh history must remain unchanged\n",
    [join(home, "custom-history")]: "custom history must remain unchanged\n",
    [join(env.XDG_DATA_HOME!, "fish", "fish_history")]: "- cmd: history must remain unchanged\n  when: 1\n",
  };
  for (const [path, source] of Object.entries(histories)) await writeFile(path, source);
  const value = "日本語 🚀\n'\"$HOME; literal\\path\\'end\\";
  const selected = command({
    shell, cwd: "working 'directory 🚀",
    env: { TPC_VALUE: value, EMPTY: "", HISTFILE: join(home, "custom-history"), BASH_ENV: injected, ENV: injected },
    run: `${native}printf '%s\\000' "$native" "$TPC_PROFILE" "$TPC_VALUE" "$EMPTY" "$PWD" "$HISTFILE" "$BASH_ENV" "$ENV" > "$TPC_TEST_OUTPUT"\n"$TPC_TEST_BUN" -e 'await Bun.write(process.env.TPC_TEST_EXPORTED, JSON.stringify([process.env.TPC_VALUE, process.env.EMPTY, process.cwd()]))'\nprintf 'stdout before exit\\n'\nprintf 'stderr before exit\\n' >&2\nexit 23`,
  });
  await config(root, JSON.stringify({ version: 1, commands: [{ ...selected, profiles }] }));
  expect((await load(root)).commands[0].profiles).toBe(enabled);
  const result = await helper("execute", root, {
    ...env, TPC_TEST_STARTUP: startupMarker, TPC_TEST_OUTPUT: output, TPC_PROFILE: "",
    TPC_TEST_BUN: process.execPath, TPC_TEST_EXPORTED: join(root, "exported-env"),
    BASH_ENV: injected, ENV: injected, HISTFILE: join(home, "custom-history"),
    SHELLOPTS: "history:verbose:xtrace", BASHOPTS: "extdebug",
  });
  expect(result).toEqual({ status: 23, stdout: "stdout before exit\n", stderr: "stderr before exit\n" });
  expect(await readFile(output, "utf8")).toBe(`${shell}\0${profileValue}\0${value}\0\0${working}\0${join(home, "custom-history")}\0${injected}\0${injected}\0`);
  expect(JSON.parse(await readFile(join(root, "exported-env"), "utf8"))).toEqual([value, "", working]);
  const actualStartup = await readFile(startupMarker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  expect(actualStartup).toBe(startup);
  for (const [path, source] of Object.entries({ ...startupFiles, ...histories })) expect(await readFile(path, "utf8")).toBe(source);
  expect((await readdir(join(env.XDG_DATA_HOME!, "fish"))).sort()).toEqual(["fish_history"]);
});

async function failedFishExecution(mode: "rpc" | "terminal") {
  const root = await project();
  const env = await shellEnvironment(root);
  const logs = join(root, "logs");
  await mkdir(logs);
  await save({ root, revision: (await load(root)).revision, command: command({
    shell: "fish", run: "set -l native fish\nprintf '%s stdout\\n' $native\nprintf '%s stderr\\n' $native >&2\nfalse",
  }) });
  return helper(mode, root, { ...env, TMPDIR: logs });
}

test("fish background execution retains native failure status and combined output", async () => {
  const result = await failedFishExecution("rpc");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const outcome = JSON.parse(result.stdout);
  expect(outcome).toEqual({ name: "Build", status: 1, logPath: expect.any(String) });
  expect(await readFile(outcome.logPath, "utf8")).toBe("fish stdout\nfish stderr\n");
});

test("fish terminal execution reports native failure status and acknowledgement", async () => {
  const result = await failedFishExecution("terminal");
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("fish stderr\n");
  expect(result.stdout).toBe("fish stdout\n\n[Project Commands] Exit status: 1\nPress Enter to finish.\n");
});

test("named shell lookup prefers process PATH, follows symlinks for shell syntax, and honors absolute overrides", async () => {
  const root = await project();
  const env = await shellEnvironment(root);
  const first = join(root, "first bin");
  const second = join(root, "second bin");
  const invalid = join(root, "invalid bin");
  const nonFile = join(root, "directory bin");
  await Promise.all([first, second, invalid, join(nonFile, "zsh")].map(path => mkdir(path, { recursive: true })));
  const fish = Bun.which("fish");
  const zsh = Bun.which("zsh");
  expect(fish).not.toBeNull();
  expect(zsh).not.toBeNull();
  await symlink(await realpath(fish!), join(first, "zsh"));
  await symlink(await realpath(zsh!), join(second, "zsh"));
  await writeFile(join(invalid, "zsh"), "not executable\n", { mode: 0o600 });
  const fishCommand = command({ shell: "zsh", env: { PATH: second }, run: "set -l native fish\nprintf '%s\\n' $native" });
  let snapshot = await save({ root, revision: (await load(root)).revision, command: fishCommand });
  const search = [invalid, nonFile, first, second].join(delimiter);
  expect(await helper("execute", root, { ...env, PATH: search })).toEqual({ status: 0, stdout: "fish\n", stderr: "" });
  snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: command({
    shell: "zsh", run: '[[ -n "$ZSH_VERSION" ]] || exit 93\nprintf "zsh\\n"',
  }) });
  expect(await helper("execute", root, { ...env, PATH: [second, first].join(delimiter) })).toEqual({ status: 0, stdout: "zsh\n", stderr: "" });
  await save({ root, revision: snapshot.revision, originalId: "build", command: { ...fishCommand, shell: join(first, "zsh") } });
  expect(await helper("execute", root, { ...env, PATH: second })).toEqual({ status: 0, stdout: "fish\n", stderr: "" });
});

test("named shells fall back to standard directories when absent from process PATH", async () => {
  const root = await project();
  const env = await shellEnvironment(root);
  await save({ root, revision: (await load(root)).revision, command: command({ shell: "sh" }) });
  expect(await helper("execute", root, { ...env, PATH: join(root, "missing-bin") })).toEqual({ status: 0, stdout: "hello\n", stderr: "" });
});

const unavailableShells = [
  { scenario: "missing shell name fails without a replacement", select: (_root: string) => "tern-project-commands-missing-shell" },
  { scenario: "missing absolute shell fails without a replacement", select: (root: string) => join(root, "missing", "zsh") },
  { scenario: "nonexecutable shell fails without a replacement", select: (root: string) => join(root, "not-executable") },
  { scenario: "directory shell fails without a replacement", select: (root: string) => root },
];
test.each(unavailableShells)("$scenario", async ({ select }) => {
  const root = await project();
  const env = await shellEnvironment(root);
  await writeFile(join(root, "not-executable"), "not executable\n", { mode: 0o600 });
  const shell = select(root);
  await save({ root, revision: (await load(root)).revision, command: command({ shell, run: "touch forbidden" }) });
  await expect(prepare(root, "build")).rejects.toThrow(`Shell executable not found or not executable: ${shell}`);
  const result = await helper("execute", root, { ...env, PATH: "/bin:/usr/bin" });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Shell executable not found or not executable: ${shell}`);
  expect(await readdir(root)).not.toContain("forbidden");
});

test("fish setup stops at a readonly env assignment with the real status and a retained log", async () => {
  const root = await project();
  const env = await shellEnvironment(root);
  const logs = join(root, "logs");
  await mkdir(logs);
  const fish = Bun.which("fish");
  expect(fish).not.toBeNull();
  const native = Bun.spawn([fish!, "--private", "--no-config", "-c", "builtin set --global --export -- status invalid"], {
    env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const nativeStatus = await native.exited;
  expect(nativeStatus).toBeGreaterThan(0);
  await save({ root, revision: (await load(root)).revision, command: command({
    shell: "fish", env: { status: "invalid" }, run: "printf 'executed\\n' > forbidden",
  }) });
  const result = await helper("rpc", root, { ...env, TMPDIR: logs });
  expect(result.status).toBe(0);
  const outcome = JSON.parse(result.stdout);
  expect(outcome.status).toBe(nativeStatus);
  expect(await readFile(outcome.logPath, "utf8")).toContain("read-only");
  expect(await readdir(root)).not.toContain("forbidden");
});

test("prepared launches recheck disabled state in every execution entry point", async () => {
  const root = await project();
  const marker = join(root, "should-not-exist");
  let snapshot = await load(root);
  snapshot = await save({ root, revision: snapshot.revision, command: command({ run: `touch ${shellQuote(marker)}` }) });
  const prepared = await prepare(root, "build");
  snapshot = await toggle({ root, revision: snapshot.revision, id: "build", enabled: false });
  expect(snapshot.commands[0].enabled).toBe(false);
  await expect(prepare(root, "build")).rejects.toThrow("Command is disabled");
  await expect(execute(prepared.root, prepared.id)).rejects.toThrow("Command is disabled");
  await expect(run(prepared.root, prepared.id)).rejects.toThrow("Command is disabled");
  await expect(terminal(prepared.root, prepared.id)).rejects.toThrow("Command is disabled");
  const result = await helper("terminal", root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Command is disabled");
  expect(await readdir(root)).not.toContain("should-not-exist");
});

const shellExecutions = [
  { scenario: "bash with profiles Off preserves scripts, cwd, env and exit without startup files or history", shell: "/bin/bash" },
  { scenario: "zsh with profiles Off preserves scripts, cwd, env and exit without startup files or history", shell: "/bin/zsh" },
];
test.each(shellExecutions)("$scenario", async ({ shell }) => {
  const root = await project();
  const home = join(root, "home");
  const working = join(root, "working directory");
  await Promise.all([mkdir(home), mkdir(working)]);
  const startupMarker = join(root, "startup-ran");
  const startup = `printf 'unexpected startup\\n' >> ${shellQuote(startupMarker)}\nexport TPC_VALUE=overwritten\ncd /\n`;
  const startupFiles = [".profile", ".bash_profile", ".bash_login", ".bashrc", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
  for (const name of startupFiles) await writeFile(join(home, name), startup);
  const injected = join(home, "injected-env");
  await writeFile(injected, startup);
  const histories = [".bash_history", ".zsh_history", "custom-history"];
  for (const name of histories) await writeFile(join(home, name), "history must remain unchanged\n");
  const output = join(root, "result '🚀'.txt");
  const value = "日本語 🚀\n'\"$HOME; literal";
  const exactScript = `cat <<'TPC_LITERAL_END' > ${shellQuote(output)}
exact '"$HOME
日本語🚀
TPC_LITERAL_END
printf '%s\\000' "$TPC_VALUE" "$TPC_TEST_INHERITED_VALUE" "$PWD" "$EMPTY" "$BASH_ENV" "$ENV" "$HISTFILE" >> ${shellQuote(output)}
printf 'stdout before exit\\n'
printf 'stderr before exit\\n' >&2
exit 23
`;
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({
    shell, profiles: false, cwd: "working directory",
    env: { TPC_VALUE: value, EMPTY: "", BASH_ENV: injected, ENV: injected, HISTFILE: join(home, "custom-history") },
    run: exactScript,
  }) });
  const result = await helper("execute", root, {
    HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    BASH_ENV: injected, ENV: injected, SHELLOPTS: "history:verbose:xtrace", BASHOPTS: "extdebug",
    HISTFILE: join(home, "custom-history"), TPC_TEST_INHERITED_VALUE: "inherited value",
  });
  expect(await readFile(output, "utf8")).toBe(`exact '"$HOME\n日本語🚀\n${value}\0inherited value\0${working}\0\0${injected}\0${injected}\0${join(home, "custom-history")}\0`);
  expect(await readdir(root)).not.toContain("startup-ran");
  for (const name of startupFiles) expect(await readFile(join(home, name), "utf8")).toBe(startup);
  for (const name of histories) expect(await readFile(join(home, name), "utf8")).toBe("history must remain unchanged\n");
  expect((await readdir(home)).sort()).toEqual([...startupFiles, ...histories, "injected-env"].sort());
  expect(result.status).toBe(23);
  expect(result.stderr).toBe("stderr before exit\n");
  expect(result.stdout).toBe("stdout before exit\n");
});

test("background logs preserve more than 16 MiB of combined output in a unique private directory", async () => {
  const root = await project();
  const logs = join(root, "logs");
  await mkdir(logs);
  const bytes = 17 * 1024 * 1024;
  const writer = `import { writeSync } from "node:fs"; const data = Buffer.alloc(${bytes}, 120); let offset = 0; while (offset < data.length) offset += writeSync(1, data, offset); writeSync(2, "stderr-tail\\n"); process.exitCode = 37;`;
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({ run: `${shellQuote(process.execPath)} -e ${shellQuote(writer)}` }) });
  const paths = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await helper("rpc", root, { TMPDIR: logs });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const outcome = JSON.parse(result.stdout);
    expect(outcome).toEqual({ name: "Build", status: 37, logPath: expect.any(String) });
    expect(dirname(dirname(outcome.logPath))).toBe(logs);
    expect((await stat(outcome.logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(outcome.logPath))).mode & 0o777).toBe(0o700);
    const output = await readFile(outcome.logPath);
    expect(output.length).toBe(bytes + Buffer.byteLength("stderr-tail\n"));
    expect(output.subarray(0, bytes).equals(Buffer.alloc(bytes, 120))).toBe(true);
    expect(output.subarray(bytes).toString()).toBe("stderr-tail\n");
    paths.add(outcome.logPath);
  }
  expect(paths.size).toBe(2);
  expect(await readdir(logs)).toHaveLength(2);
});

test("successful background execution removes both log and directory and inherits ordinary env", async () => {
  const root = await project();
  const logs = join(root, "logs");
  await mkdir(logs);
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({ run: `printf '%s\\000' "$TPC_INHERITED" "$HISTFILE" > result\nprintf 'discard success output\\n'\nprintf 'discard success stderr\\n' >&2` }) });
  const result = await helper("rpc", root, { TMPDIR: logs, TPC_INHERITED: "keep '$literal\nvalue", HISTFILE: join(root, "untouched-history") });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ name: "Build", status: 0 });
  expect(await readFile(join(root, "result"), "utf8")).toBe("keep '$literal\nvalue\0/dev/null\0");
  expect(await readdir(logs)).toEqual([]);
  expect(await readdir(root)).not.toContain("untouched-history");
});

test("background stdin receives EOF even while the helper parent stdin stays open", async () => {
  const root = await project();
  const logs = join(root, "logs");
  await mkdir(logs);
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({ run: "if IFS= read -r value; then exit 81; fi\nprintf 'EOF\\n' > stdin-result" }) });
  const child = Bun.spawn([process.execPath, "-e", `import { run } from ${JSON.stringify(helperPath)}; console.log(JSON.stringify(await run(${JSON.stringify(root)}, "build")));`], {
    env: { ...process.env, TMPDIR: logs }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ name: "Build", status: 0 });
    expect(await readFile(join(root, "stdin-result"), "utf8")).toBe("EOF\n");
    expect(await readdir(logs)).toEqual([]);
  } finally {
    child.stdin.end();
  }
});

test("a command that cannot spawn still returns a readable failure log", async () => {
  const root = await project();
  const logs = join(root, "logs");
  await mkdir(logs);
  const shell = join(root, "unavailable-interpreter");
  await writeFile(shell, "#!/nonexistent/tern-project-commands-interpreter\n");
  await chmod(shell, 0o700);
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({ shell, run: "touch forbidden" }) });
  const result = await helper("rpc", root, { TMPDIR: logs });
  expect(result.status).toBe(0);
  const outcome = JSON.parse(result.stdout);
  expect(outcome.status).toBe(1);
  expect(await readFile(outcome.logPath, "utf8")).toContain(shell);
  expect(await readdir(root)).not.toContain("forbidden");
});

test("unsupported readonly shell assignments report the real shell failure and retain its log", async () => {
  const root = await project();
  const logs = join(root, "logs");
  await mkdir(logs);
  const initial = await load(root);
  await save({ root, revision: initial.revision, command: command({
    shell: "/bin/bash", env: { SHELLOPTS: "history" }, run: "printf 'executed\\n' > forbidden",
  }) });
  const result = await helper("rpc", root, { TMPDIR: logs });
  expect(result.status).toBe(0);
  const outcome = JSON.parse(result.stdout);
  expect(outcome.status).toBe(1);
  expect(await readFile(outcome.logPath, "utf8")).toContain("readonly variable");
  expect(await readdir(root)).not.toContain("forbidden");
});

test("cwd symlinks cannot escape the root and nonexistent cwd is not executed", async () => {
  const root = await project();
  const outside = await project();
  await symlink(outside, join(root, "linked"));
  let snapshot = await load(root);
  snapshot = await save({ root, revision: snapshot.revision, command: command({ cwd: "linked" }) });
  await expect(prepare(root, "build")).rejects.toThrow("outside the project root");
  await expect(execute(root, "build")).rejects.toThrow("outside the project root");
  await expect(run(root, "build")).rejects.toThrow("outside the project root");
  await expect(terminal(root, "build")).rejects.toThrow("outside the project root");
  snapshot = await save({ root, revision: snapshot.revision, originalId: "build", command: command({ cwd: "not-created" }) });
  await expect(prepare(root, "build")).rejects.toThrow();
  await expect(run(root, "build")).rejects.toThrow();
  expect(snapshot.commands[0].cwd).toBe("not-created");
});
