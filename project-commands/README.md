# Tern Project Commands

A Tern Luau plugin for project-local build commands. A native manager edits multiline scripts and environment variables, toggles On/Off, and runs commands in the background or in a dedicated terminal tab without writing into an existing shell or agent pane.

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

- **New command / Edit** opens the dedicated form: ID, name, relative working directory, shell, **Load shell profiles**, multiline script, environment key/value rows, enabled state and **Run in background**.
- **Save** writes the project YAML. **Cancel** leaves it unchanged.
- **Turn Off / Turn On** persists the enabled state. Off commands remain visible in the manager but cannot be run and are excluded from Cmd+K. Turning Off does not interrupt an already running command.
- **Delete** immediately removes a command from the YAML, manager and Cmd+K. It does not stop an already running command.
- **Undo delete (N)** restores the most recently deleted command; repeat to undo earlier deletions. **Cmd/Ctrl+Z** does the same in the list view. In a form, that shortcut still undoes text edits. Deletion history belongs to this manager and lasts until it closes; switching tabs or reloading the same project's YAML keeps it. Closing/reopening the manager, changing its resolved project, reloading the plugin or restarting Tern discards it. There is no persistent trash or Redo.
- **Run** uses the command's execution mode. Background is the default; uncheck **Run in background** to use a terminal tab. Tern 0.9.2 has no plugin-defined Preferences settings schema, so this option is per command, not a separate global settings screen.
- **Load shell profiles** defaults to On. Turn it Off to skip user startup files for that command. This is independent of background/tab mode.
- **Reload** reads external YAML edits while in the list view. No command runs automatically when a project or manager opens.

**Cmd+K** also lists enabled commands as **Project Commands: &lt;name&gt;** for the focused local pane's project. Search by name and press Enter to run using that command's saved mode. Projects may reuse command IDs without sharing definitions.

Palette registrations refresh on pane focus/cwd changes, successful manager loads/saves/toggles/deletes/restores, and plugin reloads. After an external YAML edit, use **Reload** in the manager or switch panes. Tern snapshots the list when opening the palette: close and reopen it if configuration loading finishes while it is open. A stale action is checked against the current project and enabled state before launching.

Bun lookup: `TERN_PROJECT_COMMANDS_BUN`, then `$HOME/.bun/bin/bun`, `/opt/homebrew/bin/bun`, then `bun` on the Tern process's PATH. Set the override in the environment that starts Tern if Bun is installed elsewhere; both the window and daemon need it. Missing Bun or dependencies is an error, not an automatic installation.

Remove the registration with `tern plugin unlink project-commands`.

## Execution

- **Background:** no new tab or focus change while running. Success shows a short HUD toast and removes the captured output. Failure shows an error toast and opens the combined stdout/stderr log in a new native file tab. If a remote host is selected at completion, the toast gives the local log path instead of trying to open it remotely.
- **Tab:** opens a dedicated terminal running the helper directly, not an injected prompt command. The helper starts the selected shell with the command's profile option. Output and the actual exit code remain until Enter acknowledges completion. Tern closes a successful tab after acknowledgement; failed tabs can be closed normally. This is not a reusable shell prompt.
- Background stdin is closed: choose tab mode for commands that need terminal input. Builds have no plugin-imposed timeout; the 15-second limit applies only to configuration RPC. Completion is the command shell's exit, not detached processes it intentionally leaves running.
- Failure logs are `<system-temp>/tern-project-commands-*/output.log`, with directory mode `0700` and file mode `0600`. They are not truncated and can contain sensitive command output. They remain until removed by you or the OS; the plugin does not delete a log that a file tab may still be displaying.
- Background completion notifications require the originating Tern window and plugin VM to remain loaded. Reloading a plugin drops its pending callbacks; do not reload during a build if you need its completion HUD or automatic failure-log tab.


## Configuration

Definitions live in `<project>/.omp/tern-commands.yaml`. Search starts at the originating pane's cwd and walks upwards, stopping at the nearest configuration or Git root. Definitions are never merged. Without either, the originating cwd is used. A missing configuration is shown as an empty list and is created only on Save.

```yaml
version: 1
commands:
  - id: rust-release
    name: Rust release build
    enabled: true
    execution: background
    cwd: server
    shell: zsh
    profiles: true
    env:
      RUSTFLAGS: "-C target-cpu=native"
    run: |
      cargo build --release --locked

  - id: web-build
    name: Web production build
    enabled: false
    execution: tab
    cwd: web
    shell: fish
    profiles: true
    env:
      NODE_ENV: production
      NODE_OPTIONS: "--max-old-space-size=8192"
    run: |
      npm run build -- --mode production
```

IDs are unique lowercase letters/digits/hyphens, beginning with a letter. Name and script are required. Optional defaults: `enabled: true`, `execution: background`, `profiles: true`, `cwd: .`, `env: {}`, and `shell: zsh` on macOS (`sh` elsewhere). Existing YAML without `execution` runs in the background; use `execution: tab` to request a visible terminal. Existing YAML without `profiles` loads profiles; set `profiles: false` to opt out. A missing version is accepted as version 1; writes include it.

The working directory must stay inside the project, including after symlink resolution. Specify a shell name such as `zsh`, `fish`, `bash` or `sh`; its executable is resolved from the execution process's `PATH`, then standard installation directories, including Homebrew on macOS. An absolute executable path remains supported when a particular installation is required. A missing shell is an error, not a fallback to a different shell. Shell discovery does not run a profile.

Commands run non-interactively. With **Load shell profiles On**, the shell starts as a login shell: zsh reads its login startup files, bash reads its login profile, and fish reads `config.fish` and other normal startup configuration. Interactive-only files or sections, such as zsh's `.zshrc` and fish's `status is-interactive` guards, are not loaded/executed merely by this option. Put build-tool initialization in the corresponding non-interactive startup configuration, or set command environment values explicitly.

With **Load shell profiles Off**, zsh uses `-f`, bash uses `--noprofile --norc`, and fish uses `--no-config`. zsh always reads the system `/etc/zshenv`; it cannot be disabled with `-f`. The plugin does not append commands to the parent shell's history; fish additionally always uses `--private`. Startup files and scripts can deliberately perform their own writes or start other shells: they remain trusted code, not a sandbox.

The script uses the selected shell's syntax: a POSIX script is not translated into fish syntax. Configured variables are exported literally after startup, and cwd is restored before the script, so profile changes do not override these command settings. Environment values are not templates: `"$HOME"` means the literal characters `$HOME`; use shell expansion inside `run` when needed.

Background execution inherits the Tern window's environment; tab execution inherits the daemon's terminal environment. Profiles On can initialize build tools in those environments. With profiles Off, use an absolute tool path or set a complete literal `PATH` if cargo/node/npm is available only through startup files.

Commands have the user's ordinary filesystem and process permissions; they are **not sandboxed**. Only run definitions you trust. Variables are saved as plaintext: do not store secrets in this YAML; inherit them from the execution environment instead.

## Saving and errors

- YAML parsing uses the pinned `yaml` package. Existing comments on retained fields are preserved, but formatting can be normalized.
- Invalid YAML, unknown fields, duplicate IDs/keys, unsupported versions, aliases, non-string env values and files over 1 MiB are rejected. Configuration-file symlinks are rejected.
- Writes use a sibling temporary file and rename. A file revision guard refuses stale edits, and a short-lived `.lock` serializes plugin writers. This is not a transactional lock on unrelated external editors.
- On a save conflict, the draft remains in the form. Copy anything needed, Cancel, then Reload; the external file is not overwritten. Simultaneous plugin editors cannot both save against the same revision.
- Undo restores only the deleted command, including its YAML comments and settings, at its former list index (or the end if the list is now shorter). It does not roll back edits to other commands. Stale revisions and a reused command ID refuse restoration without overwriting disk or consuming the undo entry. Resolve any ID conflict, then **Reload** and retry **Undo delete** while the manager is still open.
- A lock left after a crash is never removed automatically. Verify no save is running before manually removing the named `.lock`.
- Unsaved form drafts are intentionally not persisted across plugin reloads or Tern restarts.

## Verification

```sh
bun test
bun run smoke
```

`bun test` exercises storage, parsing boundaries, comments, conflicts, concurrent writers, root discovery, execution/profile option persistence, disabled execution, executable-name lookup, real bash/zsh/fish startup and history isolation, literal environment values, working directories and exit status. Background cases cover stdin EOF, success cleanup, spawn failure and private failure logs containing more than 16 MiB of stdout/stderr.

`bun run smoke` opens a real macOS Tern window against an owned temporary HOME/config/daemon and projects. It checks the installation target before linking and uses Tern's official local account test scenario only in that isolated window. A temporary fixture plugin also scopes the daemon's actual shell launches to the test HOME; GUI environment isolation alone is insufficient. The smoke operates the native form and Cmd+K, verifies profile On/Off persistence and startup effects for named zsh/fish shells, unchanged command history, background success without layout changes, a build exceeding 15 seconds, failure-log contents in a native file tab, and tab-mode output retention. It retains project-switch, Off, rename, removal and reload coverage, captures screenshots and closes its owned processes. It never links into the normal user installation.

Deletion coverage includes empty-list and ordered restoration, intervening edits, revision/ID conflicts and rejected receipts. The native smoke checks Delete/Undo buttons, palette changes, stacked deletion undo, form-versus-list keyboard undo, conflict recovery, tab switching, and history expiration when the manager closes.

The script prints the path to `evidence.json`, containing observed values, the control-command transcript, screenshots and SHA-256 fingerprints of the source it exercised. Temporary evidence is retained for inspection. The accompanying `verification.json` records the latest successful run. No Rust/npm project build, OS-level IME composition, Linux run, or standalone Luau static analysis was performed; Unicode text entry and undo were exercised through Tern's native input controls.

## Files

- `window.luau`: project-scoped palette registration, execution routing, completion HUD and failure-log opening.
- `host.luau`, `lib/editor.luau`, `style.css`: native list/form and the spawn hook that bypasses the default shell for command tabs.
- `lib/bridge.luau`: asynchronous Bun RPC.
- `helper.ts`: YAML storage, shell resolution/profile selection and private background logs; scripts are never evaluated by the YAML parser.
