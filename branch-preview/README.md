# Branch Preview

A Tern window plugin that keeps long Git branch names compact in OMP's native
chat composer while leaving file-change counts visible.

## Behavior

- The branch name uses its natural width, up to 140 design pixels. Names that
  fit, including an exact fit, remain complete; longer names use an ellipsis.
  Tern scales these pixels with the terminal font. A narrow strip can shrink
  the branch further.
- Change counts such as `*2 +1 ?12` remain separate, retain OMP's colors, and do
  not move when the preview opens.
- Hover the Git segment in the focused pane to show the full branch name above
  the status strip. The preview wraps within the available status width, up to
  480 design pixels.
- The compact branch label stays visible in place while the popup is open.
- The existing Git click action, model control, and send button remain intact.

The preview uses CSS generated content styled with Tern's popover, font, border,
and radius tokens. It is **not** Tern's native `title` tooltip or the model
selection menu. The window entry reads the focused OMP composer's dock every
500 ms and on pane focus changes, updating a separate preview string only when
it changes. A branch rename can take up to one polling interval to reach the
preview. Conversation history is not read, the OMP surface is not modified,
and no Git commands or background processes are launched.

## Install locally

From the repository root:

```sh
tern plugin link ./branch-preview
```

This registers the plugin in the installation reported by `tern plugin dir`.
To load edited plugin files:

```sh
tern plugin reload branch-preview
```

To remove the local registration:

```sh
tern plugin unlink branch-preview
```

## Compatibility

Targets OMP's native Tern composer, not shell prompts, Tern's Git pane, Carly,
or terminal-cell rendering. The stylesheet uses the `omp.session` surface,
`omp.composer.extras` role, Git node ID suffix `/git`, and OMP's branch-first
span ordering. Changes to those rendering details require requalification.

Qualified on macOS with Tern 0.9.8 (`f21d9a3`) and OMP 18.14.0. Desktop windows
load the plugin through its window entry; the web tab does not run that entry.
Touch-only interaction, split panes, and other operating systems are not qualified.
Tern still decides which status segments fit at extremely narrow widths.

Development and native acceptance procedures are in
[CONTRIBUTING.md](../CONTRIBUTING.md#branch-preview).
