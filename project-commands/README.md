# Tern Project Commands

A Tern Luau plugin for project-local build commands. A native manager lists commands, edits multiline scripts and environment variables, toggles On/Off, and runs commands in a new terminal tab without writing into an existing agent pane.

## Install

Requires desktop Tern with the 0.9.2 plugin API and Bun 1.3.14+. Verified on macOS with Tern `0.9.2 (23735aa)`. Windows, remote hosts, web and iOS are not supported. Linux has not been verified.

From this directory:

```sh
bun install --frozen-lockfile
tern plugin dir
tern plugin link "$PWD"
```

`plugin link` registers this directory in the Tern installation printed by `plugin dir` and reloads its plugins. Keep this directory and its `node_modules` in place. No build step is needed. This checkout has **not** been registered in the normal user installation by the implementation smoke.

In a local project pane, press **Cmd+K** and choose **Project Commands: Open manager**.

- **New command / Edit** opens the dedicated form: ID, name, relative working directory, shell, multiline script, environment key/value rows and enabled state.
- **Save** writes the project YAML. **Cancel** leaves it unchanged.
- **Turn Off / Turn On** persists the enabled state. Off commands remain visible in the manager but cannot be run and are excluded from Cmd+K. Turning Off does not interrupt an already running command.
- **Run** opens a new shell tab, waits for its prompt, then submits only the helper invocation to that new pane. Logs and the exit status remain after completion. Ctrl-C uses ordinary terminal interruption.
- **Reload** reads external YAML edits while in the list view. No command runs automatically when a project or manager opens.

**Cmd+K** also lists enabled commands as **Project Commands: &lt;name&gt;** for the focused local pane's project. Search by name and press Enter to run directly in a new terminal tab. Projects may reuse command IDs without sharing definitions.

Palette registrations refresh on pane focus/cwd changes, successful manager loads/saves/toggles, and plugin reloads. After an external YAML edit, use **Reload** in the manager or switch panes. Tern snapshots the list when opening the palette: close and reopen it if configuration loading finishes while it is open. A stale action is checked against the current project and enabled state before launching.

The new terminal must support Tern's shell integration and report its prompt. After 10 seconds without a prompt, no command is sent and an error is shown.

Bun lookup: `TERN_PROJECT_COMMANDS_BUN`, then `$HOME/.bun/bin/bun`, `/opt/homebrew/bin/bun`, then `bun` on the Tern process's PATH. Set the override in the environment that starts Tern if Bun is installed elsewhere; both the window and daemon need it. Missing Bun or dependencies is an error, not an automatic installation.

Remove the registration with `tern plugin unlink project-commands`.

## Configuration

Definitions live in `<project>/.omp/tern-commands.yaml`. Search starts at the originating pane's cwd and walks upwards, stopping at the nearest configuration or Git root. Definitions are never merged. Without either, the originating cwd is used. A missing configuration is shown as an empty list and is created only on Save.

```yaml
version: 1
commands:
  - id: rust-release
    name: Rust release build
    enabled: true
    cwd: server
    shell: /bin/zsh
    env:
      RUSTFLAGS: "-C target-cpu=native"
    run: |
      cargo build --release --locked

  - id: web-build
    name: Web production build
    enabled: false
    cwd: web
    shell: /bin/zsh
    env:
      NODE_ENV: production
      NODE_OPTIONS: "--max-old-space-size=8192"
    run: |
      npm run build -- --mode production
```

IDs are unique lowercase letters/digits/hyphens, beginning with a letter. Name and script are required. Optional defaults: `enabled: true`, `cwd: .`, `env: {}`, and `/bin/zsh` on macOS (`/bin/sh` elsewhere). A missing version is accepted as version 1; writes include it.

The working directory must stay inside the project, including after symlink resolution. The shell must be an absolute executable path to a POSIX-compatible login shell, such as zsh or bash; fish/PowerShell are not script shells for this configuration. It runs with `-l -c`, not interactive initialization. The child inherits the new terminal's environment; configured variables and cwd are applied **after** shell login initialization. Environment values are literal strings, not templates: `"$HOME"` means the literal characters `$HOME`. Use shell expansion inside `run` when needed.

Commands have the user's ordinary filesystem and process permissions; they are **not sandboxed**. Only run definitions you trust. Variables are saved as plaintext: do not store secrets in this YAML; inherit them from the execution environment instead.

## Saving and errors

- YAML parsing uses the pinned `yaml` package. Existing comments on retained fields are preserved, but formatting can be normalized.
- Invalid YAML, unknown fields, duplicate IDs/keys, unsupported versions, aliases, non-string env values and files over 1 MiB are rejected. Configuration-file symlinks are rejected.
- Writes use a sibling temporary file and rename. A file revision guard refuses stale edits, and a short-lived `.lock` serializes plugin writers. This is not a transactional lock on unrelated external editors.
- On a save conflict, the draft remains in the form. Copy anything needed, Cancel, then Reload; the external file is not overwritten. Simultaneous plugin editors cannot both save against the same revision.
- A lock left after a crash is never removed automatically. Verify no save is running before manually removing the named `.lock`.
- Unsaved form drafts are intentionally not persisted across plugin reloads or Tern restarts.

## Verification

```sh
bun test
bun run smoke
```

`bun test` exercises storage, parsing boundaries, comments, conflicts, concurrent writers, root discovery, disabled execution, literal environment values, working directories and exit status.

`bun run smoke` opens a real macOS Tern window against an owned temporary HOME/config/daemon and projects. It checks the installation target before linking, uses Tern's official local account test scenario for that isolated window, operates the native form, verifies the resulting YAML and command output, captures screenshots and closes its owned processes. It also exercises Cmd+K visibility, rename/Off updates, switching between projects with shared command IDs, direct execution with Enter, empty projects, definition removal and plugin reload. It never links into the normal user's installation. Do not interact with the test window while it runs.

The script prints the path to `evidence.json`, containing observed values, the control-command transcript, screenshots and SHA-256 fingerprints of the source it exercised. Temporary evidence is retained for inspection. The accompanying `verification.json` records the latest successful run. No Rust/npm project build, OS-level IME composition, Linux run, or standalone Luau static analysis was performed; Unicode text entry and undo were exercised through Tern's native input controls.

## Files

- `window.luau`: project-scoped palette registration, local-host checks, execution routing and fresh terminal launch.
- `host.luau`, `lib/editor.luau`, `style.css`: native command list and editing form.
- `lib/bridge.luau`: asynchronous Bun RPC.
- `helper.ts`: YAML read/write and shell execution; scripts are never evaluated by the YAML parser.
