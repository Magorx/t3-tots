---
name: t3-new-thread
description: >-
  Start a new T3 thread or send a follow-up into one. Use for "new thread", "/new",
  "start a thread in <project>", "follow up in <thread>", "send this to T3".
---
Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md), including "Sending into threads". Send only the prompt the user asked for.

## 1. Resolve (read-only)
- Computer: the one the user names, else the one their message came from. For a follow-up, the computer that owns the thread.
- Project: `t3ctl projects`. `--project` takes an id, title or path. Titles and paths ignore case; ids must match exactly. If the folder isn't a project yet, ask before `~/.t3/bin/t3 project add <path>` (Windows: `t3.cmd project add <path>`).
- Thread, for follow-ups: t3-tots-rules "Finding a thread".
- Model: `t3ctl models` lists the models already used. Aliases are `haiku`, `sonnet` and `opus`, and pick the newest of that family; other ids look like `claude-sonnet-5-5`, `gpt-6.1-sol` or `grok-4.7`. Effort is low, medium, high, xhigh or max. With none given, the project default applies.

## 2. Write the prompt
- Pass on the user's words and context. Leave the design decisions to the thread.
- If the prompt is longer than a few lines, write it to a file and pass `--prompt-file <file>`.

## 3. Send
- New thread: `t3ctl new --project <P> --model <m> --effort <e> --prompt-file <file> [--title '<t>'] [--mode plan] [--attach a.png,b.jpg] [--owner <subscriber>] [--wait --timeout 300]`
- Follow-up: `t3ctl send --thread '<id|title>' --prompt-file <file> [--attach ...] [--queue] [--wait [--timeout 300]]`
- Add `--queue` only when the user wants the follow-up to wait for the run to end.
- Leave out `--wait` for long coding tasks, say it's running, and offer t3-watch.
- `--owner <subscriber>` (or env `T3_OWNER`) claims the new thread for one t3listen subscriber, so only that webhook is notified, starting from the first event. Choose it by content, as in t3-tots-rules "Thread owners": game or engine code meant for main is `dev`; video, scenes, posting and social work is `marketing`. Pass your own subscriber: Waterfalls Dev uses `--owner dev`, Waterfalls Marketing uses `--owner marketing`. Without `--owner`, the default subscribers get the thread. If the claim fails, the thread still starts and t3ctl prints the `claim` command to retry.
- `--owner` also puts the thread in the **Grok** section of the Custom T3 sidebar (t3-tots-rules "Grok section"). The user's main list stays theirs. Add `--no-grok` only when the user wants the thread in the main list; `t3ctl ungroup` moves one out later.
- Grok threads are yours to finish. Run `node t3listen sweep --owner <you> --json` hourly from your routine. Review each finished result and mark it with `node t3listen reviewed <id> --by <you>`. Settle only your own finished, reviewed Grok threads with `t3ctl settle --thread <id> --owner <you>`. Never settle the user's main-list threads (t3ctl refuses them with `NOT_GROK`).
- `t3ctl new` records the thread in `started-here.json`, so t3listen arms Resume at reset if the thread later stops on a usage limit.

## Fallback on macOS
Use the UI only if `t3ctl` fails and the user is OK with T3 taking focus: `t3ui new '<project search>' '<model search>' '<Low|Medium|High|Extra High|Max>' '<prompt>'` or `t3ui send '<exact sidebar title>' '<prompt>'`. Then check the result with `t3ctl read`. If macOS says the app isn't allowed assistive access, tell the user which app to allow in System Settings > Privacy & Security > Accessibility.

## Reply
In 1 or 2 lines: the thread title and id, project, model and effort, and the reply or "running". Say whether the message was steered into a running run, queued, or not delivered.
