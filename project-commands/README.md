# Project Commands

Save project commands with their environment variables and run them from Tern's Cmd+K palette.

Keep long build commands with the project instead of searching shell history or retyping flags. Edit them in Tern and choose whether each run needs a terminal tab.

## Features

- **Native editor:** create and edit multiline scripts, environment variables and command settings without leaving Tern.
- **Project-local commands:** keep definitions in `.omp/tern-commands.yaml`; enabled commands appear in Cmd+K.
- **Quiet builds:** run in the background, see a success notification, and open failure logs automatically.
- **Shell control:** select zsh, fish, bash or sh by name and turn profile loading On or Off per command.
- **Reversible deletion:** delete commands and undo in reverse order until you close the manager.

## Requirements

- Desktop [Tern](https://stencil.so/tern) with the 0.9.2 plugin API or newer.
- [Bun](https://bun.sh/) 1.3.14+ and Git for installation.
- The shell you select. fish is needed for the fish command below.

Verified on macOS with Tern 0.9.2. Linux is unverified; Windows, remote hosts, web and iOS are unsupported.

## Install

Clone this repository, or use your existing checkout and enter `project-commands/`:

```bash
git clone https://github.com/pashifika/tern-plugins.git
cd tern-plugins/project-commands
bun install --frozen-lockfile
tern plugin dir
tern plugin link "$PWD"
```

Check that `tern plugin dir` names the Tern installation you intend to use before linking. Keep the checkout and its dependencies in place; no build step is needed. To remove the plugin, run `tern plugin unlink project-commands`.

## Quick start

1. Focus a local project in Tern and press **Cmd+K** → **Project Commands: Open manager**.
2. Choose **New command**. Set ID to `project-directory`, name to `Project directory`, and Run to `pwd`.
3. Turn **Run in background** Off, then **Save** and **Run**. The new tab shows the directory; press Enter when finished.

## Usage

For three ready-to-run commands, create `.omp/tern-commands.yaml` in a Git project with the following contents. If you already have that file, add the entries to its `commands` list instead of replacing it. Choose **Reload** in the manager, then select a command from Cmd+K.

```yaml
version: 1
commands:
  - id: project-status
    name: Project status
    execution: tab
    run: |
      pwd
      git status --short --branch
  - id: build-environment
    name: Build environment
    execution: tab
    env: { NODE_ENV: production, RUSTFLAGS: "-C target-cpu=native" }
    run: |
      printf 'NODE_ENV=%s\nRUSTFLAGS=%s\n' "$NODE_ENV" "$RUSTFLAGS"
  - id: fish-tools
    name: Locate build tools with fish
    execution: tab
    shell: fish
    profiles: false
    run: |
      set -l tools bun git
      for tool in $tools
        command -v $tool
      end
```

Replace the scripts with your project's build commands when ready.
- **Turn Off:** hide a command from Cmd+K without deleting it.
- **Delete / Undo delete:** remove a command immediately and restore it with the Undo button or list-view **Cmd/Ctrl+Z**.
- **Undo lifetime:** switching tabs keeps deletion history; closing the manager or reloading the plugin discards it.

## Configuration

| Setting | Default | What it changes |
|---|---|---|
| `execution` | `background` | Success shows a notification; failure opens a log. `tab` keeps output visible until Enter. |
| `profiles` | `true` | Load noninteractive login startup files. `.zshrc` and interactive-only fish setup are excluded. |
| `shell` | `zsh` on macOS, otherwise `sh` | Find the executable automatically, or use an absolute path. Write the script in that shell's syntax. |
| `enabled` | `true` | Allow Run and include the command in Cmd+K. |
| `cwd` | `.` | Choose a working directory inside the project. |
| `env` | `{}` | Set literal string values after shell startup. |

Each command needs a unique `id`, a `name` and a `run` script. See the [configuration guide](docs/configuration.md) for project discovery, shell setup, logs and error recovery.

Only run definitions you trust: commands have your normal permissions, and YAML environment values are plaintext. Do not reload the plugin during a build if you need its completion notification. See the guide before storing sensitive output or troubleshooting missing tools.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for SDK updates, tests and real-desktop verification.

## License

This repository has no declared license. The upstream SDK's license does not license this plugin.
