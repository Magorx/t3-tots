---
name: t3-get-output
description: >-
  Have a T3 thread make an artifact (image, HTML, video, doc) or fetch the files or
  diff a thread produced, and bring them into chat. Use for "make me a <thing> and
  send it here", "get me the file from <thread>", "send me what <thread> made",
  "diff of <thread>".
---
Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md). Steps that use the box, ListMachines, routines, cards or SendToUser are Grok Bot only; other agents follow t3-tots-rules "Grok Bot only". Send only the prompt the user asked for.

## 1. Make it (skip when fetching)
1. Resolve the computer, project and model as in t3-new-thread. Throwaway asks go to the user's sandbox project, from memory (ask once and save it if unknown), with `--model haiku --effort low`.
2. Write the prompt to a file (t3-tots-rules "Sending into threads"). Ask for one output path and no other changes: "<ask>. Save it as <subdir>/<name>.<ext> in this project. Do not change any other files. Reply with the path."
3. Start it: `t3ctl new --project '<P>' --model <m> --effort <e> --title '<short>' --prompt-file <file> --owner <subscriber> --wait --timeout 600` (`--owner marketing` for render, video or posting output, `--owner dev` otherwise; see t3-tots-rules "Thread owners"). For long renders, leave out `--wait` and check later with `t3ctl read`.

## 2. Fetch
- `t3ctl files --thread '<t>' --last-turn` copies the files the last turn created or changed into `<tools folder>/out/`, keeping each file's path inside the project (`out/src/index.ts`), so files with the same name don't overwrite each other. Leave out `--last-turn` for the whole thread. It never copies dotfiles or dot folders (`.env`, `.ssh`, `.gnupg`), files whose path names a token, auth or oauth (as a word: `author.md` is fine), secret, credential, password, keychain or private key, key files (`id_rsa`, `id_ed25519`, `.pem`, `.p12`, `.key`), symlinks, or files outside the project; it lists them as not copied.
- Files outside the project appear only if a reply names them. Take the path from `t3ctl read`.
- `t3ctl diff --thread '<t>'` gives the diff in a git project.
- For videos and other files already on the computer, CopyToBox them directly.

## 3. Send
1. CopyToBox to `/workspace/t3-out/<name>`.
2. For HTML or SVG, make a preview: `google-chrome --headless=new --no-sandbox --disable-gpu --window-size=1000,700 --virtual-time-budget=1500 --screenshot=/workspace/t3-out/<name>.png file:///workspace/t3-out/<name>.html`.
3. SendToUser the files and the preview, then one line: the thread, the model, and the path on their computer.
