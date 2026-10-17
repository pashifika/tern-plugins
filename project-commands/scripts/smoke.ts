import type { Subprocess } from "bun";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

const plugin = resolve(import.meta.dir, "..");
const tern = Bun.which("tern");
if (!tern) throw new Error("Install desktop Tern 0.9.2 or newer before running this smoke.");
const desktopShell = Bun.which("zsh");
if (!desktopShell) throw new Error("Install zsh before running this smoke.");
if (!Bun.which("fish")) throw new Error("Install fish before running this smoke.");
const root = await mkdtemp(join(tmpdir(), "tern-commands-smoke-"));
const project = join(root, "project");
const otherProject = join(root, "other-project");
const emptyProject = join(root, "empty-project");
const config = join(root, "config");
const home = join(root, "home");
const fishConfigHome = join(root, "fish-config");
const fishDataHome = join(root, "fish-data");
const fishHistoryFile = join(fishDataHome, "fish/fish_history");
const startupFile = join(home, "startup.log");
const historyFile = join(home, ".zsh_history");
const socket = join(root, "daemon.sock");
for (const directory of ["home", "fish-config/fish", "fish-data/fish", "shell-env", "logs", "config/plugins", "project/.git", "project/build space", "other-project/.git", "other-project/.omp", "empty-project/.git"]) {
  await mkdir(join(root, directory), { recursive: true });
}
// Tern builds terminal environments separately from the GUI's HOME. Scope the
// owned desktop's actual shell launches too, not just its installation directory.
await writeFile(join(root, "shell-env/plugin.toml"), 'schema = 1\nid = "test-shell-env"\nname = "Isolated shell environment"\nversion = "0.0.0"\nhost = "host.luau"\n');
await writeFile(join(root, "shell-env/host.luau"), `tern.on("spawn", function(spec)
  spec.env.HOME = ${JSON.stringify(home)}
  spec.env.HISTFILE = ${JSON.stringify(historyFile)}
  spec.env.XDG_CONFIG_HOME = ${JSON.stringify(fishConfigHome)}
  spec.env.XDG_DATA_HOME = ${JSON.stringify(fishDataHome)}
  return spec
end)\n`);
await writeFile(startupFile, "");
await writeFile(historyFile, "");
await writeFile(fishHistoryFile, "- cmd: PC_FISH_HISTORY_BASELINE\n  when: 1\n");
for (const name of [".zshenv", ".zprofile", ".zshrc"]) {
  await writeFile(join(home, name), [
    `printf '%s\\n' '${name}' >> "$HOME/startup.log"`,
    'HISTFILE="$HOME/.zsh_history"',
    "HISTSIZE=10000",
    "SAVEHIST=10000",
    ...(name === ".zshrc" ? ["setopt APPEND_HISTORY INC_APPEND_HISTORY"] : []),
    ...(name === ".zprofile" ? [
      "if [[ ! -o interactive ]]; then",
      "  export PC_PROFILE=ZSH_PROFILE",
      "  export PC_SMOKE='profile should not override literal'",
      '  cd "$HOME"',
      "fi",
    ] : []),
    "",
  ].join("\n"));
}
await writeFile(join(fishConfigHome, "fish/config.fish"), [
  'printf \'%s\\n\' config.fish >> "$HOME/startup.log"',
  "set -gx PC_PROFILE FISH_PROFILE",
  "set -gx PC_SMOKE 'profile should not override literal'",
  'cd "$HOME"',
  "",
].join("\n"));
await writeFile(join(otherProject, ".omp/tern-commands.yaml"), stringify({
  version: 1,
  commands: [
    { id: "smoke-build", name: "Other project build", shell: "/bin/sh", profiles: false, run: "printf 'SECOND_PROJECT\\n' > second-result.txt\nprintf 'PC_SECOND_OK\\n'" },
    { id: "other-only", name: "Other project only", profiles: false, run: "printf 'other command\\n'" },
  ],
}));
await writeFile(join(config, "settings.json"), JSON.stringify({ plugins: true, shell: desktopShell }));
const env = { ...process.env, HOME: home, ZDOTDIR: home, HISTFILE: historyFile,
  XDG_CONFIG_HOME: fishConfigHome, XDG_DATA_HOME: fishDataHome, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: socket, TERN_PROJECT_COMMANDS_BUN: process.execPath,
  STENCIL_LOG_DIR: join(root, "logs"), STENCIL_LOG: "warn" };
for (const key of ["TERN_WINDOW_KEY", "TERN_WINDOW_SOCKET", "TERN_PANE", "TERN_PANE_SOCKET", "TERN_IDENTITY", "PC_PROFILE", "PC_SMOKE"]) delete env[key];

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
async function eventually(check: () => Promise<boolean>, label: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
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
  // `tree` caps node text at 200 characters; the surface assertion reads the full value.
  await ctl(`plugins expect ${JSON.stringify(value)}`);
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
interface ShellEffects {
  startup: string;
  history: string;
  fishHistory: string;
}
interface TabState {
  title: string;
  panes: number;
  active: boolean;
}
interface LayoutState {
  focused: { id: number };
  tabs: TabState[];
  panes: { id: number }[];
}
interface TreeResult {
  count: number;
  nodes: { text?: string }[];
}
const backgroundId = "main.page.form.background.check";
const profilesId = "main.page.form.profiles.check";
async function profilesChoice(checked: boolean) {
  const result = await ctl(`tree ${selector(profilesId)}[aria-checked='${checked}']`);
  assert.equal(result.count, 1, `profiles checkbox checked=${checked}`);
  return result.nodes[0];
}
async function backgroundChoice(checked: boolean) {
  const result = await ctl(`tree ${selector(backgroundId)}[aria-checked='${checked}']`);
  assert.equal(result.count, 1, `background checkbox checked=${checked}`);
  return result.nodes[0];
}
const undoId = "main.page.toolbar.undo";
async function undoChoice(count: number) {
  let result: TreeResult = { count: 0, nodes: [] };
  await eventually(async () => {
    result = await ctl(`tree ${selector(undoId)}[aria-disabled='${count === 0}']`);
    return result.count === 1 && result.nodes[0]?.text === `Undo delete (${count})`;
  }, `Undo delete (${count}), disabled=${count === 0}`);
  return result;
}
async function commandRow(id: string, present: boolean) {
  let result: TreeResult = { count: 0, nodes: [] };
  await eventually(async () => {
    result = await ctl(`tree ${selector("main.page.commands." + id)}`);
    return result.count === (present ? 1 : 0);
  }, `${id}: row ${present ? "present" : "absent"}`);
  return result;
}
async function deleteCommand(command: { id: string; name: string }, count: number) {
  await click("main.page.commands." + command.id + ".actions.delete");
  const row = await commandRow(command.id, false);
  const undo = await undoChoice(count);
  const document = await saved();
  assert.equal(document.commands.some((item: { id: string }) => item.id === command.id), false);
  const notice: TreeResult = await ctl(`tree ${selector("main.page.notice")}`);
  assert(notice.nodes.some(node => node.text?.includes(command.name)), "deletion notice must name the removed command");
  const hint: TreeResult = await ctl(`tree ${selector("main.page.undo-hint")}`);
  assert(hint.nodes.some(node => node.text === "Deletion undo is available until this manager closes."));
  return { document, row, undo, notice, hint };
}
async function restoreCommand(command: { id: string; name: string }, count: number, keyboard = false) {
  if (keyboard) await ctl("key Meta+z");
  else await click(undoId);
  const row = await commandRow(command.id, true);
  const undo = await undoChoice(count);
  const document = await saved();
  assert.deepEqual(document.commands.find((item: { id: string }) => item.id === command.id), command,
    "Undo must restore the exact deleted command");
  const notice: TreeResult = await ctl(`tree ${selector("main.page.notice")}`);
  assert(notice.nodes.some(node => node.text?.includes(command.name)), "restore notice must name the restored command");
  return { document, row, undo, notice };
}
const shellEffects = async (): Promise<ShellEffects> => ({
  startup: await readFile(startupFile, "utf8"),
  history: await readFile(historyFile, "utf8"),
  fishHistory: await readFile(fishHistoryFile, "utf8"),
});
async function assertShellUntouched(before: ShellEffects, label: string) {
  const after = await shellEffects();
  assert.deepEqual(after, before, `${label}: plugin execution must not load profiles or write shell history`);
  return after;
}
async function assertProfilesLoaded(before: ShellEffects, shell: "zsh" | "fish") {
  const after = await shellEffects();
  assert.equal(after.history, before.history, `${shell}: profile loading must not write zsh history`);
  assert.equal(after.fishHistory, before.fishHistory, `${shell}: profile loading must not write fish history`);
  assert.equal(after.startup, before.startup + (shell === "zsh" ? ".zshenv\n.zprofile\n" : "config.fish\n"),
    `${shell}: only noninteractive login startup must run`);
  return after;
}
function assertSameLayout(state: LayoutState, before: LayoutState, label: string) {
  assert.equal(state.focused.id, before.focused.id, `${label}: focus changed`);
  assert.deepEqual(state.tabs.map(tab => ({ title: tab.title, panes: tab.panes, active: tab.active })),
    before.tabs.map(tab => ({ title: tab.title, panes: tab.panes, active: tab.active })), `${label}: tabs changed`);
  assert.deepEqual(state.panes.map(pane => pane.id), before.panes.map(pane => pane.id), `${label}: panes changed`);
}
async function backgroundSuccess(action: () => Promise<unknown>, path: string, output: string, name: string, timeoutMs = 20000, profiles?: "zsh" | "fish") {
  const before = await ctl("state");
  const effects = await shellEffects();
  const started = Date.now();
  await action();
  let after = before;
  let hud: TreeResult | undefined;
  await eventually(async () => {
    after = await ctl("state");
    assertSameLayout(after, before, name);
    const currentHud: TreeResult = await ctl("tree .toast[role='status']");
    hud = currentHud;
    return currentHud.nodes.some(node => node.text?.includes(`${name} — succeeded`))
      && await readFile(path, "utf8").catch(() => null) === output;
  }, `${name}: background output and success HUD`, timeoutMs);
  return { before, after, hud, elapsedMs: Date.now() - started, output: await readFile(path, "utf8"),
    shellEffects: profiles ? await assertProfilesLoaded(effects, profiles) : await assertShellUntouched(effects, name) };
}
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
  observations.shellIsolation = JSON.parse(await run(["plugin", "link", join(root, "shell-env"), "--json"]));
  window = Bun.spawn([tern, "--control", port, project], { cwd: project, env,
    stdout: Bun.file(join(root, "window.stdout")), stderr: Bun.file(join(root, "window.stderr")) });
  await eventually(async () => {
    try { await ctl("state"); return true; } catch { return false; }
  }, "isolated desktop window");
  // Tern's official local test scenario changes only this isolated window's gate.
  await ctl("account signed-in Plugin-QA");
  await ctl("ready");
  const originalShell = (await ctl("state")).focused.id;
  await ctl(`run ${JSON.stringify("printf 'PC_NORMAL_SHELL_BASELINE\\n'")}`);
  await ctl("ready");
  await eventually(async () => (await readFile(historyFile, "utf8")).includes("PC_NORMAL_SHELL_BASELINE"), "isolated shell history baseline");
  const initialEffects = await shellEffects();
  for (const name of [".zshenv", ".zprofile", ".zshrc"]) assert(initialEffects.startup.split("\n").includes(name), `normal shell must load isolated ${name}`);
  observations.initialShell = { id: originalShell, ...initialEffects };
  await ctl("plugins run plugin.project-commands.open");
  await ctl('plugins expect "No commands yet"');
  const manager = (await ctl("state")).focused.id;
  await click("main.page.toolbar.new");
  await ctl('plugins expect "Run (multiline shell script)"');
  await ctl('plugins expect "Run in background — On"');
  observations.defaultBackgroundCheckbox = await backgroundChoice(true);
  await ctl('plugins expect "Load shell profiles — On"');
  observations.defaultProfilesCheckbox = await profilesChoice(true);
  observations.defaultProfilesSnapshot = await ctl(`tree ${selector("main.page.form.profiles")}`);
  observations.defaultShell = (await ctl(`tree ${selector("main.page.form.shell.input")}`)).nodes[0]?.text;
  assert.equal(observations.defaultShell, "zsh");
  await fill("main.page.form.id.input", "smoke-build");
  await fill("main.page.form.name.input", "日本語ビルド 🚀");
  await fill("main.page.form.cwd.input", "build space");
  const script = 'printf \'%s\\n\' "$PC_SMOKE" > result.txt\nprintf \'%s\\n\' "$PC_PROFILE" > profile-result.txt\npwd -P >> profile-result.txt\nprintf \'PC_SMOKE_OK\\n\'';
  const fishScript = 'set -l fish_probe FISH_NATIVE\n' + script + '\nprintf \'%s\\n\' "$fish_probe" > fish-native.txt';
  const value = "日本語 'quoted' \"double\" \\backslash $literal";
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
  assert.equal(document.commands[0].execution, "background");
  assert.equal(document.commands[0].shell, "zsh");
  assert.equal(document.commands[0].profiles, true);
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
  await backgroundChoice(true);
  observations.persistedProfilesOnCheckbox = await profilesChoice(true);
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
  await click(backgroundId);
  await backgroundChoice(false);
  await click(profilesId);
  await profilesChoice(false);
  await click("dock.actions.cancel");
  await ctl('plugins expect "Turn On"');
  assert.equal(await readFile(configFile, "utf8"), beforeCancel);
  observations.cancelPreservedBytes = true;
  assert.equal((await saved()).commands[0].execution, "background");
  assert.equal((await saved()).commands[0].profiles, true);
  observations.cancelPreservedProfiles = true;

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await backgroundChoice(true);
  await profilesChoice(true);
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
  assert.equal(document.commands[0].execution, "background");
  assert.equal(document.commands[0].profiles, true);
  observations.edited = document;
  observations.listScreenshot = await shot("command-list");
  observations.paletteRenamed = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");
  const outputFile = join(project, "build space/result.txt");
  const profileOutputFile = join(project, "build space/profile-result.txt");
  const commandCwd = await realpath(join(project, "build space"));
  const zshProfilesOn = await backgroundSuccess(() => click(actions + "run"),
    outputFile, value + "\n", "編集済みビルド 🚀", 20000, "zsh");
  assert.equal(await readFile(profileOutputFile, "utf8"), `ZSH_PROFILE\n${commandCwd}\n`);
  observations.zshProfilesOn = { ...zshProfilesOn, shell: "zsh", profiles: true,
    profileOutput: await readFile(profileOutputFile, "utf8") };
  observations.profilesOnScreenshot = await shot("zsh-profiles-on");

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await profilesChoice(true);
  await click(profilesId);
  await ctl('plugins expect "Load shell profiles — Off"');
  observations.profilesOffCheckbox = await profilesChoice(false);
  observations.profilesOffSnapshot = await ctl(`tree ${selector("main.page.form.profiles")}`);
  observations.profilesOffScreenshot = await shot("command-profiles-off");
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  assert.equal((await saved()).commands[0].profiles, false);
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  observations.persistedProfilesOffCheckbox = await profilesChoice(false);
  await click("dock.actions.cancel");
  await writeFile(outputFile, "stale output\n");
  const defaultBackground = await backgroundSuccess(() => click(actions + "run"), outputFile, value + "\n", "編集済みビルド 🚀");
  assert.equal(await readFile(profileOutputFile, "utf8"), `\n${commandCwd}\n`);
  observations.defaultBackground = { ...defaultBackground, shell: "zsh", profiles: false,
    profileOutput: await readFile(profileOutputFile, "utf8") };
  assert.equal((await ctl(`tree ${selector("main.page.commands.smoke-build.execution")}`)).nodes[0]?.text, "execution: background");
  observations.backgroundScreenshot = await shot("background-success");

  // A background build must outlive the configuration RPC's former 15-second limit.
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  const longScript = "sleep 16\nprintf 'PC_LONG_BACKGROUND\\n' > long-result.txt\nprintf 'PC_LONG_STDOUT\\n'";
  await fill("main.page.form.run.input", longScript);
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  const longBackground = await backgroundSuccess(() => click(actions + "run"),
    join(project, "build space/long-result.txt"), "PC_LONG_BACKGROUND\n", "編集済みビルド 🚀", 30000);
  assert(longBackground.elapsedMs >= 15000);
  observations.longBackground = longBackground;
  observations.longBackgroundScreenshot = await shot("background-long-success");

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await fill("main.page.form.name.input", "Failing background build");
  await fill("main.page.form.run.input", "printf 'PC_FAILURE_STDOUT\\n'\nprintf 'PC_FAILURE_STDERR\\n' >&2\nexit 23");
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  const beforeFailure = await ctl("state");
  const failureEffects = await shellEffects();
  await click(actions + "run");
  let failureState = beforeFailure;
  let failureHud: TreeResult | undefined;
  await eventually(async () => {
    failureState = await ctl("state");
    const currentHud: TreeResult = await ctl("tree .toast[role='alert']");
    failureHud = currentHud;
    return failureState.focused.id !== manager && failureState.file_blocks.length === 1
      && currentHud.nodes.some(node => node.text?.includes("Failing background build — failed (exit 23)"));
  }, "background failure opens native file tab and failure HUD");
  assert.equal(failureState.tabs.length, beforeFailure.tabs.length + 1);
  assert(failureState.tabs.every((tab: TabState) => tab.panes === 1), "failure log must open in a new tab, not a split");
  assert.notEqual(failureState.focused.id, originalShell);
  const logPath = failureState.file_blocks[0].path;
  assert.equal(typeof logPath, "string", JSON.stringify(failureState.file_blocks));
  assert(isAbsolute(logPath), "failure log must name a real file");
  const logStat = await stat(logPath);
  assert(logStat.isFile());
  assert.equal(logStat.mode & 0o777, 0o600, "failure log must be private");
  assert.equal((await stat(dirname(logPath))).mode & 0o777, 0o700, "failure log directory must be private");
  const logContent = await readFile(logPath, "utf8");
  assert.match(logContent, /PC_FAILURE_STDOUT/);
  assert.match(logContent, /PC_FAILURE_STDERR/);
  await ctl("file wait loaded");
  await ctl("carly lua return cx.session:read(cx.session:focused())");
  await ctl("carly ok");
  await ctl("carly last PC_FAILURE_STDOUT");
  await ctl("carly last PC_FAILURE_STDERR");
  const logView = (await ctl("state")).carly.last_tool;
  await ctl("carly close");
  observations.backgroundFailure = { state: failureState, hud: failureHud, logPath, logContent,
    logMode: logStat.mode & 0o777, view: logView, shellEffects: await assertShellUntouched(failureEffects, "background failure") };
  observations.failureScreenshot = await shot("background-failure-log");

  await ctl("tab 2");
  assert.equal((await ctl("state")).focused.id, manager);
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await fill("main.page.form.name.input", "編集済みビルド 🚀");
  await fill("main.page.form.shell.input", "fish");
  await fill("main.page.form.run.input", fishScript);
  await profilesChoice(false);
  await click(profilesId);
  await profilesChoice(true);
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  document = await saved();
  assert.equal(document.commands[0].shell, "fish");
  assert.equal(document.commands[0].profiles, true);
  assert.equal(document.commands[0].run, fishScript);
  await writeFile(outputFile, "stale output\n");
  const fishProfilesOn = await backgroundSuccess(() => click(actions + "run"),
    outputFile, value + "\n", "編集済みビルド 🚀", 20000, "fish");
  assert.equal(await readFile(profileOutputFile, "utf8"), `FISH_PROFILE\n${commandCwd}\n`);
  assert.equal(await readFile(join(project, "build space/fish-native.txt"), "utf8"), "FISH_NATIVE\n");
  observations.fishProfilesOn = { ...fishProfilesOn, shell: "fish", profiles: true,
    profileOutput: await readFile(profileOutputFile, "utf8"), nativeOutput: "FISH_NATIVE\n" };
  observations.fishProfilesScreenshot = await shot("fish-profiles-on");

  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await profilesChoice(true);
  await click(profilesId);
  await profilesChoice(false);
  await fill("main.page.form.run.input", fishScript + "\nprintf 'PC_TAB_STDERR\\n' >&2");
  await click(backgroundId);
  await ctl('plugins expect "Run in background — Off (new terminal tab)"');
  observations.tabCheckbox = await backgroundChoice(false);
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  assert.equal((await saved()).commands[0].execution, "tab");
  assert.equal((await saved()).commands[0].shell, "fish");
  assert.equal((await saved()).commands[0].profiles, false);
  assert.equal((await saved()).commands[0].run, fishScript + "\nprintf 'PC_TAB_STDERR\\n' >&2");
  assert.equal((await ctl(`tree ${selector("main.page.commands.smoke-build.execution")}`)).nodes[0]?.text, "execution: tab");
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  observations.persistedTabCheckbox = await backgroundChoice(false);
  await profilesChoice(false);
  await click("dock.actions.cancel");
  const beforeTab = await ctl("state");
  const tabEffects = await shellEffects();
  await click(actions + "run");
  await eventually(async () => {
    const state = await ctl("state");
    return state.focused.id !== manager;
  }, "separate command terminal");
  await ctl('expect "PC_SMOKE_OK"');
  await ctl('expect "PC_TAB_STDERR"');
  await ctl('expect "[Project Commands] Exit status: 0"');
  await ctl('expect "Press Enter to finish."');
  const terminalState = await ctl("state");
  assert.equal(terminalState.tabs.length, beforeTab.tabs.length + 1);
  assert.equal(terminalState.tabs.at(-1).panes, 1);
  assert.equal(terminalState.focused.exited, null, "completed command output must remain until acknowledged");
  assert.equal(terminalState.file_blocks.length, beforeTab.file_blocks.length, "tab execution must open a terminal, not a file");
  assert.equal(await readFile(outputFile, "utf8"), value + "\n");
  assert.equal(await readFile(profileOutputFile, "utf8"), `\n${commandCwd}\n`);
  assert.equal(await readFile(join(project, "build space/fish-native.txt"), "utf8"), "FISH_NATIVE\n");
  observations.tabExecution = { state: terminalState, shell: "fish", profiles: false,
    output: await readFile(outputFile, "utf8"), profileOutput: await readFile(profileOutputFile, "utf8"),
    shellEffects: await assertShellUntouched(tabEffects, "terminal execution") };
  observations.terminalScreenshot = await shot("retained-command-terminal");
  await ctl("key Enter");
  await eventually(async () => (await ctl("state")).tabs.length === beforeTab.tabs.length, "acknowledged successful terminal closes");

  await ctl("tab 2");
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  await backgroundChoice(false);
  await profilesChoice(false);
  await click(backgroundId);
  await ctl('plugins expect "Run in background — On"');
  await backgroundChoice(true);
  await fill("main.page.form.run.input", fishScript);
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  document = await saved();
  assert.equal(document.commands[0].execution, "background");
  assert.equal(document.commands[0].shell, "fish");
  assert.equal(document.commands[0].profiles, false);
  await click(actions + "edit");
  await ctl('plugins expect "Edit command"');
  observations.persistedBackgroundCheckbox = await backgroundChoice(true);
  await click("dock.actions.cancel");
  await writeFile(outputFile, "stale output\n");
  const switchedBackground = await backgroundSuccess(() => click(actions + "run"), outputFile, value + "\n", "編集済みビルド 🚀");
  assert.equal(await readFile(profileOutputFile, "utf8"), `\n${commandCwd}\n`);
  assert.equal(await readFile(join(project, "build space/fish-native.txt"), "utf8"), "FISH_NATIVE\n");
  observations.switchedBackground = { ...switchedBackground, shell: "fish", profiles: false,
    profileOutput: await readFile(profileOutputFile, "utf8") };

  // Only the original interactive shell changes projects; execution terminals have exited.
  await ctl("tab 1");
  assert.equal((await ctl("state")).focused.id, originalShell);
  await ctl(`run ${JSON.stringify("cd '" + otherProject.replaceAll("'", "'\\''") + "'")}`);
  await ctl("ready");
  await eventually(async () => (await readFile(historyFile, "utf8")).includes(otherProject), "other-project shell history");
  observations.paletteOtherProject = await openPalette([
    "Project Commands: Open manager", "Project Commands: Other project build", "Project Commands: Other project only",
  ]);
  observations.paletteOtherScreenshot = await shot("palette-other-project");
  await ctl("key Escape");
  await openPalette(["Project Commands: Other project build"], "Other project build");
  observations.paletteExecution = await backgroundSuccess(() => ctl("key Enter"),
    join(otherProject, "second-result.txt"), "SECOND_PROJECT\n", "Other project build");
  assert.equal((await ctl("state")).focused.id, originalShell);
  assert.equal(await readFile(outputFile, "utf8"), value + "\n");
  observations.paletteOutputScreenshot = await shot("palette-background-success");

  await ctl("tab 1");
  assert.equal((await ctl("state")).focused.id, originalShell);
  await ctl(`run ${JSON.stringify("cd '" + emptyProject.replaceAll("'", "'\\''") + "'")}`);
  await ctl("ready");
  observations.paletteEmptyProject = await openPalette(["Project Commands: Open manager"]);
  await ctl("key Escape");
  await ctl("tab 2");
  assert.equal((await ctl("state")).focused.id, manager);
  observations.paletteReturned = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  await ctl("key Escape");

  // Manual definition removal followed by Reload must retire its palette row.
  const extra = { id: "temporary-command", name: "Temporary command", profiles: false, run: "printf 'temporary\\n'" };
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

  // Reopen from the original project's real shell, which last visited the empty project.
  await ctl("tab 1");
  assert.equal((await ctl("state")).focused.id, originalShell);
  await ctl(`run ${JSON.stringify("cd '" + project.replaceAll("'", "'\\''") + "'")}`);
  await ctl("ready");
  await ctl("plugins run plugin.project-commands.open");
  await eventually(async () => (await ctl("state")).focused.id !== originalShell, "deletion manager opens");
  await commandRow("smoke-build", true);
  const deletionManagerState = await ctl("state");
  const deletionManager = deletionManagerState.focused.id;
  const deletionManagerTab = deletionManagerState.tabs.findIndex((tab: TabState) => tab.active) + 1;
  assert(deletionManagerTab > 1);
  observations.deleteInitialUndo = await undoChoice(0);
  const originalCommand = (await saved()).commands.find((item: { id: string }) => item.id === "smoke-build");
  assert(originalCommand);
  const createUndoFixture = async (id: string, name: string) => {
    await click("main.page.toolbar.new");
    await ctl('plugins expect "New command"');
    await fill("main.page.form.id.input", id);
    await fill("main.page.form.name.input", name);
    await fill("main.page.form.run.input", "printf 'undo fixture\\n'");
    await click("dock.actions.save");
    await ctl('plugins expect "Command saved."');
    await commandRow(id, true);
    const command = (await saved()).commands.find((item: { id: string }) => item.id === id);
    assert(command);
    return command;
  };
  const survivor = await createUndoFixture("undo-survivor", "Undo survivor");
  const secondDeleted = await createUndoFixture("undo-second", "Undo second");
  const deletionOrder = (await saved()).commands.map((item: { id: string }) => item.id);
  observations.deleteFixtures = { survivor, secondDeleted, order: deletionOrder };

  observations.deleteOriginal = await deleteCommand(originalCommand, 1);
  observations.paletteDeleted = await openPalette([
    "Project Commands: Open manager", "Project Commands: Undo survivor", "Project Commands: Undo second",
  ]);
  observations.deletePaletteScreenshot = await shot("delete-command-palette");
  await ctl("key Escape");
  observations.deleteScreenshot = await shot("delete-command-list");

  // Text undo in a form must not consume the pending command deletion.
  await click("main.page.commands.undo-survivor.actions.edit");
  await ctl('plugins expect "Edit command"');
  await focusField("main.page.form.name.input");
  await ctl("key Meta+ArrowRight");
  await ctl("type X");
  await ctl("key Meta+z");
  await eventually(async () => (await ctl(`tree ${selector("main.page.form.name.input")}`)).nodes[0]?.text === survivor.name,
    "form text undo while deletion undo is pending");
  observations.deletePendingFormUndo = await ctl(`tree ${selector("main.page.form.name.input")}`);
  observations.deleteFormUndoScreenshot = await shot("delete-pending-form-undo");
  await fill("main.page.form.name.input", "Undo survivor edited");
  await fill("main.page.form.run.input", "printf 'unrelated edit stays\\n'");
  await click("dock.actions.save");
  await ctl('plugins expect "Command saved."');
  await click("main.page.commands.undo-survivor.actions.toggle");
  await eventually(async () => (await saved()).commands.find((item: { id: string }) => item.id === survivor.id)?.enabled === false,
    "unrelated toggle while deletion undo is pending");
  await undoChoice(1);
  const survivorEdited = (await saved()).commands.find((item: { id: string }) => item.id === survivor.id);
  assert.equal(survivorEdited.name, "Undo survivor edited");
  assert.equal(survivorEdited.run, "printf 'unrelated edit stays\\n'");
  assert.equal(survivorEdited.enabled, false);
  observations.undoOriginal = await restoreCommand(originalCommand, 0);
  document = await saved();
  assert.deepEqual(document.commands.find((item: { id: string }) => item.id === survivor.id), survivorEdited,
    "Undo must preserve another command's save and toggle");
  assert.deepEqual(document.commands.map((item: { id: string }) => item.id), deletionOrder);
  observations.undoPreservedEdits = survivorEdited;
  observations.paletteUndoRestored = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀", "Project Commands: Undo second",
  ]);
  observations.undoPaletteScreenshot = await shot("undo-command-palette");
  await ctl("key Escape");
  observations.undoScreenshot = await shot("undo-command-list");

  observations.deleteLifoFirst = await deleteCommand(originalCommand, 1);
  observations.deleteLifoSecond = await deleteCommand(secondDeleted, 2);
  observations.paletteDeletedLifo = await openPalette(["Project Commands: Open manager"]);
  await ctl("key Escape");
  observations.deleteLifoScreenshot = await shot("delete-two-commands");
  observations.undoLifoFirst = await restoreCommand(secondDeleted, 1);
  await commandRow(originalCommand.id, false);
  assert.equal((await saved()).commands.some((item: { id: string }) => item.id === originalCommand.id), false,
    "first Undo must restore only the most recently deleted command");
  observations.paletteUndoLifoFirst = await openPalette(["Project Commands: Open manager", "Project Commands: Undo second"]);
  await ctl("key Escape");
  observations.undoListKeyboard = await restoreCommand(originalCommand, 0, true);
  document = await saved();
  assert.deepEqual(document.commands.map((item: { id: string }) => item.id), deletionOrder);
  assert.deepEqual(document.commands.find((item: { id: string }) => item.id === survivor.id), survivorEdited);
  observations.paletteUndoKeyboard = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀", "Project Commands: Undo second",
  ]);
  await ctl("key Escape");
  observations.undoKeyboardScreenshot = await shot("undo-list-keyboard");

  // A stale Undo must not overwrite a hand edit; Reload permits retrying the same entry.
  observations.deleteBeforeStaleUndo = await deleteCommand(secondDeleted, 1);
  const externalDocument = await saved();
  const externallyEdited = { ...survivorEdited, name: "Undo survivor externally edited", run: "printf 'external edit stays\\n'" };
  externalDocument.commands = externalDocument.commands.map((item: { id: string }) => item.id === survivor.id ? externallyEdited : item);
  const externalBytes = stringify(externalDocument);
  await writeFile(configFile, externalBytes);
  await click(undoId);
  await ctl('plugins expect "Configuration changed on disk. Reload before saving; no changes were written."');
  assert.equal(await readFile(configFile, "utf8"), externalBytes, "stale Undo must preserve disk bytes");
  await commandRow(secondDeleted.id, false);
  observations.undoStale = { undo: await undoChoice(1), document: await saved(), bytesUnchanged: true,
    error: await ctl(`tree ${selector("main.page.error")}`) };
  observations.undoStaleScreenshot = await shot("undo-stale-revision");
  await click("main.page.toolbar.reload");
  await ctl('plugins expect "Undo survivor externally edited"');
  await undoChoice(1);
  observations.undoStaleRetry = await restoreCommand(secondDeleted, 0);
  assert.deepEqual((await saved()).commands.find((item: { id: string }) => item.id === survivor.id), externallyEdited,
    "retried Undo must preserve the external edit");
  observations.paletteUndoStaleRetry = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀", "Project Commands: Undo second",
  ]);
  await ctl("key Escape");
  observations.undoStaleRetryScreenshot = await shot("undo-stale-retry");

  // A duplicate ID refuses restore without losing the pending entry.
  observations.deleteBeforeDuplicateUndo = await deleteCommand(secondDeleted, 1);
  const duplicateDocument = await saved();
  const conflict = { ...secondDeleted, name: "Conflicting deleted ID", run: "printf 'conflicting command\\n'" };
  duplicateDocument.commands.push(conflict);
  const duplicateBytes = stringify(duplicateDocument);
  await writeFile(configFile, duplicateBytes);
  await click("main.page.toolbar.reload");
  await ctl('plugins expect "Conflicting deleted ID"');
  await undoChoice(1);
  await click(undoId);
  await ctl(`plugins expect ${JSON.stringify("Duplicate command id: " + secondDeleted.id)}`);
  assert.equal(await readFile(configFile, "utf8"), duplicateBytes, "duplicate-ID Undo must preserve disk bytes");
  assert.deepEqual((await saved()).commands.find((item: { id: string }) => item.id === secondDeleted.id), conflict);
  observations.undoDuplicate = { undo: await undoChoice(1), document: await saved(), bytesUnchanged: true,
    error: await ctl(`tree ${selector("main.page.error")}`) };
  observations.undoDuplicateScreenshot = await shot("undo-duplicate-id");
  const conflictRemoved = await saved();
  conflictRemoved.commands = conflictRemoved.commands.filter((item: { id: string }) => item.id !== secondDeleted.id);
  await writeFile(configFile, stringify(conflictRemoved));
  await click("main.page.toolbar.reload");
  await commandRow(secondDeleted.id, false);
  await undoChoice(1);
  observations.undoDuplicateRetry = await restoreCommand(secondDeleted, 0);
  assert.deepEqual((await saved()).commands.find((item: { id: string }) => item.id === survivor.id), externallyEdited);
  observations.paletteUndoDuplicateRetry = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀", "Project Commands: Undo second",
  ]);
  await ctl("key Escape");

  // Switching tabs keeps history; actually closing the manager discards it.
  observations.deleteBeforeCloseFirst = await deleteCommand(secondDeleted, 1);
  observations.deleteBeforeCloseSecond = await deleteCommand(externallyEdited, 2);
  const beforeManagerClose = await readFile(configFile, "utf8");
  observations.paletteDeleteBeforeClose = await openPalette([
    "Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀",
  ]);
  await ctl("key Escape");
  await ctl("tab 1");
  assert.equal((await ctl("state")).focused.id, originalShell);
  await ctl(`tab ${deletionManagerTab}`);
  assert.equal((await ctl("state")).focused.id, deletionManager);
  observations.undoAfterTabSwitch = await undoChoice(2);
  assert.equal(await readFile(configFile, "utf8"), beforeManagerClose);
  observations.deleteBeforeCloseScreenshot = await shot("delete-before-manager-close");
  const beforeCloseState = await ctl("state");
  await ctl("tab close");
  await eventually(async () => {
    const state: LayoutState = await ctl("state");
    return state.tabs.length === beforeCloseState.tabs.length - 1 && !state.panes.some(pane => pane.id === deletionManager);
  }, "native manager tab closes");
  assert.equal(await readFile(configFile, "utf8"), beforeManagerClose, "closing the manager must not roll back deletions");
  await ctl("tab 1");
  assert.equal((await ctl("state")).focused.id, originalShell);
  await ctl("plugins run plugin.project-commands.open");
  await eventually(async () => (await ctl("state")).focused.id !== originalShell, "manager reopens for the original project");
  await commandRow(originalCommand.id, true);
  const reopenedManager = (await ctl("state")).focused.id;
  assert.notEqual(reopenedManager, deletionManager);
  const reopenedUndo = await undoChoice(0);
  await commandRow(secondDeleted.id, false);
  await commandRow(survivor.id, false);
  assert.equal(await readFile(configFile, "utf8"), beforeManagerClose, "reopening must retain the deleted YAML");
  document = await saved();
  assert.deepEqual(document.commands, [originalCommand]);
  observations.deleteManagerReopened = { closed: deletionManager, reopened: reopenedManager, undo: reopenedUndo,
    document, bytesUnchanged: true };
  observations.deleteReopenedScreenshot = await shot("delete-manager-reopened");
  observations.paletteDeleteReopened = await openPalette(["Project Commands: Open manager", "Project Commands: 編集済みビルド 🚀"]);
  observations.deleteReopenedPaletteScreenshot = await shot("delete-manager-reopened-palette");
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
  const files = ["plugin.toml", "window.luau", "host.luau", "lib/bridge.luau", "lib/editor.luau", "helper.ts", "helper.test.ts", "style.css", "bun.lock", "README.md", "scripts/smoke.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async path => [path,
    createHash("sha256").update(await readFile(join(plugin, path))).digest("hex")])));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ sourceHashes, observations, commands }, null, 2));
  console.log(JSON.stringify({ passed: observations.passed, evidence: join(root, "evidence.json"), observations }, null, 2));
}
