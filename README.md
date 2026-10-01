# dsh-resend

[中文说明](<README.zh.md>) · [Design notes](<DESIGN.md>) · [Changelog](<CHANGELOG.md>)

Regenerate and edit messages in **DeepSeek Harness Desktop**. Adds actions after the native branch button, uses the host's validated V4 context-replacement protocol, and hides replaced rounds in chat without deleting the event history.

**Release:** 0.2.0 · **Verified host:** DSH 0.2.0-rc.2 on Windows · **Runtime:** Node 24+ · **License:** MIT

This is an independent community plugin, not an official DeepSeek release. Native macOS/Linux UI and other Harness versions have not been verified. Exact optional DSH peers declare the tested contract without installing another copy of the host.

## Behavior

| Target | Regenerate | Edit |
| --- | --- | --- |
| User message | Re-run its original text prompt | Read the original Markdown, save the changed prompt, then regenerate |
| Assistant reply | Re-run the round's original prompt | Replace **only this reply** in context; do not send another model request |

- Uses the official conversation/session identity, including side-panel child sessions; never guesses seq from a turn-number prefix.
- Preserves Markdown and whitespace when editing. Copying an edited reply returns the edited text.
- Chat hides replaced content reversibly. Trajectory and the append-only session log keep the original events.
- In-progress replies and unavailable or no-longer-active targets are not editable from the UI.

### Important limitations

1. **Reply editing does not preserve the native assistant role.** V4 forbids an assistant message from carrying the provenance required by replacement. The new context node is a lawful model-sourced **user-role** message explicitly labelled as a user-edited assistant reply. Its text is displayed at the original reply position. The prompt and other messages remain unchanged.
2. A reply containing tool calls cannot be replaced as text; choose a plain-text reply to avoid dangling tool results.
3. Regeneration resends **text only**, not images or other attachments. It does not undo files or external side effects produced by tools. Later unrelated rounds are not recomputed.
4. A validated audit/carrier pair is committed synchronously, but storage is not a filesystem transaction. A persistence or follow-up error can mean partial completion; read the error before retrying.
5. This plugin writes conversation context. Back up important sessions and first try it on a disposable conversation.

## Install the release archive

Wait until all tasks are idle. Open the **existing Desktop app → Plugins → Add plugin**, and provide the absolute path to `dsh-resend-0.2.0.tgz`. If your manager cannot resolve a local tarball, use the unpacked package directory or the bundled Desktop CLI below. Keep the local archive at a durable path: a profile may retain its file dependency.

From a terminal, use the **Desktop installation's own `dsh` command**, made available through the native application menu's command management:

```powershell
dsh plugin --profile desktop add "<absolute-path-to-dsh-resend-0.2.0.tgz>"
```

Do not substitute an unrelated npm-installed `dsh` command: the desktop profile is owned by Electron and the generic CLI can reject desktop management. A successful supported install adds both the dependency and the bundle entry; merely copying files or adding a bundle name is insufficient. Verify that the plugin is enabled and that both message action rows appear.

No build or installation scripts are needed when installing the archive. Do not start a Web/Vite server to make it work. If activation requires restarting the application, do that only after tasks have finished; refreshing a running renderer can interrupt them.

### Upgrade from a local development copy

Do not install a second copy beside an existing `dsh-resend` row. Save a backup of the plugin and profile, remove the old package through the plugin manager at an idle point, then install this archive. **Early development copies leaked their HTTP route on unload**. If you see a duplicate-route error, fully exit the app at an agreed idle point and start it normally; this public package deliberately does not seize another registered route or perform an automatic restart.

### Uninstall

Use Desktop's plugin manager or the bundled command:

```powershell
dsh plugin --profile desktop remove dsh-resend
```

This removes the plugin, not the conversation history. Already-saved context edits remain in session history; uninstalling does not undo them. The unmodified original transcript may become visible again when the display layer is removed.

## Diagnostics and compatibility

The endpoint prefix is `/api/plugins/resend`; normal operations are POST-only. `status` loads the real host's validators and reports protocol version 2, session format 4, and validation status. `inspect` returns canonical text without mutation. `marks` returns exact provenance for presentation. An unknown `inspect` endpoint means an old host half is still loaded; the client refuses to mutate through it.

Diagnostic output is best-effort and never written to the immutable installed package. The default is `$DSH_HOME/logs/dsh-resend/breadcrumbs.jsonl`; without DSH_HOME it uses `$DSH_PROFILE_DIR/logs/dsh-resend/` when available, otherwise `~/.dsh/logs/dsh-resend/`. `DSH_RESEND_BREADCRUMB` can select a complete file path; an explicitly empty value disables logging. The file is bounded to 256 KiB (old diagnostics may be discarded), and oversize payloads are truncated. Treat diagnostic exports as potentially sensitive; inspect them before sharing. No diagnostic logs, profile snapshots, personal paths, session fixtures, or repair scripts are shipped in the archive.

If the **Trajectory** tab is missing, first check **Settings → General → Show code work views** (`ui-settings.config.enabled` in the verified build). This plugin does not change that preference, restore other plugins, or require `dsh-desktop-context`.

## Development and release checks

The archive contains ready-to-run host JavaScript and the classic-script client; no compiler is needed. Full tests are in the source release, not the runtime archive.

```powershell
pnpm install --ignore-scripts
pnpm check
pnpm test
pnpm test:client
$env:DSH_TEST_RUNTIME_ROOT = '<verified-readable-DSH-runtime-directory>'
pnpm test:runtime
pnpm test:all
pnpm pack --pack-destination ../../dist
```

The runtime path must point at a readable DSH root containing its `node_modules`, not an ASAR virtual directory. If using an extracted mirror, compare relevant files with the current archive first. Runtime tests use detached sessions and isolated diagnostics; they never search or rewrite your real session store.

The public release removes development-only route takeover and on-disk session-repair utilities. It keeps explicit `ctx.effect` route ownership, exact surface-span validation, runtime fail-closed checks, concurrency protection, and bounded waits. See [design notes](<DESIGN.md>) for the safety boundaries.
