# T3 Tots

Grok Bot / chat companion for [T3 Code](https://github.com/pingdotgg/t3code), with skills and helper tools. Thread status, waiting items, new threads, answers, reports, watches, and updates.

T3 Tots is unofficial. `t3ctl` and `t3listen` use T3 Code's internal local websocket API, which isn't public or stable, and `t3q.py` reads its database read-only. A T3 Code update can break them. T3 Tots will move to the official API when T3 ships one.

[MIT](LICENSE). No accounts or telemetry. The only outbound send is optional `t3listen` to a webhook you set up.

Start with [t3-getting-started](skills/t3-getting-started/SKILL.md). Install and verify by following [AGENTS.md](AGENTS.md). Shared rules: [t3-tots-rules](skills/t3-tots-rules/SKILL.md).

## What's here

| Path | What it is |
|---|---|
| `skills/` | One folder per skill. |
| `tools/` | Scripts, installed flat into one folder per computer. |
| `manifest.json` | Version, dest path, size, SHA-256, and which OS gets each file. |
| `scripts/`, `tests/` | Checks, manifest builder, skill sync. |
| `assets/avatar.png` | Official face, 1024x1024 PNG. First setup downloads it from the pinned release. |

| Tool | Where | What |
|---|---|---|
| `t3q.py` | all | Read-only T3 DB queries. No token. |
| `t3ctl` | all | Local API client and `skills` installer. `node t3ctl` prints usage. |
| `t3listen` | all | Optional. Pushes questions and run ends to your webhook. |
| `export.js`, `survey.js` | all | Redacted export and activity survey. |
| `t3ui` + `ui-*.applescript` | macOS | UI fallback if the local API is down (needs Accessibility). |
| `cleanup/scan.py` | all | Read-only disk-usage scan. |
| `cleanup/make_report.py`, `report/report.py` | Grok Bot box | HTML cleanup report and briefing. |
| `t3ctl.cmd`, `t3listen.cmd` | Windows | `cmd` wrappers. From PowerShell use `node t3ctl`. |

## Install

Install from a release tag, not from `main`. Every file is checked against that tag's `manifest.json` before it is used.

**Grok Bot.** Skills are built in. Say "set up T3 Tots". After your yes it installs the tools on each computer. The template card uses a geometric mark. First setup sets the official face from [`assets/avatar.png`](assets/avatar.png) when that download works.

**Other agents** (Claude Code, Codex, Cursor, Hermes). Download a release or clone the tag, then install the skills:

```sh
gh release download -R Deepusleepy/t3-tots --archive tar.gz
tar xzf t3-tots-*.tar.gz && cd t3-tots-*/
node tools/t3ctl skills install --to ~/.claude/skills --dry-run
node tools/t3ctl skills install --to ~/.claude/skills
```

Clone the same tag:

```sh
git clone --branch <tag> --depth 1 https://github.com/Deepusleepy/t3-tots.git
cd t3-tots
node tools/t3ctl skills install --to ~/.claude/skills --dry-run
node tools/t3ctl skills install --to ~/.claude/skills
```

Windows: `gh release download -R Deepusleepy/t3-tots --archive zip`, expand, then `--to "$env:USERPROFILE\.claude\skills"`.

Skill folders: Claude Code `~/.claude/skills`, Codex `~/.agents/skills`, Cursor `~/.cursor/skills`, Hermes `~/.hermes/skills` (same paths under `%USERPROFILE%` on Windows). Install into one folder only. Cursor also loads the other three, so a second copy is listed twice.

Then ask the agent to set up T3 Tots. It follows [AGENTS.md](AGENTS.md) (hash-check against `manifest.json`. Grok Bot-only steps: `t3-tots-rules` "Grok Bot only"). Updates use the same commands. Edited skills are kept unless you pass `--force` (the old copy goes to `out/skills-backup/<timestamp>/`).

## Phone answers (optional)

`t3listen` POSTs live T3 events to a webhook you set up (`setup`, then `install` at login). Events: `request.opened` / `request.resolved`, and `thread.finished` / `failed` / `cancelled`. Approvals only if you turn them on. Usage-limit stops can arm T3's Resume at reset.

Events add `turnState` without changing their existing names. By default, `listen.json` watches `["final","waiting-user","failed","cancelled"]`: an idle orchestrator waiting for work no longer wakes the webhook on every turn. `turnHint` contains `runningSubtasks`, `queued`, `pending` counts and `waitingCommand` (a short redacted description, or null).

| `turnState` | Meaning |
|---|---|
| `final` | Idle, with no pending request, actionable plan, queued run, running subtask or awaited background work. |
| `waiting-subagents` | Idle while delegated child threads or in-thread subagents are still working, or a delegated result handoff is pending/claimed. |
| `waiting-command` | Idle while a command/monitor is marked `awaited`, or a background task is pending. An unawaited server does not block final. |
| `waiting-user` | A question, approval or actionable plan needs attention. Questions and approvals keep the `request.opened` path; request closures also carry this lifecycle label. |
| `failed`, `cancelled` | The existing failure/cancellation events. Failures are still eligible even if a later run has started. |

`node t3listen watch` prints only the selected states. `node t3listen watch final,waiting-user,failed,cancelled,waiting-subagents` opts into subagent waits; `node t3listen watch ''` explicitly disables all automatic webhook events. Unknown states or a non-array `watch` fail at startup with `BAD_LISTEN_CONFIG`. The setter preserves URL, headers and other settings without printing them. Restart the listener to apply changes (`install` again, keeping `--approvals` if previously installed with it). The explicit `test` command bypasses this filter.

Queued messages, including a held queue, prevent a final notification. Filtered mid-job turns remain eligible for a later final, with deferred run IDs saved across restarts. The listener rereads the live shell before reporting and rechecks deferred parents on parent/child updates. Only the latest successful turn can be final; an earlier turn does not consume a follow-up turn's notification. Repeated run/state events are deduplicated for 14 days, with distinct `eventId`s for opt-in interim states. Webhook retries reuse the same ID, so receivers should deduplicate it too. `preview-finish` prints the classification even if the watch list filters it; it sends nothing.

Setup, events, approvals, and autoresume: [t3-phone-answers](skills/t3-phone-answers/SKILL.md). Who may answer: [t3-tots-rules "Decisions"](skills/t3-tots-rules/SKILL.md).

## Delegated mode and approvals

Delegated mode starts only when you hand over control, for example "I'm away, keep it moving". The agent then answers routine questions, nudges stalled threads, and resumes threads after a usage limit.

Even a full-access thread can stop on "Allow running this command?" when a safety check flags it, for example a git hook that asks before `git reset --hard`. In delegated mode the agent never says yes to these. It declines them with `t3ctl answer --decision decline --redirect`, which tells the thread not to retry or work around it, to use a safer way or skip that step, and to keep going. You get the list of what was declined and why when you're back.

When you're around, each approval comes to you as a card with the reason it asks, and the agent accepts it only after your yes for that request. `t3ctl answer` backs this up. An accept without `--user-approved` is refused with `NEEDS_USER_APPROVAL`, and nothing is sent.

Threads that `t3ctl new` and `t3ctl tasks --upsert` start run in full access unless you pass `--runtime`.

## Requirements

- **Python 3.8+** for `t3q.py` and `cleanup/scan.py` (3.9+ for `report/report.py`). Windows: `py -3`.
- **Node 22+** for `t3ctl` and `t3listen` (Node 18+ for `export.js` and `survey.js`).
- **T3 Code** installed and opened at least once.

## Security

- `t3q.py` opens `statev2.sqlite` read-only. From `server-runtime.json` it reads only `host`, `port` and `pid`.
- Scripts never open T3's `secrets/` or other credentials. The only token they read sits next to them, after your yes, with a 90-day TTL, and is never printed. Issue and revoke: [t3-tots-rules "Token"](skills/t3-tots-rules/SKILL.md).
- Traffic stays on `127.0.0.1` except optional `t3listen` POSTs to your webhook. Exports redact API-key patterns and your home path.
- No token: read-only. With one, `t3ctl answer` sends only the answer you chose, and accepts an approval only with `--user-approved`. `t3ctl skills` writes only into `--to` and its own `out/`.

Report issues in [SECURITY.md](SECURITY.md).

## Developing

- `scripts/check.sh`. Syntax, tests, manifest freshness, CRLF on the Windows wrappers, private-word scan. Never-ship words go one per line in `~/.config/t3-tots/private-words.txt` (do not commit it). No list fails the check. `T3TOTS_NO_PRIVATE_WORDS=1` skips it on purpose.
- After changing a tool, add it to `TOOLS` in `scripts/make-manifest.py` and run that script. It rewrites `manifest.json` from `VERSION`.
- `scripts/sync-skills --from <folder>` (or `T3TOTS_SKILLS_SRC`) copies live skills into `skills/`, scans for private details, and updates the manifest. It copies nothing if the scan fails.
- Never decide an approval by reading its text. T3 often shows a description instead of the command. Approval decisions go through `approvalAuthority`.
- Release only from a tag. Installers download by tag and check every hash.
