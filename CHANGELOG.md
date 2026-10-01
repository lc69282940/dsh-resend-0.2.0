# Changelog

## 0.2.0 — 2026-10-01

First distributable release of the repaired message-action plugin.

- Save edited assistant text with a validated one-node context replacement, retaining its prompt and other messages; do not automatically resend it.
- Read original Markdown through a read-only host endpoint.
- Map native message rows through official session/conversation identities, including the assistant turn-tail and child-session panels.
- Hide replaced rounds reversibly and preserve original event history.
- Validate actual V4 runtime and disk contracts; reject unsupported/missing runtimes and unavailable token accounting.
- Recompute seq/span after asynchronous waits, serialize mutations per session, and surface partial failures.
- Own HTTP routes explicitly through Cordis effects, reject route collisions, and protect against stale disposers.
- Clean up only client-owned DOM resources; cover selection races, copy failures, and session-generation disposal.
- Remove machine-specific install paths, private logs/fixtures, and development-only route takeover/log-repair utilities from public packaging.
- Add bilingual installation guidance, localized plugin metadata, release checks, and detached/fixture-based tests.

### Compatibility / known limitations

Verified only on Windows DeepSeek Harness Desktop 0.2.0-rc.2 (V4, Node 24+). Assistant edits use a labelled user-role context carrier, not the native assistant role. Regeneration resends text only and does not undo tool artifacts. Upgrade early development installations only at a safe idle point.
