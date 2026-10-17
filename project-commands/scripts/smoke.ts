import type { Subprocess } from "bun";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

const plugin = resolve(import.meta.dir, "..");
const tern = Bun.which("tern");
if (!tern) throw new Error("Install desktop Tern 0.9.2 or newer before running this smoke.");
const root = await mkdtemp(join(tmpdir(), "tern-commands-smoke-"));
const project = join(root, "project");
const otherProject = join(root, "other-project");
const emptyProject = join(root, "empty-project");
const config = join(root, "config");
const socket = join(root, "daemon.sock");
for (const directory of ["home", "logs", "config/plugins", "project/.git", "project/build space", "other-project/.git", "other-project/.omp", "empty-project/.git"]) {
  await mkdir(join(root, directory), { recursive: true });
}
await writeFile(join(otherProject, ".omp/tern-commands.yaml"), stringify({
  version: 1,
  commands: [
    { id: "smoke-build", name: "Other project build", shell: "/bin/sh", run: "printf 'SECOND_PROJECT\\n' > second-result.txt\nprintf 'PC_SECOND_OK\\n'" },
    { id: "other-only", name: "Other project only", run: "printf 'other command\\n'" },
  ],
}));
await writeFile(join(config, "settings.json"), JSON.stringify({ plugins: true, shell: "/bin/zsh" }));
const env = { ...process.env, HOME: join(root, "home"), TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: socket, TERN_PROJECT_COMMANDS_BUN: process.execPath,
  STENCIL_LOG_DIR: join(root, "logs"), STENCIL_LOG: "warn" };
for (const key of ["TERN_WINDOW_KEY", "TERN_WINDOW_SOCKET", "TERN_PANE", "TERN_PANE_SOCKET", "TERN_IDENTITY"]) delete env[key];

const server = createServer();
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
const commands: { command: string; result: unknown }[] = [];
const observations: Record<string, unknown> = {};

async function run(args: string[]) {
  const child = Bun.spawn([tern!, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
async function ctl(command: string): Promise<any> {
  const result = JSON.parse(await run(["ctl", "--control", port, command]));
  commands.push({ command, result });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const selector = (id: string) => `[data-id='${id}']`;
const click = (id: string) => ctl(`click ${JSON.stringify(selector(id))}`);
async function focusField(id: string) {
  await eventually(async () => (await ctl(`tree ${selector(id)}`)).count === 1, `field ${id}`);
  await click(id);
  await eventually(async () => (await ctl(`tree ${selector(id)}.focused`)).count === 1, `focus ${id}`);
}
async function fill(id: string, value: string) {
  await focusField(id);
  await ctl("key Meta+a");
  await ctl(`type ${JSON.stringify(value)}`);
  await eventually(async () => {
    const node = (await ctl(`tree ${selector(id)}`)).nodes[0];
    return (node?.text ?? "").replace(/\s+/g, " ").trim() === value.replace(/\s+/g, " ").trim();
  }, `text ${id}`);
}
async function openPalette(expected: string[], query = "Project Commands") {
  let labels: string[] = [];
  await eventually(async () => {
    // Tern snapshots available commands when opening the palette. A config read
    // still in flight may require reopening; polling the open list cannot update it.
    await ctl("key Meta+k");
    await eventually(async () => (await ctl("state")).palette !== null, "Cmd+K palette");
    await ctl("key Meta+a");
    await ctl(`type ${JSON.stringify(query)}`);
    const tree = await ctl("tree .ck-list .ck-label");
    labels = tree.nodes.map((node: { text?: string }) => node.text ?? "").filter((label: string) => label.startsWith("Project Commands:")).sort();
    if (JSON.stringify(labels) === JSON.stringify([...expected].sort())) return true;
    await ctl("key Escape");
    await eventually(async () => (await ctl("state")).palette === null, "closed palette");
    return false;
  }, `palette rows ${expected.join(", ")}`);
  return labels;
}
const configFile = join(project, ".omp/tern-commands.yaml");
const saved = async () => parse(await readFile(configFile, "utf8"));
const shot = async (name: string) => {
  const result = await ctl(`shot ${name}`);
  return resolve(project, result.png);
};
let window: Subprocess<"ignore", "ignore", "ignore"> | undefined;
let daemon: Subprocess<"ignore", "ignore", "ignore"> | undefined;
try {
  observations.tern = (await run(["--version"])).trim();
  observations.bun = Bun.version;
  const dir = JSON.parse(await run(["plugin", "dir", "--json"]));
  assert.equal(dir.dir, join(config, "plugins"));
  observations.pluginTarget = dir.dir;
  daemon = Bun.spawn([tern, "daemon", "--socket", socket], { cwd: project, env,
    stdout: Bun.file(join(root, "daemon.stdout")), stderr: Bun.file(join(root, "daemon.stderr")) });
  await eventually(async () => existsSync(socket), "isolated daemon socket");
  observations.registration = JSON.parse(await run(["plugin", "link", plugin, "--json"]));
  window = Bun.spawn([tern, "--control", port, project], { cwd: project, env,
    stdout: Bun.file(join(root, "window.stdout")), stderr: Bun.file(join(root, "window.stderr")) });
  await eventually(async () => {
    try { await ctl("state"); return true; } catch { return false; }
  }, "isolated desktop window");
  // Tern's official local test scenario changes only this isolated window's gate.
  await ctl("account signed-in Plugin-QA");
  await ctl("ready");
  await ctl("plugins run plugin.project-commands.open");
  await ctl('plugins expect "No commands yet"');
  const manager = (await ctl("state")).focused.id;
  await click("main.page.toolbar.new");
  await ctl('plugins expect "Run (multiline shell script)"');
  await fill("main.page.form.id.input", "smoke-build");
  await fill("main.page.form.name.input", "日本語ビルド 🚀");
  await fill("main.page.form.cwd.input", "build space");
  const script = 'printf \'%s\\n\' "$PC_SMOKE" > result.txt\nprintf \'PC_SMOKE_OK\\n\'';
  const value = "日本語 'quoted' $literal";
  await fill("main.page.form.run.input", script);
  await click("main.page.form.env.add");
  await fill("main.page.form.env.rows.e1.key", "PC_SMOKE");
  await fill("main.page.form.env.rows.e1.value", value);
  observations.formScreenshot = await shot("command-form");
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  let document = await saved();
  assert.equal(document.version, 1);
  assert.equal(document.commands[0].name, "日本語ビルド 🚀");
  assert.equal(document.commands[0].cwd, "build space");
  assert.equal(document.commands[0].run, script);
  assert.deepEqual(document.commands[0].env, { PC_SMOKE: value });
  observations.created = document;
  observations.paletteCreated = await openPalette(["Project Commands: Open manager", "Project Commands: 日本語ビルド 🚀"]);
  observations.paletteScreenshot = await shot("command-palette");
  await ctl("key Escape");

  const actions = "main.page.commands.smoke-build.actions.";
  await click(actions + "toggle");
  await ctl('plugins expect "Turn On"');
  assert.equal((await saved()).commands[0].enabled, false);
  const tabs = (await ctl("state")).tabs;
  await click(actions + "run");
  assert.deepEqual((await ctl("state")).tabs, tabs);
  assert.equal(existsSync(join(project, "build space/result.txt")), false);
  observations.disabled = { enabled: false, openedPane: false, outputCreated: false };
  observations.offScreenshot = await shot("command-off");
  observations.paletteDisabled = await openPalette(["Project Commands: Open manager"]);
  await ctl("key Escape");

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await focusField("main.page.form.name.input");
  await ctl("key Meta+ArrowRight");
  await ctl("type X");
  await ctl("key Meta+z");
  await eventually(async () => (await ctl(`tree ${selector("main.page.form.name.input")}`)).nodes[0]?.text === "日本語ビルド 🚀", "Unicode undo");
  const nameNode = await ctl(`tree ${selector("main.page.form.name.input")}`);
  assert.equal(nameNode.nodes[0].text, "日本語ビルド 🚀");
  observations.unicodeUndo = nameNode.nodes[0].text;
  await fill("main.page.form.name.input", "Cancelled change");
  const beforeCancel = await readFile(configFile, "utf8");
  await click("dock.actions.cancel");
  await ctl('plugins expect "Turn On"');
  assert.equal(await readFile(configFile, "utf8"), beforeCancel);
  observations.cancelPreservedBytes = true;

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await fill("main.page.form.name.input", "編集済みビルド 🚀");
  await click("main.page.form.env.add");
  await fill("main.page.form.env.rows.e4.key", "REMOVE_ME");
  await fill("main.page.form.env.rows.e4.value", "discarded");
  await click("main.page.form.env.rows.e4.remove");
  await eventually(async () => (await ctl(`tree ${selector("main.page.form.env.rows.e4.key")}`)).count === 0, "removed environment row");
  await click("main.page.form.enabled.check");
  await ctl('plugins expect "Enabled — On"');
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  document = await saved();
  assert.equal(document.commands[0].name, "編集済みビルド 🚀");
  assert.equal(document.commands[0].enabled, true);
  assert.deepEqual(document.commands[0].env, { PC_SMOKE: value });
  observations.edited = document;
  observations.listScreenshot = await shot("command-list");
  observations.paletteRenamed = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");
  await click(actions + "run");
  await eventually(async () => (await ctl("state")).focused.id !== manager, "separate execution pane");
  await ctl('expect "PC_SMOKE_OK"');
  await ctl("ready");
  const result = (await ctl("state")).focused;
  assert.notEqual(result.id, manager);
  assert.equal(result.exited, null);
  assert.equal(result.last.status, 0);
  assert.equal(await readFile(join(project, "build space/result.txt"), "utf8"), value + "\n");
  observations.execution = result;
  observations.output = await readFile(join(project, "build space/result.txt"), "utf8");
  observations.outputScreenshot = await shot("command-output");

  // Change directory in an existing pane: the same command ID must resolve in the new project.
  await ctl(`run ${JSON.stringify("cd '" + otherProject.replaceAll("'", "'\\''") + "'")}`);
  await ctl("ready");
  observations.paletteOtherProject = await openPalette([
    "Project Commands: Open manager", "Project Commands: Other project build", "Project Commands: Other project only",
  ]);
  observations.paletteOtherScreenshot = await shot("palette-other-project");
  await ctl("key Escape");
  await openPalette(["Project Commands: Other project build"], "Other project build");
  const otherSource = (await ctl("state")).focused.id;
  await ctl("key Enter");
  await eventually(async () => (await ctl("state")).focused.id !== otherSource, "palette execution in separate pane");
  await ctl('expect "PC_SECOND_OK"');
  await ctl("ready");
  const otherResult = (await ctl("state")).focused;
  assert.equal(otherResult.last.status, 0);
  assert.equal(otherResult.exited, null);
  assert.equal(await readFile(join(otherProject, "second-result.txt"), "utf8"), "SECOND_PROJECT\n");
  assert.equal(await readFile(join(project, "build space/result.txt"), "utf8"), value + "\n");
  observations.paletteExecution = otherResult;
  observations.paletteOutputScreenshot = await shot("palette-command-output");

  await ctl(`run ${JSON.stringify("cd '" + emptyProject.replaceAll("'", "'\\''") + "'")}`);
  await ctl("ready");
  observations.paletteEmptyProject = await openPalette(["Project Commands: Open manager"]);
  await ctl("key Escape");
  await ctl("tab 2");
  observations.paletteReturned = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");

  // Manual definition removal followed by Reload must retire its palette row.
  const extra = { id: "temporary-command", name: "Temporary command", run: "printf 'temporary\\n'" };
  await writeFile(configFile, stringify({ ...document, commands: [...document.commands, extra] }));
  await click("main.page.toolbar.reload");
  await ctl('plugins expect "Temporary command"');
  observations.paletteReloadAdded = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀", "Project Commands: Temporary command",
  ]);
  await ctl("key Escape");
  await writeFile(configFile, stringify(document));
  await click("main.page.toolbar.reload");
  observations.paletteReloadRemoved = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");
  await run(["plugin", "reload", "--json"]);
  observations.palettePluginReload = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");
  const diagnostic = await readFile(join(root, "logs/tern.log"), "utf8").catch(() => "");
  assert.doesNotMatch(diagnostic, /plugin (?:handler failed|style sheet has errors|window entry failed)/);
  observations.runtimeDiagnostics = diagnostic;
  observations.passed = true;
} catch (error) {
  observations.passed = false;
  observations.error = String(error);
  throw error;
} finally {
  if (window) {
    try { await ctl("quit"); } catch { /* The owned window may have already exited. */ }
    window.kill();
    await window.exited;
  }
  if (daemon) { daemon.kill(); await daemon.exited; }
  const files = ["plugin.toml", "window.luau", "host.luau", "lib/bridge.luau", "lib/editor.luau", "helper.ts", "style.css", "bun.lock", "scripts/smoke.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async path => [path,
    createHash("sha256").update(await readFile(join(plugin, path))).digest("hex")])));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ sourceHashes, observations, commands }, null, 2));
  console.log(JSON.stringify({ passed: observations.passed, evidence: join(root, "evidence.json"), observations }, null, 2));
}
