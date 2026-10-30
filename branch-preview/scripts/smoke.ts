import type { Subprocess } from "bun";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tern = Bun.which("tern");
const omp = Bun.which("omp");
assert(tern && omp, "Install desktop Tern and OMP before running this smoke.");
const plugin = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "tern-branch-preview-"));
const project = join(root, "project");
const config = join(root, "config");
const home = join(root, "home");
const socket = join(root, "daemon.sock");
for (const dir of ["project", "config/plugins", "home", "agent", "shell-env", "logs", "xdg-config", "xdg-data"]) {
  await mkdir(join(root, dir), { recursive: true });
}
const env: Record<string, string | undefined> = {
  PATH: process.env.PATH, HOME: home, ZDOTDIR: home,
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: socket,
  XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
  PI_CODING_AGENT_DIR: join(root, "agent"), STENCIL_LOG_DIR: join(root, "logs"), STENCIL_LOG: "warn",
};
await writeFile(join(config, "settings.json"), JSON.stringify({ plugins: true, theme: "Light", shell: "/bin/zsh" }));
// A credential-free, disposable OMP profile; no first-run wizard or model turn.
await writeFile(join(root, "agent/config.yml"), "setupVersion: 2\nsymbolPreset: nerd\ncomposer:\n  shape: band\n");
await writeFile(join(root, "shell-env/plugin.toml"), 'schema = 1\nid = "test-shell-env"\nname = "Isolated shell environment"\nversion = "0.0.0"\nhost = "host.luau"\nwindow = "window.luau"\n');
await writeFile(join(root, "shell-env/window.luau"), 'tern.css("boundary",tern.fs.read(tern.plugin.dir .. "/boundary.css"))\n');
await writeFile(join(root, "shell-env/boundary.css"), "");
await writeFile(join(root, "shell-env/host.luau"), `tern.on("spawn", function(spec)
  spec.env.HOME = ${JSON.stringify(home)}
  spec.env.HISTFILE = ${JSON.stringify(join(home, ".zsh_history"))}
  spec.env.XDG_CONFIG_HOME = ${JSON.stringify(env.XDG_CONFIG_HOME)}
  spec.env.XDG_DATA_HOME = ${JSON.stringify(env.XDG_DATA_HOME)}
  spec.env.PI_CODING_AGENT_DIR = ${JSON.stringify(env.PI_CODING_AGENT_DIR)}
  return spec
end)
`);
const server = createServer();
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = server.address();
assert(address && typeof address !== "string");
const port = String(address.port);
const closed = Promise.withResolvers<void>();
server.close(error => error ? closed.reject(error) : closed.resolve());
await closed.promise;
const commands: unknown[] = [];
const observations: Record<string, unknown> = {};
async function run(args: string[], binary = tern!) {
  const child = Bun.spawn([binary, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
async function ctl(command: string) {
  const result: unknown = JSON.parse(await run(["ctl", "--control", port, command]));
  assert(result !== null && typeof result === "object" && "ok" in result);
  commands.push({ command, result });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
const git = (args: string[]) => run(args, "git");
const branchSelector = ".sf-dock[data-surface='omp.session'] .sf-seg[data-id$='/git']";
const nameSelector = branchSelector + " .sf-seg-t > span:first-child";
const countsSelector = branchSelector + " .sf-seg-t > span:not(:first-child)";
async function tree(selector: string) {
  const reply = await ctl("tree " + selector);
  assert("nodes" in reply);
  const { nodes } = reply;
  assert(Array.isArray(nodes));
  return nodes.map((node: unknown) => {
    assert(node !== null && typeof node === "object" && "rect" in node);
    const text = "text" in node ? node.text : undefined;
    const { rect } = node;
    assert(text === undefined || typeof text === "string");
    assert(Array.isArray(rect) && rect.length === 4 && rect.every((n: unknown) => typeof n === "number"));
    // The four numeric coordinates were validated above.
    return { text, rect: rect as number[] };
  });
}
const geometry = async () => ({
  branch: await tree(branchSelector),
  model: await tree("[data-role='omp.composer.model']"),
  send: await tree("[data-role='omp.composer.send']"),
  counts: await tree(countsSelector),
});
async function checkPreview(name: string, branch: string) {
  await ctl("window-focus on");
  await eventually(async () => (await tree(".toast")).length === 0, "transient notices dismissed");
  await ctl("move 20 200");
  // Let one preview refresh and any fixture stylesheet reload settle before
  // recording geometry, rather than including those changes in the hover delta.
  await ctl("wait 600");
  const before = await geometry();
  assert.equal(before.branch.length, 1);
  assert.deepEqual(before.counts.map(node => node.text), ["*2", "+1", "?12"]);
  const label = (await tree(nameSelector))[0];
  assert.equal(label.text, branch);
  assert(label.rect[2] <= 141, "Only the branch label has a bounded width");
  const normal = await ctl("shot " + name + "-normal");
  await ctl("window-focus on");
  await ctl("hover " + JSON.stringify(branchSelector));
  assert.deepEqual(await geometry(), before, "Hover must not move the counts, model, send button, or branch hit target");
  assert.deepEqual((await tree(nameSelector))[0], label, "The original branch label must remain visible in its slot");
  // Tern's tree/layout APIs omit generated content. Inspect these native screenshots
  // for the full-name popup, its bounds, and exact-fit text without ellipsis.
  const expanded = await ctl("shot " + name + "-hover");
  await ctl("move 20 200");
  assert.deepEqual((await tree(nameSelector))[0], label);
  observations[name] = { counts: before.counts, normal, expanded, label };
}
let daemon: Subprocess | undefined;
let window: Subprocess | undefined;
let passed = false;
try {
  observations.tern = (await run(["--version"])).trim();
  observations.omp = (await run(["--version"], omp)).trim();
  observations.bun = Bun.version;
  const target: unknown = JSON.parse(await run(["plugin", "dir", "--json"]));
  assert(target !== null && typeof target === "object" && "dir" in target);
  assert.equal(target.dir, join(config, "plugins"));
  observations.pluginTarget = target.dir;
  const branch = "feature/branch-hover-preview-with-a-deliberately-long-name-for-native-composer";
  await git(["init", "--initial-branch", branch]);
  await writeFile(join(project, ".gitignore"), "target/\n");
  for (const file of ["staged.txt", "modified.txt", "deleted.txt"]) await writeFile(join(project, file), "baseline\n");
  await git(["add", ".gitignore", "staged.txt", "modified.txt", "deleted.txt"]);
  await git(["-c", "user.name=Plugin Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: establish disposable status fixture"]);
  await writeFile(join(project, "staged.txt"), "staged change\n");
  await git(["add", "staged.txt"]);
  await writeFile(join(project, "modified.txt"), "unstaged change\n");
  await unlink(join(project, "deleted.txt"));
  for (let i = 0; i < 12; i++) await writeFile(join(project, `untracked-${i}.txt`), "new\n");
  daemon = Bun.spawn([tern, "daemon", "--socket", socket], { cwd: project, env,
    stdout: Bun.file(join(root, "daemon.stdout")), stderr: Bun.file(join(root, "daemon.stderr")) });
  await eventually(() => stat(socket).then(() => true, () => false), "owned daemon");
  observations.registration = JSON.parse(await run(["plugin", "link", plugin, "--json"]));
  await run(["plugin", "link", join(root, "shell-env"), "--json"]);
  window = Bun.spawn([tern, "--control", port, project], { cwd: project, env,
    stdout: Bun.file(join(root, "window.stdout")), stderr: Bun.file(join(root, "window.stderr")) });
  await eventually(async () => { try { await ctl("state"); return true; } catch { return false; } }, "owned window");
  // Do not let the initial account read overwrite the developer sign-in fixture.
  await eventually(async () => {
    const state = await ctl("state");
    assert("gate" in state && state.gate !== null && typeof state.gate === "object" && "phase" in state.gate);
    return state.gate.phase !== "reading";
  }, "initial account read");
  // Developer fixture affects only this window; it does not authenticate a real account.
  await ctl("account signed-in PluginSmoke");
  await ctl("window-focus on");
  await ctl("ready");
  const quotedOmp = "'" + omp.replaceAll("'", "'\\''") + "'";
  await ctl("run " + JSON.stringify(quotedOmp + " --no-session --no-extensions --no-skills --no-rules --no-context-files --no-title --no-lsp --no-tools"));
  await eventually(async () => (await tree(nameSelector))[0]?.text === branch, "real OMP Git segment");
  await eventually(async () => (await tree(countsSelector)).length === 3, "real Git counts");
  const css = await ctl("css");
  assert("sheets" in css && Array.isArray(css.sheets));
  const sheets = css.sheets.filter((sheet: unknown) =>
    sheet !== null && typeof sheet === "object" && "name" in sheet &&
    typeof sheet.name === "string" && sheet.name.startsWith("plugin:local:branch-preview:"));
  observations.sheets = sheets;
  for (const theme of ["Light", "Dark"]) {
    await ctl(`carly lua cx.settings:set("theme","${theme}")`);
    await ctl("carly close");
    await eventually(async () => {
      const dump = await ctl("dump .sf-dock");
      assert("header" in dump && dump.header !== null && typeof dump.header === "object" && "theme" in dump.header);
      return dump.header.theme === theme.toLowerCase();
    }, "actual appearance");
    for (const width of [1280, 640]) {
      await ctl(`resize ${width} 800`);
      await ctl("wait 200");
      await checkPreview(`${theme.toLowerCase()}-${width}`, branch);
    }
  }
  for (const [name, branch] of [
    ["short-branch", "main"],
    ["exact-fit", "boundary-12345678901"],
    ["quoted-unicode", 'fix/"quoted"-日本語-1234567890'],
  ]) {
    await git(["branch", "-m", branch]);
    await ctl('type "x"');
    await ctl("key Backspace");
    await eventually(async () => (await tree(nameSelector))[0]?.text === branch, "live branch rename");
    if (name === "exact-fit") {
      const selector = ".sf-dock[data-surface='omp.session'] [data-role='omp.composer.extras'] .sf-seg[data-id$='/git']";
      await writeFile(join(root, "shell-env/boundary.css"), `${selector}{--branch-preview-width:1000px}`);
      await run(["plugin", "reload", "test-shell-env"]);
      await ctl("wait 200");
      const naturalWidth = (await tree(nameSelector))[0].rect[2];
      await writeFile(join(root, "shell-env/boundary.css"), `${selector}{--branch-preview-width:${naturalWidth}px}`);
      await run(["plugin", "reload", "test-shell-env"]);
      await checkPreview(name, branch);
      assert.equal((await tree(nameSelector))[0].rect[2], naturalWidth, "An exact-fit branch keeps its natural width");
      observations.exactFitWidth = naturalWidth;
      await writeFile(join(root, "shell-env/boundary.css"), "");
      await run(["plugin", "reload", "test-shell-env"]);
    } else {
      await checkPreview(name, branch);
    }
  }
  await ctl("hover " + JSON.stringify("[data-role='omp.composer.model']"));
  await eventually(async () => (await tree(".tooltip")).some(node => node.text?.includes("Switch model")), "unchanged native model tooltip");
  observations.modelTooltip = await tree(".tooltip");
  await ctl("click " + JSON.stringify(branchSelector));
  await eventually(async () => (await tree(".tv-cover")).some(node => node.text?.includes("15 changes")), "unchanged Git click action");
  observations.gitClick = await tree(".tv-cover");
  await ctl("key Escape");
  passed = true;
} finally {
  if (window) {
    try { await ctl("quit"); } catch { /* The owned window may already be closed. */ }
    window.kill();
    await window.exited;
  }
  if (daemon) { daemon.kill(); await daemon.exited; }
  const files = ["plugin.toml", "window.luau", "style.css", "scripts/smoke.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash("sha256").update(await readFile(join(plugin, file))).digest("hex")])));
  const evidence = join(root, "evidence.json");
  await writeFile(evidence, JSON.stringify({ passed, observations, sourceHashes, commands }, null, 2) + "\n");
  console.log(JSON.stringify({ passed, evidence }));
}
