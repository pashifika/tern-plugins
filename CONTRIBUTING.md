# Contributing

Use a topic branch for each change and state its intended PR base before editing.
Keep plugin behavior, user documentation and verification evidence together.
Use Conventional Commits and preserve unrelated work. Public documentation is
written in English.

## Repository layout

| Path | Purpose |
|---|---|
| `project-commands/` | Project Commands plugin and its Bun helper |
| `examples/tern-sdk/` | Ignored, independent checkout of the upstream SDK |
| `AGENTS.md` | Short repository-wide instructions for coding agents |

Plugins have their own manifests and dependencies. This repository is not a Bun
workspace; run package commands from the plugin directory or use `--cwd`.

## SDK reference

The official source is [stencil-hq/tern-sdk](https://github.com/stencil-hq/tern-sdk).
For Luau plugins, start with `plugins/examples/` and `plugins/tern.d.luau` in that
checkout. The language SDKs elsewhere in the checkout target programs that draw
Tern's native UI; they are not dependencies of this plugin.

Before using an existing checkout, run these inspections from this repository's
root:

```bash
git -C examples/tern-sdk remote -v
git -C examples/tern-sdk status --short --branch
git -C examples/tern-sdk branch -vv
```

Refresh it only when all of the following hold:

1. The remote identifies `stencil-hq/tern-sdk`.
2. The working tree has no tracked or untracked changes.
3. A local branch is checked out and tracks the expected upstream branch.

Then update from that configured upstream and record the revision:

```bash
git -C examples/tern-sdk pull --ff-only
git -C examples/tern-sdk log -1 --format='%H %s'
```

Stop if the update is not a fast-forward. Do not stash someone else's edits,
reset the checkout, change its remote or force-push to make it current.
The checkout is optional and ignored; never add it as a gitlink or vendor its
files into this repository.

If the reference checkout is absent, create it from the repository root:

```bash
git clone https://github.com/stencil-hq/tern-sdk.git examples/tern-sdk
```

Upstream may describe a newer Tern than the one installed locally. Check the
runtime before adopting an API:

```bash
tern --version
tern plugin types project-commands
tern help dev
```

`tern plugin types project-commands` writes the installed API declarations to the
ignored `project-commands/tern.d.luau`. Record the SDK commit and Tern version used
for an API change; a successful upstream pull alone does not prove runtime
compatibility.

## Project Commands

### Setup and checks

Requires Bun 1.3.14+. Execution tests also need bash, zsh and fish on `PATH`.
The native smoke requires desktop Tern 0.9.2 or newer on macOS and an available
desktop session.

Run from this repository's root:

```bash
bun install --cwd project-commands --frozen-lockfile
bun run --cwd project-commands test
bun run --cwd project-commands smoke
```

The test command covers configuration boundaries, concurrent edits, shell
startup, literal environment values, execution output and deletion recovery.
The smoke opens an owned Tern window, drives the real form and Cmd+K, and checks
background execution, failure logs, shell options and the manager's Undo lifetime.
It saves screenshots and a control transcript, then closes its own processes.

The smoke prints the path to `evidence.json`. Keep the observed values and source
fingerprints with the verification record in `project-commands/verification.json`.
Do not rewrite an old fingerprint to make old results look current. For a
documentation-only change, record the new documentation checks separately.
Review all retained evidence before committing: local paths and logs can expose
private information.

### Native isolation

Use disposable projects and verify `tern plugin dir` before linking a test plugin.
Do not install into, reload or close the user's normal Tern session to obtain a
passing smoke result.

The smoke scopes both the GUI and daemon, and uses a temporary spawn hook to set
the actual terminal's `HOME`, history path and fish configuration directories.
Setting only the GUI's `HOME` is insufficient. Do not override `ZDOTDIR` in that
spawn hook: doing so bypasses Tern's shell integration and breaks cwd updates.

For native control scripts, `tree` truncates node text at 200 characters. Use
`plugins expect` for a complete input value and compare saved YAML exactly.
Use screenshots to check the visible surface. File-tab contents can be inspected
through the direct local `cx.session:read` tool without requesting a model turn.

### Implementation map

| File | Responsibility |
|---|---|
| `plugin.toml` | Plugin identity and entry points |
| `window.luau` | Project-scoped palette actions, execution routing and completion UI |
| `host.luau` | Manager state, form controls and direct command-tab startup |
| `lib/editor.luau`, `style.css` | Native editing behavior and presentation |
| `lib/bridge.luau` | Asynchronous calls to the Bun helper |
| `helper.ts` | YAML validation/storage, shell execution and deletion receipts |
| `helper.test.ts` | Deterministic filesystem and real-shell regressions |
| `scripts/smoke.ts` | Isolated native desktop acceptance checks |

Preserve these boundaries when changing the implementation:

- Configuration writes use a revision check, a temporary sibling file and rename.
  A short-lived lock serializes plugin writers, not unrelated external editors.
- Delete returns the removed YAML node and its index. Undo inserts that node into
  the current document; it must not replace the whole document with an old copy.
- Deletion history belongs to one manager's live state. Persist only the project
  root when Tern saves the block; do not serialize the Undo stack.
- Terminal launches replace only the plugin's launch marker. Never type a command
  into an existing shell or agent pane.
- Configuration calls have a 15-second deadline. Build execution does not.

### Before opening a PR

1. Run checks covering the changed behavior. Native UI changes need the desktop
   smoke in addition to unit tests.
2. Update the [user guide](project-commands/README.md) or
   [configuration guide](project-commands/docs/configuration.md) when behavior changes.
3. Record exact commands, observed results and the source revision or fingerprints.
4. State what was not checked. A local macOS run does not prove Linux support,
   OS-level IME input or a real Rust/npm project build.
5. Inspect the diff for unrelated changes, credentials and private execution data.
   Do not commit generated `tern.d.luau`, `node_modules` or the SDK checkout.
