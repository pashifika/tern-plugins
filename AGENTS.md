# Agent instructions

## Current scope

This repository contains Tern Luau plugins, each in its own directory.
`project-commands/` uses a Bun helper for project-local YAML storage and command
execution. Follow its [README](project-commands/README.md) for user behavior and
[CONTRIBUTING.md](CONTRIBUTING.md) for development procedures.

## Setup and verification

Run from the repository root:

```bash
bun install --cwd project-commands --frozen-lockfile
bun run --cwd project-commands test
bun run --cwd project-commands smoke
```

The smoke opens a real macOS Tern window with isolated installation and shell
state. Unit tests do not replace native UI verification. Report commands,
results, source revision or fingerprints, and any untested scope. Use disposable
projects; never register test plugins in the user's normal installation.

## SDK reference

- Use the official [Tern SDK](https://github.com/stencil-hq/tern-sdk), available
  locally at `examples/tern-sdk/`. It is an independent reference checkout, not
  part of this repository or a build prerequisite.
- Before relying on it, inspect its remote, working tree and tracking branch.
  Update a clean, tracking checkout with `git pull --ff-only`; stop on local
  changes, divergence or a detached HEAD. Never reset, stash or force-update it.
- For runtime compatibility, compare SDK guidance with the installed Tern's
  `tern plugin types project-commands` and version. Record both versions when they differ.
  Follow [SDK refresh](CONTRIBUTING.md#sdk-reference) for the exact procedure.

## Change discipline

- Read the relevant source and existing conventions before editing. Keep changes
  within the request; preserve unrelated work.
- Use a topic branch and record the intended PR base. Use Conventional Commits;
  do not rewrite published history, bypass checks or change live repo settings.
- Keep public documentation in English. Keep user instructions in the plugin
  README, configuration details in its docs, and development procedures in
  CONTRIBUTING.md rather than duplicating them here.
- Cover observable behavior and boundaries. Verify UI changes on the actual
  Tern surface; do not substitute source-text assertions or mock echoes.
- Keep credentials, personal configuration and private logs out of commits.
  Review verification artifacts before publication. Do not stage the SDK
  checkout, generated declarations, dependencies or temporary PR files.
