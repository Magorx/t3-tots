---
name: t3-pm-thread
description: >-
  Set up and run a project manager (PM) thread in T3 that plans the work, pushes
  back, starts worker and reviewer threads, and checks results before calling
  anything done. Use for "make a PM thread", "run <project> for me", "manage this
  project in T3", "set up workers and reviewers", or when a goal spans several PRs
  or threads.
---
Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md). Steps that use the box, ListMachines, routines, cards or SendToUser are Grok Bot only; other agents follow t3-tots-rules "Grok Bot only". Starting the PM thread sends a prompt into T3, so it needs the user's yes to the brief. After that, the PM thread runs the project and you keep it moving.

## Roles
- The user decides what to build and approves anything risky or public.
- The PM thread plans, pushes back on weak ideas, splits the work, starts worker and reviewer threads, and checks their results.
- Worker threads do one task each, on their own branch.
- Reviewer threads read a worker's diff and report findings. They don't edit code.
- You watch every thread, pass the user's decisions in, and decide routine things under t3-tots-rules "Decisions". You don't make design choices for the PM.

## 1. Gather the brief
1. Read what exists: the project's README and docs, open PRs (`t3ctl prs --project '<P>'`), recent threads (`t3ctl threads --project '<P>' --main --limit 15`), and its tracker if there is one (t3-project-tracker).
2. Collect the user's own words about the goal, constraints and decisions already made. Don't fill gaps with your own choices; list them as open questions for the PM.
3. Take the PM's model, the worker and reviewer models, the review rules and the PR rules (merge method, branch protection, what PR text may say) from the user's memory. If memory has none, ask once and save the answer.

## 2. Write the PM prompt
Write it to `<tools folder>/out/prompts/` (t3-tots-rules "Sending into threads") and show it to the user. Use this outline:
```
You are the project manager for <project>. Goal: <the user's words>.
Context: <constraints, decisions so far, links, what already exists>.
Open questions: <gaps the user hasn't decided>.
How to work:
- Start with a plan of small tasks, each with a "done when" check. Push back where the plan or the ask looks wrong.
- Start one worker thread per task, each on its own branch, and give it the task, the context it needs and its check.
- For each worker result, start reviewers on <reviewer models>. Reviewers report findings and don't edit. Post each reviewer's summary as a comment on the worker's PR. Fix and re-review until no high-severity findings remain, at most <N> rounds.
- PR rules: <the user's PR rules>.
- Verify before calling a task done: run the tests and the app, and show the output.
- Keep three files in <pm folder> in the repo and update them after each step: state.md (the plan and each task's status), decisions.md (dated decisions and who made them) and questions.md (open questions for me, newest first).
- Ask me only about product direction, money, publishing, merges to main, or anything listed here: <user's keep-for-me list>.
- Never merge, publish, deploy or force push without my yes.
```

## 3. Start it
1. On the user's yes: `t3ctl new --project '<P>' --model <m> --effort <e> --title '<Project> PM' --prompt-file <file> --owner <subscriber>`. The owner follows t3-tots-rules "Thread owners": `dev` for game or engine work meant for main, `marketing` for video, scene or posting work. Sub-task threads follow the PM's owner. A separate worker thread started with `t3ctl new` needs its own `--owner`. Tell the PM in its prompt to pass the same `--owner` when it starts worker threads with `t3ctl new`.
2. Start one t3-watch routine for the PM thread with `t3ctl watch`. Add each worker and reviewer thread to the same watch as the PM starts them. `t3ctl subtasks --thread '<PM>'` lists the ones it started as sub-tasks, and `t3ctl threads --project '<P>' --limit 20` the ones it started as separate threads.
3. Tell the user in two lines: the PM thread's title and id, and what you'll bring to them.

## 4. Keep it moving
- Pass the user's answers into the PM thread with `t3ctl send`, not into workers, so the PM keeps one picture. Keep these messages short, as t3-tots-rules "Sending into threads" says.
- When the PM goes idle, read `<pm folder>/questions.md` in the repo. Bring new questions to the user, and send the answers back to the PM.
- Handle questions, approvals, stalls and limits as in t3-watch "Handle an event".
- When a worker finishes, check that the PM picked up the result. If the PM is idle with work left, send one short nudge naming the finished thread.
- At each milestone, send the user a short update: what's done and checked, what's next, and what needs them.

## 5. Finish
The project is done when `state.md` shows every task done and checked, and the user has seen the result. Offer t3-save-learnings for the PM thread, and update the tracker.
