---
name: t3-thread-actions
description: >-
  Settle, unsettle, rename, stop, snooze, fork, switch model or search T3 threads,
  manage a thread's queue, or resume one after a usage limit. Use for "settle
  <thread>", "rename <thread>", "stop <thread>", "snooze <thread>", "resume after
  the limit". For "what is <thread> asking", use t3-waiting.
---
Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md). Find the thread with its "Finding a thread" section, then do only the action asked, on that thread.

## Actions
| Action | Command |
|---|---|
| Settle or unsettle (reversible) | `t3ctl settle --thread '<t>'`, `t3ctl unsettle --thread '<t>'`. These act only on Grok threads (t3-tots-rules "Grok section"). For a main-list thread the user asked about, add `--force` |
| Rename | `t3ctl rename --thread '<t>' --title '<new>'` |
| Stop the running turn | `t3ctl interrupt --thread '<t>'`; `--hold` also holds the queue |
| Stop a run and its sub-tasks | `t3ctl stop --thread '<t>'`; this holds the queue |
| List sub-tasks, stop one Claude subagent | `t3ctl subtasks --thread '<t>'`, `t3ctl subagent-stop --thread '<t>' --subagent <id>` |
| Snooze | `t3ctl snooze --thread '<t>' --until '+2h'` (or `HH:MM` or ISO), `t3ctl unsnooze --thread '<t>'` |
| Switch model (idle only) | `t3ctl model --thread '<t>' --model <m> [--effort e] [--provider p]` |
| Fork to try an idea | `t3ctl fork --thread '<t>' --title '<x>' [--owner <subscriber>]` |

## Queue
A message sent with `--queue` waits until the current run ends. Queued messages can get stranded when a run is cancelled or the queue is held.
- List: `t3ctl queue --thread '<t>'`
- Deliver one into the running run now: `--steer <runId>`. Use `--steer all` only when every queued message is yours.
- Remove: `--cancel <runId|all>`, only with the user's OK or for your own stale messages.
- Edit or reorder: `--edit <runId> --text '<new>'`, `--move <runId> --first` or `--before <runId|end>`.
- Continue after a hold: `--resume`. A held queue is intentional, so ask before resuming one you didn't hold.

## Usage limits
- `t3ctl limits` lists threads stopped on a usage limit, with the reset time and whether auto-resume is set.
- `t3ctl resume-at-reset --thread '<t>'` makes T3 continue at the reset, or right away if it has passed.
- `t3ctl snooze-until-reset --thread '<t>'` hides it until then. `--cancel` undoes either.

## Reply
One line per thread with the new state, read back from `t3ctl threads`.
