# dsh-resend: release design and safety contract

This release is based on the verified DSH 0.2.0-rc.2 desktop and V4 session contracts. It is not a general-purpose log editor. See [the user guide](<README.md>) for behavior and explicit role/attachment limitations.

## Host protocol

The session event log is append-only. Context replacement targets an exact continuous slice of `session.surface.nodes`, not a guessed numeric log interval. V4 Session events have contiguous seq values; an external raw log array may include an unnumbered header, so accessors always validate the requested event seq rather than treating an array index as identity.

Regeneration finds a real user input (`user/message` with `source.kind === 'user'`), then includes that round's assistant/tool payload. Trailing runtime-only injections are excluded. Older replacement markers are never absorbed to the left.

Before writing, the implementation resolves the **actual host** session module, converts filesystem paths to file URLs, requires V4, adopts and disk-codec-validates the prospective audit/carrier events, folds the prospective history, and obtains official token-meter prices. Failure to load or validate any of these facts rejects the operation rather than skipping the gate.

A log-only `compaction/prune` audit is followed immediately by a model-sourced `user/message` replacement with `{op:'replace', startSeq, endSeq}` and `[auditSeq, ...shadowedSeqs]` provenance. Both appends are synchronous. The interval/next seq is rechecked after asynchronous work such as waiting for a cancelled agent. Session-local mutual exclusion prevents concurrent writes. Storage/follow-up failures report partial completion rather than pretending the old context is untouched.

### Reply editing is not assistant-message forgery

The verified V4 protocol forbids `sourceEventSeqs` on `assistant/message`, yet a replacement must cite every shadowed node. Reply editing therefore uses the permitted one-node user-role/model-source carrier, labelled explicitly as a **user-edited assistant reply**, followed by the exact edited text. It never creates a fabricated provider stream. A tool-call-bearing assistant node is refused. Repeated edits follow the validated replacement chain of the original reply.

## Renderer protocol

The client is a ready-to-load **classic script** registered via `window.__ModuleLoader__.load`, not a top-level ES module. Optional services are observed through scoped, effect-owned subscriptions; npm package names are not service dependencies.

The authoritative session id comes from the nearest `data-conversation-session`, present on both the main conversation and embedded child panels. The official `uiConversation.binding(sessionId).target('chat')` snapshot maps `data-chat-node-key` to a node. User seq comes from its own data/anchor; a completed assistant action strip is in `turn-tail`, whose target is `closing.finalNode.seq`, not the structural `turn/end` position. No React fiber extraction or turn-prefix guessing is used.

Before mutation, `inspect` provides canonical Markdown and confirms target identity and active surface membership. Selection, running state, plugin disposal, and asynchronous responses are rechecked. The user's composer draft is never used as a transport or modified by these actions.

Presentation reads exact `marks.shadowedSeqs`, follows edit-carrier provenance, and changes only owned chat presentation. It does not mutate the official snapshot, hide the Trajectory view, or delete event history. Edited response overlays do not replace reasoning seats. Copy interception is limited to native message actions, not code-block copy buttons.

## Ownership and teardown

A normal JavaScript function can be invoked as a constructor by Cordis. Returning a disposer from such an `apply` callback is not sufficient; the host route is explicitly owned by `ctx.effect`. Its cleanup checks route object identity before invoking the host's path-based disposer. Existing route collisions are refused, never stolen. A machine-specific legacy-route migration used during development is intentionally **not** part of this public release.

Client teardown removes only imperatively created, retained DOM objects. It must not use a broad data-attribute selector to remove React-owned slot children. Doing so races React reconciliation and can permanently retire the native action-row renderer. Owner/session-generation effects release borrowed subscriptions and references.

## Release boundaries

- No personal profile snapshots, logs, absolute installation paths, session dumps, destructive log-repair scripts, or development backup dependencies are shipped.
- Installed packages may be read-only. Diagnostics live under user-owned DSH data and are best-effort; logging failures do not alter session outcomes.
- Runtime peers are supplied by Harness and declared optional only to prevent package-manager duplication. The exact DSH version still participates in Harness compatibility checks.
- The published tarball contains the ready-to-run client/host code. The separate source release contains fixture-based tests and test runners.
- An installed source link, rewritten file, and active module cache are different facts. Never refresh/restart a working desktop to guess whether a change activated. Upgrade at an idle point and verify the active version.
- Tests establish specific code paths and contracts, not native end-to-end behavior on untested operating systems. Native Desktop verification has been performed only on Windows 0.2.0-rc.2.

## Regression groups

The source-release runner separates dependency-free unit checks, client DOM integration with jsdom, and real-runtime integration with `DSH_TEST_RUNTIME_ROOT`. Detached Session replay exercises V4 shape, exact span, role/provenance, repeated editing, tool protocol, concurrency, and failure boundaries. Actual Cordis and WebServer registration exercise repeated activation/disposal, duplicate refusal, and stale-disposer identity protection. No test needs private conversation data.
