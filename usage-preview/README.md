# Usage Preview

A Tern window plugin that moves OMP's reset-credit details, such as
`✦ 2 exp 20d 19h`, into a hover preview in the focused pane.

## Behavior

- The tier, quota percentages, and reset times remain visible.
- Hover the usage segment to show its reset-credit details 6 design pixels
  directly above it, aligned to its right edge. Moving away hides them without
  moving the other status items.
- The credit count, expiry, usable count, and warning colors come directly from
  OMP. Nothing is calculated or replaced by the plugin.
- If credits are the only usage information, the clock icon remains as the
  hover target. Usage without reset credits is unchanged.
- Works alongside `branch-preview`; neither plugin depends on the other.
- Only the focused pane is restyled. Inactive panes retain OMP's native display.

The window entry reads only the focused composer's dock every 500 ms and on
pane focus changes. It identifies the credit span by its `✦` prefix and hides
its preceding separator. On hover, that same span becomes an absolutely
positioned popup. Text and color updates remain OMP's responsibility; changes
to the span structure can take one polling interval to be recognized.
Conversation history and account credentials are not read. No commands,
network requests, or background processes are started by the plugin.

## Install locally

From the repository root:

```sh
tern plugin link ./usage-preview
```

This registers the plugin in the installation reported by `tern plugin dir`.
To load edits or remove the registration:

```sh
tern plugin reload usage-preview
tern plugin unlink usage-preview
```

## Compatibility

Targets OMP's native Tern composer: the `omp.session` surface,
`omp.composer.extras` role, and usage segment ID suffix `/usage`. The separate
`omp.composer.usage` session-cost control is not changed. The plugin relies on
Tern rendering styled runs as span elements and unstyled runs as text nodes.

Native rendering was verified on macOS with Tern 0.9.13 (`8c6dfbd`) and the
composer structure from OMP 18.18.6, using synthetic usage values without an
account or model request. Light/dark themes, 1280/640 px widths, credit-only,
no-credit, expiring, expired, and dimmed status states were exercised.
Live account usage retrieval, split panes, touch, other operating systems,
and the web tab are not qualified. Tern still chooses which status segments
fit at narrow widths. See [verification.json](verification.json) for evidence
and [CONTRIBUTING.md](../CONTRIBUTING.md#usage-preview) for development notes.
