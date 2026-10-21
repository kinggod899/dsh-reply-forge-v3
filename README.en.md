# dsh-reply-forge v3

**Forge what the model sees.**

Edit any reply in a live DSH session — or any thinking block behind it — and from the very
next turn, **your version is the conversation history**. The model doesn't just display your
words; it *remembers* them. No restart. No refresh-and-it's-gone. No re-reading a log to
check whether it took.

> 中文说明请见 [README.md](./README.md)；完整使用手册见
> [使用说明.md](./使用说明.md)（Chinese）

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-321%20%2F%2014%20suites-brightgreen.svg)](#tests)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg)](https://github.com/kinggod899/dsh-reply-forge-v3)

A plugin for the DSH desktop app (DeepSeek Harness). Every assistant message gets a
**Forge** button — hover, click, rewrite the reply or the hidden chain-of-thought, write
it back. Everything after that turn reads what you wrote.

Featured in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), the curated DSH plugin list (PR #7845, merged).

## Three generations, one idea

| | v1 | v2 | **v3** |
|---|---|---|---|
| What it edits | what's on screen | the session log on disk | **the live session object** |
| Visible to the model | no | yes, after restart | **yes, immediately** |
| Thinking chains | no | no | **yes** |
| Mechanism | localStorage overlay | rewrite `.jsonl.zstd` | message projection |

v3 keeps v2's disk rewrite as its **fallback branch**: session alive in memory → write the
live session (takes effect at once); not in memory → rewrite the log (takes effect on next
load).

The other generations live in their own repos and can coexist (separate plugin ids and
prefixes) — just never all three at once, they share one message action bar:

- **v2 (disk-only rewrite)**: https://github.com/kinggod899/dsh-reply-forge-v2
- v1 (localStorage overlay): the first take, its story is told in v2's docs

## Quick start

1. Hover any assistant reply → hit **Forge**.
2. In the editor: pick a target (any editable block in the session — including folded-away
   thinking blocks you can't click on screen) and a write mode (default: auto).
3. Rewrite, hit **Forge**. A confirmation spells out exactly what will happen; then it's
   done and visible.

Two exits: **Render locally** (Ctrl+Enter — this page only, invisible to the model,
reversible) and **Forge** (the model's copy — immediate online or on-reload via disk,
**irreversible**). Full UI reference, the write-mode table and troubleshooting are in
[使用说明.md](./使用说明.md) (Chinese docs; English docs are on the roadmap).

## See it in action

| Written in — next turn reads it | Thinking chains too | Three write modes |
|:---:|:---:|:---:|
| ![write into live session](./docs/screenshots/01-write-into-live-session.jpg) | ![edit thinking chain](./docs/screenshots/02-edit-thinking-chain.png) | ![write modes](./docs/screenshots/03-write-modes.png) |

One unedited session, three frames: an assistant reply is rewritten to
"因为我是吃白饭的大肥鱼。" — the green receipt lights up ("the model sees your version
next turn, no restart; focus handed back to the composer"). Ask it anything next turn
and it answers **as a freeloader fish**. Middle: the editor for a thinking block —
`seq=38 块0` in that dropdown is the folded-away monologue you never see on screen.
Right: the write modes — **auto** (live write when the session is in memory, disk
otherwise — recommended), **online only**, **disk only**.

## Will disabling the plugin corrupt my sessions?

**Not if the markers are right** — but that "not" comes with a precondition.

`reply-forge/patch` is an event type the host doesn't know. The persistence gate
`validateStoredEvents` (`@deepseek-ai/dsh-session-persistence`) refuses the **entire
log** — session won't open — when an unknown event type arrives without `ignorable: true`
on its envelope. The projection layer (plugin present) just skips unknown types: no error,
the forge silently falls back to the original text. The host's own comment spells it out
(`known-event-types.js`):

> The persisted `SessionEvent.ignorable` marker is the compatibility mechanism.

Three cases: **markers right + cold start** → session opens fine, forges fall back
silently; **missing markers** (early writes or a torn write) → gate refuses, repair tool
fixes; **hot-unload while DSH is running** → the host throws
`session message projection "reply-forge/patch" was removed` (normal usage always
restarts DSH, which replays everything cleanly — you'll never hit this).

v3's P0 work is making "markers right" structurally true: both write paths (online and
disk) go through a shim that stamps `ignorable: true` before the host persists anything;
every real write re-verifies the session's write handle (`WRITER_NOT_ROUTED` safely falls
back to disk, `APPEND_UNSAFE` is always rejected — full failure-code table in
[PLAN.md](./PLAN.md)); the persistence loop (create → append → flush → re-read → gate
opens) is covered by tests against the real host.

**If a session is already broken**: quit DSH, double-click `修复会话.bat` for a read-only
diagnosis, then `修复会话.bat apply` to stamp the markers — backup first, only toxic lines
touched, self-read verified after write, auto-revert on failure, unreparable damage
reported plainly instead of forced.

### Acknowledgments

[dsh-chat-thinking-editor](https://github.com/yumiao-dev/dsh-chat-thinking-editor) is an
important **reference** for this plugin — the earliest explorer of thought-chain editing
in the DSH ecosystem, whose live-edit goal and unusual honesty toward users (its PR notes
flatly state that edited sessions may become unreadable after uninstall) taught us a lot.
The difference is technical: it anchors edits on `assistant/message` with `surfaceOp`,
and the host still surface-validates those events when the plugin is absent — failing
that, it throws. v3 went the other way: private event + same-type projection +
`ignorable` marker (above). No hierarchy — just different trade-offs. Standing on its
shoulders, we pushed "uninstalls cleanly" a bit further.

## Install

Prerequisites: the DSH desktop app, and **Node.js** (the four `.bat` tools edit static
config with it — they probe PATH, `C:\Program Files\nodejs`,
`%LOCALAPPDATA%\Programs\nodejs`, and **DSH's bundled node**
(`%USERPROFILE%\.dsh\dsh-runtimes\...\node\bin\node.exe` — it ships with DSH)). No Node
either? The bats print the full manual four steps (package.json, cordis.patch.yml,
junction) and you follow them by hand. The plugin itself runs inside DSH — no extra
runtime.

Double-click `安装插件.bat`, then **fully quit and restart DSH** (static config needs the
restart to load).

The script does exactly three things: create the junction, write `bundles` and
`dependencies` into `package.json`, hand-register the lockfile entry. It never runs
`pnpm install` — doing that under a running DSH wipes `node_modules`.

By default the installer drops the two earlier generations from `bundles` (they share
one message action bar). Their deps and links stay; re-enable them any time with their
own `启用插件.bat`, or keep them side by side for comparison with
`node scripts/install.mjs --keep-v2 --keep-v1`.

Other scripts:

| Script | What it does |
|---|---|
| `安装插件.bat` | first install (junction, deps, lockfile, bundles) |
| `启用插件.bat` | put the plugin back into `bundles` when disabled |
| `关闭插件.bat` | remove from `bundles` — one-click rollback when DSH misbehaves |

All three only touch static config. None of them run `pnpm`. None of them delete your
overrides. All of them need a DSH restart afterwards (see above).

## How it works

The host refuses to let `assistant/message` carry a surface replacement —
`assertSourceEventReferences` demands that a replace event cover every shadowed node with
`sourceEventSeqs`, and the very same function hard-forbids `assistant/message` from
carrying `sourceEventSeqs`. The two constraints are mutually exclusive; it always throws.
The full argument, with host source evidence, is in [PLAN.md](./PLAN.md).

## Three write paths, ordered by cost

| Path | What it changes | Side effects |
|---|---|---|
| **Edit the pending queue** | a message not yet sent to the model (inbox) | **None** — the message never entered the log: no new event, no committed bytes touched, `sessionId` unchanged, provider cache untouched |
| Online patch | a historical message in the session log | Appends a private event; KV cache after the edit point is invalidated |
| On-disk rewrite | the session record file | Needs backup/restore; **a running host does not read the disk**, so the change only applies on next load |
| Local-only render | only what the page shows | The model never sees it — pure sleight of hand |

The first one was added after v3.1 and goes through the official
`session.updateQueue(itemId, { kind: 'edit', content: [...] })`. Its entry point
hangs on bubbles carrying `data-pending-steering` (messages injected as steering
mid-turn; `next-turn` queued messages render no bubble, so users never see them
and no entry is offered).

**Locating the item is done by matching text, and that is a host limitation, not
laziness**: the bubble DOM carries no id-like attribute at all (only the two
booleans `data-pending-steering` / `data-submission-echo`), so `itemId` can only
be found by comparing bubble text against queue row text. Consequently:

- Several byte-identical matches → **refuse** and say so; never gamble on the first;
- A row holding a non-text block (attachment) → **refuse**, because the server only accepts plain text and a silent rewrite would drop the attachment;
- Locating fails → no input box at all, only an explanation, so you can never "save without knowing which row you changed".

The error-code table was verified one by one against the host's `updateQueue`
handler in `dsh-api-session-controller/lib/index.js` (lines 822-845) — nothing was copied from another plugin.

The door the host *does* leave open is **message projection**: pure functions registered
per event type, deciding at fold time what the model sees for a given seq. So v3 appends
one private event, `reply-forge/patch` (pure log record, never enters the surface), and a
same-type projection rewrites the target message.

- No `surfaceOp` / `sourceEventSeqs` → no surface validation is ever triggered;
- Plugin disabled → events are skipped silently, forges fall back to the original text,
  sessions still open as long as the markers are intact;
- Forges survive restarts — session restore replays the registered projection list, and
  this plugin registers in `apply()`;
- Online writes end up in `session.v4.jsonl.zstd` just like disk writes, so both are
  equally durable. But the persistence layer validates event types — unknown types must
  carry `ignorable: true` or the whole log is refused, and `Session.append()` won't take
  that field, so v3 wraps the write handle with a shim that stamps it before the host
  persists (see "Will disabling the plugin corrupt my sessions?" above).

## Tests

```bash
node tests/projection.test.mjs   # mechanism on the real dsh-session host (SKIP if no host)
node tests/persistence.test.mjs  # P0: real-host persistence loop, create→append→flush→re-read→gate
node tests/ignorable.test.mjs    # P0: ignorable shim + per-session write-handle verification
node tests/live.test.mjs         # online layer validation and failure codes
node tests/patch.test.mjs        # patch data layer
node tests/routes.test.mjs       # routing layer
node tests/client.test.mjs       # client artifact
node tests/record.test.mjs       # staleness heuristics (root cause of the new-session stall)
node tests/session-write.test.mjs
node tests/session-log.test.mjs
node tests/session-repair.test.mjs  # damaged-session repair tool
node tests/build.test.mjs
node tests/session-anatomy.test.mjs
```

**321 assertions in 14 suites** — including P0's `ignorable` (28), the real-host
persistence loop (5) and `session-repair` (15). **21 of them** (`projection` 13 +
`persistence` 5 + `ignorable` 3) need the host package `@deepseek-ai/dsh-session`
installed; without it they SKIP (not fail), so the release zip stays green on machines
without DSH (300 assertions execute in that mode) — with a host present, all 321 run.
Or just run the gate:

```bash
node --test "tests/*.test.mjs"
npm test
```

After touching `.dsh-plugin/client/*.mjs` you must rebuild the artifact
(`node scripts/build-client.mjs` — a self-written inliner, zero dependencies, no JSX, no
export default); `build.test.mjs` asserts artifact and source stay byte-identical
(`npm run check`).

Two extra guards and one alternative backend:

| Command | What it does |
|---|---|
| `node scripts/lint-flat.mjs` | **Flatten guard**: checks for top-level identifiers that collide across client modules (flattening into a single file makes them silently overwrite each other — syntax checks cannot see it), plus syntax the inliner cannot handle |
| `node scripts/build-client-esbuild.mjs` | **esbuild backend (optional)**: writes only a preview (`client.esbuild.js`) by default; add `--write` to replace the real artifact |

`build-release.mjs` runs both guards before packing and aborts on failure. The esbuild
output is verified **behaviourally equivalent** (57/57 client tests, same
`{ name, inject, apply }` exports), but it needs `npx` to fetch the package, so the
zero-dependency inliner remains the default. Switching is an explicit `--write`, not a slip.

## CLI (offline rewriting)

Don't feel like the UI? Edit the files directly (quit DSH first):

```bash
node scripts/forge-session.mjs --session <id> --list
node scripts/forge-session.mjs --session <id> --list --kind reasoning   # list thinking blocks
node scripts/forge-session.mjs --session <id> --seq 42 --block-index 1 \
  --kind text --text "the rewritten reply" --dry-run
```

`--kind` takes `text` / `reasoning` / `both` (default `text`); `--list` filters by it —
so grab a thinking block's `seq`/`blockIndex` with `--list --kind reasoning` before
forging.

## Real-machine diagnostics

`scripts/diag-focus.mjs` — unattended reproduction of the classic "no cursor after save"
bug: boots the real host in Node (mirroring the app's boot recipe), opens the page in
headless Edge via CDP, runs "Forge → render locally", and samples `activeElement` plus
focusin/focusout trajectories the whole way. Run it with
`CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/diag-focus.mjs` (the safe-delete shim
otherwise blocks the host's lock-file cleanup).

## Version history

- **3.2.0** — inbox queue editing ships, plus three "missing button" fixes:
  - *New feature*: messages sent while the AI is mid-reply queue up as bubbles in the
    conversation; hover one and hit "Edit queued" to rewrite it — no cancel, no pausing
    the AI, no retyping;
  - *Real-machine bug, fourth fix*: "Edit queued" failed with "can't read the send
    queue" — the culprit was the read path detaching a host method from its object
    before calling it (fine under test stubs, throws on the real host and gets
    swallowed); restored the bound call and added a regression test shaped like the
    real host class;
  - *Real-machine bug, fifth fix*: long technical replies that merely *mention* "tool
    calls" lost their Forge button — the host never renders tool-call blocks inside
    message bodies (they're separate cards), so that vocabulary match was pure
    collateral damage; the classifier now only matches the host's usage/fee footer;
  - *Engineering*: the persistence real-host loop passed for the first time against
    the **real desktop host** (extracted from app.asar) — earlier runs had aligned
    with a stale copy; gate now **321 assertions / 14 suites** (21 need the host).
- **3.1.0** — three tracks:
  - *Usability*: fixed the new-session stall ("no locatable assistant text" on every new
    session — the online empty snapshot was cached as terminal, never re-read); write mode
    is now an explicit choice (auto / online-only / disk-only).
  - *P0 safety*: `ignorable: true` now covers both write paths (the shim stamps before
    host persistence), verified by the real-host persistence loop; new per-session
    write-handle verification (`WRITER_NOT_ROUTED` falls back to disk safely,
    `APPEND_UNSAFE` always rejected); new `修复会话.bat` (diagnose first, backup, atomic
    write, self-read verify, auto-revert on failure).
  - *Focus fixes (real-machine bugs, four rounds) + a fifth*: after saving a forge, the
    host composer wouldn't take keyboard input — fixed by closing the editor (returning focus
    to the composer) before removing the message block; round two found the host
    composer is unfocusable while inert (`contenteditable=false`, `focus()` a no-op), so
    the result is reported honestly ("focus returned" / "composer not editable yet"),
    with a focus sentry and the `__dshReplyForgeV3.focus()` debug namespace; round three
    caught the async-only path (button disabled mid-write, Chromium drops focus to
    `<body>`) — snapshot before disabling, restore after success, never steal the user's
    deliberate focus moves; round four identified the Electron native `window.confirm` as
    an OS-level modal that eats window keyboard focus (all DOM focus green, no typing) —
    replaced by a two-step in-page confirmation; the fifth fixed post-restart
    `STALE_TARGET` rejections (disk reads went around the projection, so `expectText`
    compared against pre-projection text) — reads now go through the projection,
    disk rewrites of already-forged blocks are refused (`PATCHED_TARGET`, projection
    wins), and one automatic stale re-read retry remains as a backstop. Client suite: 57;
    gate: 233/13, all green, real-machine re-verified by the author.
- **3.0.0** — first release: online writes via message projection with disk fallback,
  editable thinking chains, target picker.

## Friends

- [dsh-chat-thinking-editor](https://github.com/yumiao-dev/dsh-chat-thinking-editor) —
  the ecosystem's earliest thought-chain editor, our reference (see Acknowledgments)
- [dsh-reply-forge-v2](https://github.com/kinggod899/dsh-reply-forge-v2) — the previous
  generation: disk-only rewrite (needs a restart)

## License

MIT
