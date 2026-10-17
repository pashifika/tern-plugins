# Project Commands configuration

The [README](../README.md) covers installation and first use. This guide covers
project selection, execution settings and recovery when a command cannot run.

## Where commands are stored

Definitions live in `.omp/tern-commands.yaml` inside a project. Starting at the
focused pane's working directory, the plugin walks upward and uses the nearest
configuration file or Git root. If it finds neither, it uses the starting
directory. It does not combine definitions from parent projects.

The manager creates a missing configuration only when you save a command.
Opening a project or manager does not run anything. After editing YAML outside
Tern, choose **Reload** in the manager. If Cmd+K was already open, close and
reopen it to refresh its command list. Projects can reuse command IDs.

## Command fields

The top-level document contains `version: 1` and a `commands` list. An omitted
version is accepted as version 1 and is written explicitly on the next save.

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | string | Required | Unique lowercase letters, digits and hyphens; start with a letter. |
| `name` | string | Required | Label in the manager and command palette. |
| `run` | string | Required | Script in the selected shell's syntax; multiline is supported. |
| `enabled` | boolean | `true` | Off keeps the definition but prevents launch and hides it from Cmd+K. |
| `execution` | string | `background` | Choose `background` or `tab`. |
| `profiles` | boolean | `true` | Load the shell's noninteractive login startup files. |
| `cwd` | string | `.` | Relative path inside the project, including after resolving symlinks. |
| `shell` | string | `zsh` on macOS; otherwise `sh` | Executable name or absolute executable path. |
| `env` | mapping of strings | `{}` | Literal environment values, applied after shell startup. |

Existing commands without `execution` run in the background. Commands without
`profiles` load profiles. Set these fields explicitly to choose otherwise.

Environment values do not expand shell variables: `"$HOME"` remains those five
characters. Expand variables in `run` when needed. The native environment editor
is single-line; use YAML for values containing newlines. Keep secrets out of the
file and inherit them from the execution environment instead.

For a Rust crate with `Cargo.toml` and `Cargo.lock`, a release command can use
`cargo build --release --locked` and an `env` entry such as
`RUSTFLAGS: "-C target-cpu=native"`. For an npm project with a `build` script,
use `npm run build` and `NODE_ENV: production`. These depend on your project's
toolchain and build scripts; the plugin does not install them.

## Shell startup and tool lookup

A shell name resolves through the execution process's `PATH`, then standard
installation directories, including Homebrew on macOS. An absolute path selects
that installation. A missing shell produces an error rather than using another
shell. Lookup does not start a profile, and command `env` values do not change it.

| Shell | Profiles On | Profiles Off |
|---|---|---|
| zsh | Noninteractive login startup, including `.zprofile` | `-f` skips user startup files |
| bash | Noninteractive login profile | `--noprofile --norc` |
| fish | Normal configuration, including `config.fish`, in login mode | `--no-config` |

On does not make the shell interactive. zsh's `.zshrc` and fish sections guarded
by `status is-interactive` do not run. Put build-tool initialization in
noninteractive startup configuration or set an explicit command environment.
zsh still reads system `/etc/zshenv` even with profiles Off.

The plugin does not type commands into your existing shell or append them to its
history. fish always uses `--private`. Startup files, scripts and shell wrappers
remain trusted code and can perform their own writes. Scripts are not translated
between POSIX and fish syntax.

After startup, the plugin restores the selected working directory and applies
command environment values. Background execution inherits Tern's window
environment; terminal execution inherits the daemon's terminal environment.
If a tool is missing with profiles Off, use its absolute path or a complete
literal `PATH` value. Profile-only initialization will not run in that mode.

If the plugin itself cannot find Bun, it searches in this order:

1. `TERN_PROJECT_COMMANDS_BUN`, an executable-path override.
2. `$HOME/.bun/bin/bun`.
3. `/opt/homebrew/bin/bun`.
4. `bun` on the Tern process's `PATH`.

Set an override in the environment that starts both Tern and its daemon.
Missing Bun or dependencies produces an error; the plugin does not install them.

## Output and completion

| Mode | While running | On completion |
|---|---|---|
| Background | No new tab or focus change; stdin is closed. | Success displays a notification and removes captured output. Failure opens the combined stdout/stderr log in a new file tab. |
| Tab | A dedicated terminal runs the command. | Output and the actual exit code remain until Enter. Successful tabs then close; failed tabs can be closed normally. |

Choose tab mode when the command needs terminal input. The completed tab is not
a reusable shell prompt. Builds have no plugin-imposed timeout. A command is
finished when its shell exits, not when any detached process it launched exits.

Failure logs use a `tern-project-commands-` directory under the system temporary
directory, with the filename `output.log`. The directory is private (`0700`)
and the file is readable only by its owner (`0600`). Output is not truncated.
Logs can contain sensitive data and remain until you or the OS removes them.
If a remote host is selected at completion, the notification provides the local
log path instead of opening it remotely.

Keep the originating Tern window and plugin loaded during a background build.
Closing that window or reloading plugins drops pending completion notifications
and automatic log opening. Turning Off or deleting a definition does not stop
an already running command.

## Delete and Undo

Delete writes the configuration immediately. **Undo delete (N)** restores the
most recently deleted command; repeat to restore earlier deletions. In the list,
**Cmd/Ctrl+Z** does the same. In a form, it continues to undo text edits.

Undo restores the command's settings and YAML comments at its former list index,
or at the end if the list is now shorter. It keeps changes to other commands.
A reused ID blocks restoration rather than overwriting the new command.

History belongs to the open manager. Switching tabs and reloading the same
project's YAML retain it. Closing the manager, changing its resolved project,
reloading the plugin or restarting Tern discards it. There is no persistent
trash or Redo. Unsaved form drafts are also lost on plugin reload or restart.

## Saving and recovery

The plugin retains comments on existing fields, though YAML formatting can
change on save. It rejects these inputs without replacing the file:

- Invalid YAML, duplicate keys or IDs, unknown fields and unsupported versions.
- YAML aliases and non-string environment values.
- Configuration files larger than 1 MiB or configuration paths that are symlinks.

| Message or situation | What to do |
|---|---|
| Configuration changed on disk | Copy any unsaved draft, Cancel, then Reload. The other editor's changes are not overwritten. |
| Undo meets a newer revision | Reload and retry Undo while the manager is open. The failed attempt keeps the undo entry. |
| Duplicate command ID during Undo | Resolve the conflicting ID, Reload, then retry Undo. |
| Configuration is locked | Check that no save is running. Only then remove a confirmed leftover `.lock` file named in the error. |
| Cmd+K looks stale after a YAML edit | Reload in the manager, then close and reopen Cmd+K. |

For storage internals and verification procedures, see
[CONTRIBUTING.md](../../CONTRIBUTING.md).
