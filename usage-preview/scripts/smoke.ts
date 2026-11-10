import type { Subprocess } from "bun";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tern = Bun.which("tern");
const bun = Bun.which("bun");
assert(tern && bun, "Install desktop Tern and Bun before running this smoke.");
const plugin = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "tern-usage-preview-"));
const project = join(root, "project");
const config = join(root, "config");
const home = join(root, "home");
const socket = join(root, "daemon.sock");
for (const dir of ["project", "config/plugins", "home", "shell-env", "logs", "xdg-config", "xdg-data"]) {
  await mkdir(join(root, dir), { recursive: true });
}
const env = {
  PATH: process.env.PATH, HOME: home, ZDOTDIR: home,
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: socket,
  XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
  STENCIL_LOG_DIR: join(root, "logs"), STENCIL_LOG: "warn",
};
await writeFile(join(config, "settings.json"), JSON.stringify({ plugins: true, theme: "Light", shell: "/bin/zsh" }));
await writeFile(join(root, "shell-env/plugin.toml"), 'schema = 1\nid = "test-shell-env"\nname = "Isolated shell environment"\nversion = "0.0.0"\nhost = "host.luau"\n');
await writeFile(join(root, "shell-env/host.luau"), `tern.on("spawn", function(spec)
  spec.env.HOME = ${JSON.stringify(home)}
  spec.env.HISTFILE = ${JSON.stringify(join(home, ".zsh_history"))}
  spec.env.XDG_CONFIG_HOME = ${JSON.stringify(env.XDG_CONFIG_HOME)}
  spec.env.XDG_DATA_HOME = ${JSON.stringify(env.XDG_DATA_HOME)}
  return spec
end)
`);

// Native TSP fixture based on OMP 18.18.6's composer and usage renderer.
// Unstyled quota labels become text nodes; styled runs become span elements.
const quota = [
  { t: "Plus", s: "accent" }, { t: " · ", s: "dim" },
  { t: "5h " }, { t: "12%", s: "muted" }, { t: " (1h 30m)", s: "muted" },
  { t: " · ", s: "dim" }, { t: "7d " }, { t: "23%", s: "muted" }, { t: " (4d 2h)", s: "muted" },
];
const credits = { t: "✦ 2 exp 20d 19h", s: "success" };
const node = (id: string, k: string, p: object = {}, c: object[] = []) => ({ id, k, p, c });
const dock = node("dock", "col", {}, [node("composer", "col", { role: "omp.editor" }, [
  node("line", "row", { role: "omp.composer.line" }, [node("input", "editor", { text: "", placeholder: "Usage preview acceptance", cursor: 0 })]),
  node("bar", "row", { role: "omp.composer.bar", align: "center", gap: "sm" }, [
    node("model", "text", { role: "omp.composer.model", text: "no-model" }),
    node("extras", "status", { role: "omp.composer.extras", grow: 1, transparent: true }, [
      node("extras/git", "seg", { role: "omp.composer.fact", icon: "branch", priority: 1004, spans: [
        { t: "feature/usage-hover-preview-with-long-branch-name", s: "warning" },
        { t: " *2", s: "warning" }, { t: " +1", s: "success" }, { t: " ?12", s: "muted" },
      ] }),
      node("extras/usage", "seg", { role: "omp.composer.fact", icon: "time", priority: 1005, spans: [] }),
    ]),
    node("send", "kbd", { role: "omp.composer.send", keys: ["enter"] }),
  ]),
])]);
const statePath = join(root, "usage.json");
await writeFile(statePath, JSON.stringify([...quota, { t: " · ", s: "dim" }, credits]));
await writeFile(join(root, "fixture.ts"), `import { watchFile } from "node:fs";
const dock = ${JSON.stringify(dock)};
const path = ${JSON.stringify(statePath)};
let seq = 0;
const send = (verb, body) => process.stdout.write("\\x1b_tsp;" + verb + ";" + JSON.stringify(body) + "\\x1b\\\\");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", data => { if (data.includes(3)) process.exit(0); });
send("o", { id: "usage-fixture", mode: "inline", role: "omp.session", title: "Usage preview acceptance", listen: false });
async function render() {
  const spans = await Bun.file(path).json();
  dock.c[0].c[1].c[1].c[1].p.spans = spans;
  send("f", { sf: "usage-fixture", s: ++seq, ops: seq === 1
    ? [["add", "dock", "usage-fixture", null, dock]]
    : [["set", "extras/usage", { spans }]] });
}
await render();
watchFile(path, { interval: 100 }, render);
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
async function run(args: string[]) {
  const child = Bun.spawn([tern!, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
async function ctl(command: string) {
  const result = JSON.parse(await run(["ctl", "--control", port, command]));
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
type Rect = [number, number, number, number];
type Element = { text?: string; rect: Rect };
const tree = async (selector: string): Promise<Element[]> => (await ctl("tree " + selector)).nodes;
const usage = ".tn-pane.on .sf-dock[data-surface='omp.session'] .sf-seg[data-id$='/usage']";
const spans = usage + " .sf-seg-t > span";
const geometry = async () => Promise.all([usage, ".sf-seg[data-id$='/git'] .sf-seg-t > span", "[data-role='omp.composer.model']", "[data-role='omp.composer.send']"].map(async selector => (await tree(selector)).map(node => node.rect)));
async function check(name: string, values: object[], text: string) {
  await writeFile(statePath, JSON.stringify(values));
  await ctl("move 20 200");
  await Bun.sleep(1200);
  await ctl("wait 100");
  const before = await tree(spans);
  assert(!before.some(node => node.text?.startsWith("✦")), "Credits stay hidden before hover");
  const boxes = await geometry();
  assert.equal(boxes[0].length, 1);
  const target = boxes[0][0];
  const normal = await ctl("shot " + name + "-normal");
  await ctl("hover " + JSON.stringify(usage));
  const after = await tree(spans);
  const popup = after.find(node => node.text === text);
  assert(popup, "Credit popup opens");
  assert.deepEqual(after.filter(node => !node.text?.startsWith("✦")), before, "Quota geometry stays fixed");
  assert.deepEqual(await geometry(), boxes, "Hover does not move status controls");
  assert(Math.abs(popup.rect[0] + popup.rect[2] - target[0] - target[2]) < 1, "Popup right edge must align with usage, not the Git segment or extras strip");
  assert(Math.abs(popup.rect[1] + popup.rect[3] + 6 - target[1]) < 1, "Popup must sit 6px above usage");
  assert(popup.rect[0] >= 0 && popup.rect[2] >= 100, "Credit-only preview stays readable and inside the window");
  const hover = await ctl("shot " + name + "-hover");
  await ctl("move 20 200");
  assert.deepEqual(await tree(spans), before, "Preview closes on leave");
  observations[name] = { target, popup: popup.rect, normal, hover };
}
let daemon: Subprocess | undefined;
let window: Subprocess | undefined;
let passed = false;
try {
  observations.tern = (await run(["--version"])).trim();
  observations.bun = Bun.version;
  const target = JSON.parse(await run(["plugin", "dir", "--json"]));
  assert.equal(target.dir, join(config, "plugins"));
  observations.pluginTarget = target.dir;
  daemon = Bun.spawn([tern, "daemon", "--socket", socket], { cwd: project, env, stdout: Bun.file(join(root, "daemon.stdout")), stderr: Bun.file(join(root, "daemon.stderr")) });
  await eventually(() => stat(socket).then(() => true, () => false), "owned daemon");
  for (const source of [plugin, resolve(plugin, "../branch-preview"), join(root, "shell-env")]) await run(["plugin", "link", source, "--json"]);
  window = Bun.spawn([tern, "--control", port, project], { cwd: project, env, stdout: Bun.file(join(root, "window.stdout")), stderr: Bun.file(join(root, "window.stderr")) });
  await eventually(async () => { try { await ctl("state"); return true; } catch { return false; } }, "owned window");
  await eventually(async () => (await ctl("state")).account.phase !== "reading", "initial account read");
  await ctl("account signed-in PluginSmoke");
  await ctl("window-focus on");
  await ctl("ready");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await ctl("run " + JSON.stringify(quote(bun) + " " + quote(join(root, "fixture.ts"))));
  await eventually(async () => (await tree(usage)).length === 1, "native usage fixture");
  for (const theme of ["Light", "Dark"]) {
    await ctl(`carly lua cx.settings:set("theme","${theme}")`);
    await ctl("carly close");
    await eventually(async () => (await tree(".toast")).length === 0, "transient notices dismissed");
    for (const width of [1280, 640]) {
      await ctl(`resize ${width} 800`);
      await check(`${theme.toLowerCase()}-${width}`, [...quota, { t: " · ", s: "dim" }, credits], credits.t);
    }
  }
  await ctl("resize 1280 800");
  await check("credits-only", [credits], credits.t);
  const warning = { t: "✦ 2 (1 usable) ▲ 1 exp 3h", s: "warning" };
  await check("credit-only-warning", [warning], warning.t);
  passed = true;
} finally {
  if (window) { try { await ctl("key Ctrl+c"); await ctl("quit"); } catch {} window.kill(); await window.exited; }
  if (daemon) { daemon.kill(); await daemon.exited; }
  const sourceHashes = Object.fromEntries(await Promise.all(["plugin.toml", "window.luau", "style.css", "scripts/smoke.ts"].map(async file => [file, createHash("sha256").update(await readFile(join(plugin, file))).digest("hex")])));
  const evidence = join(root, "evidence.json");
  await writeFile(evidence, JSON.stringify({ passed, observations, sourceHashes, commands }, null, 2) + "\n");
  console.log(JSON.stringify({ passed, evidence }));
}
