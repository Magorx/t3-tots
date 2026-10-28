// Unit tests for t3listen's pure helpers. Run: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const l = require(path.join(__dirname, "..", "tools", "t3listen"));

test("pickThread: same rules as t3ctl (8+ character prefix, exact title, AMBIGUOUS, NOT_FOUND)", () => {
  const t3ctl = require(path.join(__dirname, "..", "tools", "t3ctl"));
  const ts = [{ id: "aaaa1111-0000", title: "Snig PR review", updatedAt: "2026-01-01T00:00:00Z" }, { id: "aaaa2222-0000", title: "Snig fixes", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "cccc3333-0000", title: "Other", updatedAt: "2026-01-02T00:00:00Z" }, { id: "dddd4444-0000", title: "other notes", updatedAt: "2026-01-02T00:00:00Z" }];
  assert.equal(l.pickThread(ts, "aaaa1111-0000").id, "aaaa1111-0000");
  assert.equal(l.pickThread(ts, "cccc3333").id, "cccc3333-0000");
  assert.equal(l.pickThread(ts, "pr review").id, "aaaa1111-0000");
  assert.equal(l.pickThread(ts, "OTHER").id, "cccc3333-0000"); // exact title beats the substring match on "other notes"
  assert.throws(() => l.pickThread(ts, "snig"), /^Error: AMBIGUOUS: 2 threads/);
  assert.throws(() => l.pickThread(ts, "aaaa"), /^Error: (AMBIGUOUS|NOT_FOUND)/);
  assert.throws(() => l.pickThread(ts, "ccc"), /NOT_FOUND: .*8 or more characters/);
  assert.throws(() => l.pickThread(ts, "nothing like it"), /^Error: NOT_FOUND/);
  for (const q of ["aaaa1111-0000", "cccc3333", "pr review", "OTHER", "snig", "aaaa", "ccc", "nothing like it", "aaaa"]) {
    const run = (f) => { try { return f(ts, q).id; } catch (e) { return e.message.split(":")[0]; } };
    assert.equal(run(l.pickThread), run(t3ctl.pickThread), `t3listen and t3ctl disagree on "${q}"`);
  }
});
test("cleanEvent: questions, option labels, approval prompt, titles and answers are redacted; ids are kept", () => {
  const os = require("os"), home = os.homedir();
  const e = { event: "request.opened", threadId: "t-1", requestId: "r-1", title: `fix ${home}/x`, questions: [{ id: "q1", question: "use key " + "sk_" + "live_abcdefghijklmnop1234?", header: "token: abcdefghijkl",
    options: [{ label: "ghp_" + "a".repeat(30), description: `in ${home}/proj`, value: "whsec_" + "b".repeat(24) }] }], answers: { q1: ["sk-ant-" + "c".repeat(24)] },
    approval: { requestKind: "command", prompt: `cat ${home}/.ssh/id && echo glpat-${"d".repeat(20)}`, options: [{ decision: "accept", label: "xo" + "xb-1234567890-abc" }] } };
  l.cleanEvent(e); const s = JSON.stringify(e);
  for (const bad of [home + "/", "sk_live_", "ghp_", "whsec_", "sk-ant-", "glpat-", "xoxb-", "abcdefghijkl"]) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  assert.equal(e.threadId, "t-1"); assert.equal(e.requestId, "r-1"); assert.equal(e.questions[0].id, "q1");
  assert.match(e.approval.prompt, /~\/\.ssh\/id/);
  assert.match(l.summary({ ...e, machine: "m", questions: undefined }), /\[redacted\]/);
});
test("localTime: names the zone (IST, not GMT+5:30)", () => {
  const { execFileSync } = require("child_process");
  const out = execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.join(__dirname, "..", "tools", "t3listen"))}).localTime("2026-01-01T12:00:00Z"))`], { env: { ...process.env, TZ: "Asia/Kolkata" } }).toString().trim();
  assert.match(out, /IST$/);
});

test("approvalsLine names which switch turned approvals on", () => {
  const { approvalsLine } = l;
  assert.equal(approvalsLine(false, false), "off");
  assert.equal(approvalsLine(true, false), "on (listen.json)");
  assert.equal(approvalsLine(false, true), "on (installed with --approvals)");
  assert.equal(approvalsLine(true, true), "on (listen.json and installed with --approvals)");
});

test("staleMinutes: missing means the documented 1440; 0 stays off", () => {
  for (const v of [undefined, null, "", "abc", -5]) assert.equal(l.staleMinutes(v), 1440, String(v));
  assert.equal(l.staleMinutes(0), 0); assert.equal(l.staleMinutes("30"), 30);
});
test("redaction catches github_pat_, npm_, xapp- and glpat- keys", () => {
  const keys = ["github_pat_" + "A1".repeat(15), "npm_" + "a1B2".repeat(9), "xapp-" + "1-A0".repeat(5), "glpat-" + "x_Y-".repeat(6), "sk-" + "a".repeat(24), "token = abcdefghij"];
  for (const k of keys) assert.equal(`see ${k} here`.replace(l.RED, "[redacted]"), "see [redacted] here", k);
});
test("log lines never print a raw thread title (titles go through clean)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tools", "t3listen"), "utf8");
  const raw = src.split("\n").filter((l) => /\blog\(/.test(l) && /\$\{t\.title\}/.test(l));
  assert.deepEqual(raw, []);
});

test("reportEnd redacts the event before it is first saved to listen-state.json", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const body = src.slice(src.indexOf("async function reportEnd"), src.indexOf("\n}\n", src.indexOf("async function reportEnd")));
  assert.ok(body.includes("cleanEvent(e)"), "reportEnd cleans the event");
  assert.ok(body.indexOf("cleanEvent(e)") < body.indexOf("saveState()"), "cleanEvent runs before the first saveState");
});
test("restart catch-up: any thread in the window (busy too), not only END[t.status]; buildEnd still skips", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("const since = S.lastAlive");
  const end = src.indexOf("afterSnapshotListen(", start);
  const block = src.slice(start, end);
  assert.ok(block.includes("catchUpThreads("), block);
  assert.ok(block.includes("reportEnd(ep, t, null, { since })"), block);
  assert.ok(!block.includes("END[t.status]"), block);
  assert.ok(!block.includes("!isBusy(t)"), block); // failed ends must still report when the thread is busy
  assert.ok(!/\b36e5\b/.test(block) && !block.includes("3600000"), block); // no hour cap; buildEnd skips completedAt < since
  assert.ok(src.includes('skip: "ended before the listener\'s last run"'));
  assert.ok(src.includes("sub-task thread that didn't fail"));
  assert.ok(src.includes("thread is going on with its next queued message"));
  assert.ok(src.includes("listening = false"), "socket close freezes lastAlive");
  assert.ok(src.includes("afterSnapshotListen("), "snapshot completion goes through afterSnapshotListen");
});

test("endedAt: missing completedAt uses now, not Date.parse(0)", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(l.endedAt({ completedAt: "2026-10-25T11:00:00Z" }, now), Date.parse("2026-10-25T11:00:00Z"));
  assert.equal(l.endedAt({}, now), now);
  assert.equal(l.endedAt({ completedAt: "" }, now), now);
  assert.equal(l.endedAt({ completedAt: "not-a-date" }, now), now);
  assert.ok(l.endedAt({}, now) !== Date.parse(0));
  assert.ok(l.endedAt({}, now) > 1e12); // a real "now", not epoch / year-2000 Date.parse(0)
});

test("tickLastAlive: freeze lastAlive while the socket is down", () => {
  const last = Date.parse("2026-10-25T10:00:00Z"), now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(l.tickLastAlive(true, last, now), now);
  assert.equal(l.tickLastAlive(false, last, now), last);
  assert.equal(l.tickLastAlive(false, undefined, now), undefined);
});

test("afterSnapshotListen: a close wins over an in-flight snapshot completion", async () => {
  const st = { listening: false, lastAlive: 1000, liveGen: 1 };
  const snapshotGen = st.liveGen;
  let finish;
  const inflight = new Promise((r) => { finish = r; }).then(() => {
    const next = l.afterSnapshotListen({
      socketOpen: false, gen: snapshotGen, liveGen: st.liveGen, lastAlive: st.lastAlive, now: 9999,
    });
    st.listening = next.listening;
    st.lastAlive = next.lastAlive;
  });
  st.listening = false; // onclose first
  st.liveGen += 1;
  finish();
  await inflight;
  assert.equal(st.listening, false);
  assert.equal(st.lastAlive, 1000);
});

test("afterSnapshotListen: still-open same generation advances lastAlive; gen mismatch does not", () => {
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: true, gen: 3, liveGen: 3, lastAlive: 1000, now: 2000 }),
    { listening: true, lastAlive: 2000 });
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: true, gen: 1, liveGen: 2, lastAlive: 1000, now: 2000 }),
    { listening: false, lastAlive: 1000 });
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: false, gen: 1, liveGen: 1, lastAlive: 1000, now: 2000 }),
    { listening: false, lastAlive: 1000 });
});

test("usageLimitFields: busy failed run still carries usageLimit / autoResumeSet / resumeAt", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const busy = { id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" };
  const a = l.usageLimitFields(busy, ended);
  assert.equal(a.usageLimit, true);
  assert.equal(a.autoResumeSet, false);
  assert.equal(a.resumeAt, reset);
  assert.equal(a.autoResumeNote, "thread is already busy");
  const armed = l.usageLimitFields({ ...busy, limitRecovery: { runId: "r1", resetAt: reset, autoResume: true } }, ended);
  assert.equal(armed.usageLimit, true);
  assert.equal(armed.autoResumeSet, true);
  assert.equal(armed.resumeAt, reset);
  const fromRun = l.usageLimitFields({ id: "t", status: "running", activeRunId: "r2" }, { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset });
  assert.equal(fromRun.usageLimit, true);
  assert.equal(fromRun.resumeAt, reset);
  assert.equal(l.usageLimitFields({ id: "t", status: "failed", lastErrorClass: "other" }, { id: "r", status: "failed" }), null);
});

test("usageLimitFields: ended-run lastErrorClass / reset; leftover shell + server_error is not usage_limit", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const moved = { id: "t", status: "running", activeRunId: "r2", latestRunId: "r2", lastErrorClass: "server_error" };
  const a = l.usageLimitFields(moved, ended);
  assert.equal(a.usageLimit, true);
  assert.equal(a.resumeAt, reset);
  assert.equal(a.autoResumeSet, false);
  const leftover = { id: "t", status: "failed", lastErrorClass: "server_error", usageLimitResetAt: reset, latestRunId: "r1" };
  assert.equal(l.usageLimitFields(leftover, { id: "r1", status: "failed", lastErrorClass: "server_error" }), null);
  assert.equal(l.usageLimitFields(leftover, { id: "r1", status: "failed" }), null);
});

test("usageLimitFields: autoResumeSet matches the ended run id, not a later latestRunId record", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const later = l.usageLimitFields({
    id: "t", status: "running", activeRunId: "r2", latestRunId: "r2",
    limitRecovery: { runId: "r2", resetAt: reset, autoResume: true },
  }, ended);
  assert.equal(later.usageLimit, true);
  assert.equal(later.autoResumeSet, false);
  const same = l.usageLimitFields({
    id: "t", status: "failed", latestRunId: "r1",
    limitRecovery: { runId: "r1", resetAt: reset, autoResume: true },
  }, ended);
  assert.equal(same.autoResumeSet, true);
});

test("usageLimitFields: server_error text mentioning usage limit is not a usage limit", () => {
  const reset = "2026-01-01T05:00:00Z";
  const run = { id: "r1", status: "failed", lastErrorClass: "server_error",
    lastError: { message: "upstream said usage limit" }, usageLimitResetAt: reset };
  const t = { id: "t", status: "failed", latestRunId: "r1", lastErrorClass: "server_error",
    lastError: { message: "upstream said usage limit" }, usageLimitResetAt: reset };
  assert.equal(l.usageLimitFields(t, run), null);
  assert.equal(l.usageLimitFields(t, { ...run, error: "upstream said usage limit" }), null);
  const noClass = { id: "r2", status: "failed", lastError: { message: "hit a usage limit" }, usageLimitResetAt: reset };
  assert.equal(l.usageLimitFields({ id: "t", status: "failed", latestRunId: "r2" }, noClass).usageLimit, true);
});

test("canArmResume: only the latest ended run; shellReadyToArm retries while busy", () => {
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2026-01-01T05:00:00Z" };
  const olderFailed = { id: "t", status: "failed", latestRunId: "r2", lastErrorClass: "server_error" };
  assert.equal(l.usageLimitFields(olderFailed, ended).usageLimit, true);
  assert.equal(l.canArmResume(olderFailed, ended), false);
  assert.equal(l.canArmResume({ id: "t", status: "failed", latestRunId: "r1" }, ended), true);
  assert.equal(l.canArmResume({ id: "t", status: "failed" }, ended), true);
  assert.equal(l.shellReadyToArm({ id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" }), false);
  assert.equal(l.shellReadyToArm({ id: "t", status: "failed", latestRunId: "r1" }), true);
  assert.equal(l.shellReadyToArm(null), false);
  assert.equal(l.canArmResume({ id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" }, ended), false);
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function armResume");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("!shellReadyToArm(t)"), body);
  assert.ok(body.includes("canArmResume(t, run)"), body);
  assert.ok(!/for \(let i = 0; i < 3 && !t;/.test(body), body);
});

test("catchUpThreads: includes a busy thread so a failed downtime end is still seen", () => {
  const since = Date.parse("2026-10-25T10:00:00Z");
  const idle = { id: "a", status: "idle", updatedAt: "2026-10-25T11:00:00Z" };
  const busy = { id: "b", status: "running", activeRunId: "r2", updatedAt: "2026-10-25T11:30:00Z" };
  const old = { id: "c", status: "idle", updatedAt: "2026-10-25T09:00:00Z" };
  const got = l.catchUpThreads([idle, busy, old], since).map((t) => t.id);
  assert.deepEqual(got, ["a", "b"]);
});

test("restart catch-up: reportEnd with since and no run id reports every ended run, not only ended.at(-1)", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function reportEnd");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("!runId && opts.since"), body);
  assert.ok(body.includes("for (const run of ended) await reportEnd(ep, t, run.id, opts)"), body);
  assert.ok(!/ended\.at\(-1\)/.test(body), body);
});

test("idLike: a full id or an 8+ character prefix, never a title with spaces", () => {
  for (const q of ["abcdefgh", "thread-0b6e2f1c-full-id"]) assert.equal(l.idLike(q), true, q);
  for (const q of ["abcdefg", "fix the login bug", "a/b/c/d/e/f"]) assert.equal(l.idLike(q), false, q);
});
test("idLike: no whitespace, length >= 8, colons allowed (thread:project:…, thread:delegated-task:…)", () => {
  for (const q of ["thread:project:abc12345", "thread:delegated-task:deadbeef", "thread:p"]) assert.equal(l.idLike(q), true, q);
  for (const q of ["thread:", "a:b:c", "fix the login"]) assert.equal(l.idLike(q), false, q);
});

test("systemdUnit: quotes and escapes paths and env values so spaces, quotes, % and $ survive", () => {
  const u = l.systemdUnit("/opt/my node/node", ["/srv/a b/100%/t3listen", "run"], "/srv/a b/100%", { T3_HOME: '/x "y" $HOME\\z' });
  assert.match(u, /^ExecStart="\/opt\/my node\/node" "\/srv\/a b\/100%%\/t3listen" "run"$/m);
  assert.match(u, /^WorkingDirectory=\/srv\/a b\/100%%$/m);
  assert.ok(u.split("\n").includes('Environment="T3_HOME=/x \\"y\\" $HOME\\\\z"'), u);
  assert.ok(l.systemdUnit("/n", ["/a$b"], "/d").includes('ExecStart="/n" "/a$$b"'));
});

test("preview-finish: NOT_FOUND in the shell list still reads an id-like query from T3; AMBIGUOUS and titles still stop", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const threads = [{ id: "abcdefgh-1", title: "One" }, { id: "abcdefgh-2", title: "Two" }];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads }));
    if (u === "/api/orchestration/threads/hidden-thread-42") return res.end(JSON.stringify({ projection: { thread: { id: "hidden-thread-42", title: "Hidden" }, runs: [] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (q) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", q],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  try {
    let r = await run("hidden-thread-42"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await new Promise((res) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread=hidden-thread-42"], { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } },
      (err, out, errOut) => res({ code: err ? err.code : 0, out: out + errOut }))); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/); // --key=value works too
    r = await run("abcdefgh"); assert.equal(r.code, 1); assert.match(r.out, /AMBIGUOUS/);
    r = await run("some missing title"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
    r = await run("missing-id-999"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
  } finally { srv.close(); }
});

test("preview-finish: archivedThreads are searched; colon ids are id-like; AMBIGUOUS still stops", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-arch-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const threads = [{ id: "abcdefgh-1", title: "Live One" }, { id: "abcdefgh-2", title: "Live Two" }];
  const archivedThreads = [{ id: "arch-thread-99", title: "Old archived" }];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads, archivedThreads }));
    const known = [...threads, ...archivedThreads, { id: "thread:project:abc12345", title: "By id" }, { id: "thread:delegated-task:deadbeef", title: "Delegated" }];
    const hit = known.find((t) => u === "/api/orchestration/threads/" + t.id);
    if (hit) return res.end(JSON.stringify({ projection: { thread: hit, runs: [] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (q) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", q],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  try {
    let r = await run("Old archived"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("thread:project:abc12345"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("thread:delegated-task:deadbeef"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("Live One"); assert.equal(r.code, 0, r.out);
    r = await run("abcdefgh"); assert.equal(r.code, 1); assert.match(r.out, /AMBIGUOUS/);
  } finally { srv.close(); }
});

test("preview-finish: usage-limit fields come from the ended run; armResume is not called", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function previewFinish");
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("usageLimitFields("), body);
  assert.ok(!body.includes("armResume("), body);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-limit-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const reset = "2026-01-01T05:00:00Z";
  const thread = { id: "limit-thread-01", title: "Limited", status: "running", activeRunId: "r2", latestRunId: "r2" };
  const ended = { id: "r1", status: "failed", startedAt: "2026-01-01T04:00:00Z", completedAt: "2026-01-01T04:05:00Z",
    lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.method + " " + decodeURIComponent(req.url));
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads: [thread] }));
    if (u === "/api/orchestration/threads/" + thread.id) {
      return res.end(JSON.stringify({ projection: { thread, turnItems: [], runs: [ended] } }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const r = await new Promise((done) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", thread.id],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => done({ code: err ? err.code : 0, out: out + errOut })));
  srv.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PREVIEW payload/);
  const json = r.out.slice(r.out.indexOf("{"));
  const payload = JSON.parse(json);
  assert.equal(payload.usageLimit, true);
  assert.equal(payload.resumeAt, reset);
  assert.equal(payload.autoResumeSet, false);
  assert.ok(!hits.some((h) => /dispatch|ws/i.test(h)), hits.join("\n"));
});

// ---------- subscribers: per-webhook routing ----------
const SUBS = {
  watch: ["final", "waiting-user", "failed", "cancelled"],
  subscribers: [
    { name: "dev", url: "https://example.invalid/dev", headers: { Authorization: "Bearer dev-secret-value" },
      match: { exclude: { titlePrefix: ["SHORTS-"], titleRegex: ["\\b(trailers?|devlogs?|clips?|posting|social)\\b"], branch: ["t3/shorts-*", "t3/trailer-*"] } } },
    { name: "marketing", url: "https://example.invalid/mkt", watch: "final,failed", delegated: "none",
      match: { include: { titlePrefix: ["SHORTS-"], titleRegex: ["/^TRAILER/i"], branch: ["t3/shorts-*", "t3/trailer-*"] } } },
    { name: "all", url: "https://example.invalid/all", delegated: "all", delegatedMatch: "self" },
  ],
};
const info = (title, branch = null, extra = {}) => ({ self: { threadId: extra.threadId || "t-1", title, branch, project: extra.project ?? null }, parent: extra.parent || null, delegated: !!extra.delegated });
const routed = (c, e, i) => l.routeFor(c.subscribers, { event: "thread.finished", turnState: "final", threadId: "t-1", ...e }, i).map((x) => x.name).join(",");

test("subscribers: no list = the old single webhook, unchanged watch, every thread", () => {
  const c = l.configFrom({ url: "https://example.invalid/x", headers: { A: "b" }, watch: ["final"] });
  assert.equal(c.multi, false); assert.equal(c.subscribers.length, 1); assert.equal(c.subscribers[0].url, "https://example.invalid/x");
  assert.deepEqual(c.watch, ["final"]);
  assert.equal(routed(c, {}, info("SHORTS-anything", "t3/shorts-1")), "default");
  assert.equal(routed(c, { turnState: "waiting-subagents" }, info("x")), "");
  assert.throws(() => l.configFrom({ url: "http://example.com" }), /url must start with https/);
});
test("subscribers: include/exclude by title prefix, regex and branch glob; a thread can match several", () => {
  const c = l.configFrom(SUBS);
  assert.deepEqual(c.watch.sort(), ["cancelled", "failed", "final", "waiting-user"]);
  assert.equal(routed(c, {}, info("Fix water mesh", "t3/fix-water-mesh")), "dev,all");
  assert.equal(routed(c, {}, info("SHORTS-12 render", "t3/foo")), "marketing,all");
  assert.equal(routed(c, {}, info("shorts-lowercase prefix")), "marketing,all"); // prefixes are case-insensitive
  assert.equal(routed(c, {}, info("Edit the Clips for posting")), "all"); // dev excludes the words, marketing doesn't include them
  assert.equal(routed(c, {}, info("Trailer cut v2")), "marketing,all");
  assert.equal(routed(c, {}, info("Plain title", "t3/trailer-teaser")), "marketing,all");
  assert.equal(routed(c, {}, info("Cliparts loader")), "dev,all"); // word boundary: "cliparts" isn't "clip"
});
test("subscribers: per-subscriber watch lists and test events", () => {
  const c = l.configFrom(SUBS);
  assert.equal(routed(c, { event: "request.opened", turnState: "waiting-user", requestId: "r" }, info("SHORTS-1")), "all"); // marketing watches final,failed only
  assert.equal(routed(c, { event: "thread.failed", turnState: "failed" }, info("SHORTS-1")), "marketing,all");
  assert.equal(routed(c, { event: "test", turnState: undefined, requestId: "test-1" }, info("t3listen test")), "dev,all");
});
test("subscribers: thread id and project rules (globs, project case-insensitive)", () => {
  const c = l.configFrom({ subscribers: [{ name: "p", url: "https://e.invalid/1", match: { include: { project: ["water*"], threadId: ["thread:special:*"] } } }] });
  assert.equal(routed(c, {}, info("x", null, { project: "Waterfall" })), "p");
  assert.equal(routed(c, {}, info("x", null, { project: "Other" })), "");
  assert.equal(routed(c, {}, info("x", null, { threadId: "thread:special:42" })), "p");
});
test("subscribers: delegated sub-task policy (failed default, all, none) and parent matching", () => {
  const c = l.configFrom(SUBS), par = { threadId: "p-1", title: "SHORTS-7 render", branch: "t3/shorts-7", project: null };
  const kid = (ev, st) => routed(c, { event: ev, turnState: st, threadId: "thread:delegated-task:k" }, info("Child step", null, { delegated: true, threadId: "thread:delegated-task:k", parent: par }));
  assert.equal(kid("thread.finished", "final"), "all"); // dev: only failures; marketing: none; all: every event
  assert.equal(kid("thread.failed", "failed"), "all"); // dev is matched by the SHORTS- parent and excludes it
  const devParent = { ...par, title: "Physics refactor", branch: "t3/physics" };
  assert.equal(routed(c, { event: "thread.failed", turnState: "failed" }, info("Child", null, { delegated: true, parent: devParent })), "dev,all");
  const self = l.configFrom({ subscribers: [{ name: "s", url: "https://e.invalid/1", delegated: "all", delegatedMatch: "self", match: { include: { titlePrefix: ["Child"] } } }] });
  assert.equal(routed(self, {}, info("Child step", null, { delegated: true, parent: devParent })), "s");
});
test("subscribers: bad configs fail with BAD_LISTEN_CONFIG", () => {
  for (const [bad, re] of [
    [{ subscribers: {} }, /must be an array/], [{ subscribers: [{ url: "https://e.invalid" }] }, /needs a "name"/],
    [{ subscribers: [{ name: "a", url: "https://e.invalid" }, { name: "a", url: "https://e.invalid" }] }, /two subscribers are named "a"/],
    [{ subscribers: [{ name: "a", url: "https://e.invalid", match: { include: { title: ["x"] } } }] }, /unknown rule "title"/],
    [{ subscribers: [{ name: "a", url: "https://e.invalid", match: { include: { titleRegex: ["("] } } }] }, /bad titleRegex/],
    [{ subscribers: [{ name: "a", url: "https://e.invalid", delegated: "some" }] }, /delegated must be one of/],
    [{ subscribers: [{ name: "a", url: "https://e.invalid", watch: "final,nope" }] }, /watch must be/],
    [{ subscribers: [{ name: "a", url: "ftp://e.invalid" }] }, /subscriber "a" url must start with https/],
  ]) assert.throws(() => l.configFrom(bad), re);
  assert.equal(l.configFrom({ subscribers: [] }).watch.length, 0); // empty list: nothing is sent
});
test("subscribers CLI: subscribe/unsubscribe/subscribers/route/test never print URLs or header values; test reaches each hook", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-subs-")), self = path.join(tmp, "t3listen");
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), self);
  const got = []; const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end("ok"); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`, devUrl = `${base}/dev-hook-SECRETPATH1`, mktUrl = `${base}/mkt-hook-SECRETPATH2`;
  fs.writeFileSync(path.join(tmp, "listen.json"), JSON.stringify({ url: devUrl, headers: { Authorization: "Bearer devtokenvalue123" }, machine: "m", skipStaleMinutes: 1440 }));
  fs.writeFileSync(path.join(tmp, "mkt.txt"), `${mktUrl}\nAuthorization: Bearer mkttokenvalue456\n`);
  const run = (...a) => new Promise((done) => execFile(process.execPath, [self, ...a], (err, out, errOut) => done({ code: err ? err.code : 0, out: out + errOut })));
  const all = [];
  const r1 = await run("subscribe", "dev", "--from-current", "--exclude-title-prefix", "SHORTS-", "--exclude-title-regex", "\\b(trailer|clip)s?\\b", "--exclude-branch", "t3/shorts-*", "--exclude-branch", "t3/trailer-*"); all.push(r1);
  assert.equal(r1.code, 0, r1.out);
  let conf = JSON.parse(fs.readFileSync(path.join(tmp, "listen.json"), "utf8"));
  assert.equal(conf.url, undefined); assert.equal(conf.subscribers[0].url, devUrl); assert.deepEqual(conf.subscribers[0].match.exclude.branch, ["t3/shorts-*", "t3/trailer-*"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(tmp, "listen.json")).mode & 0o777, 0o600);
  const r2 = await run("subscribe", "marketing", "--url-file", path.join(tmp, "mkt.txt"), "--include-title-prefix", "SHORTS-", "--include-branch", "t3/shorts-*", "--watch", "final,failed"); all.push(r2);
  assert.equal(r2.code, 0, r2.out);
  conf = JSON.parse(fs.readFileSync(path.join(tmp, "listen.json"), "utf8"));
  assert.deepEqual(conf.subscribers.map((x) => x.name), ["dev", "marketing"]); assert.equal(conf.subscribers[1].headers.Authorization, "Bearer mkttokenvalue456");
  const r3 = await run("subscribers"); all.push(r3);
  assert.match(r3.out, /dev: url set, 1 header\(s\)/); assert.match(r3.out, /marketing: .*watch final,failed/); assert.match(r3.out, /include: titlePrefix \["SHORTS-"\]/);
  const r4 = await run("route", "--title", "SHORTS-3 edit"); all.push(r4); assert.match(r4.out, /final: marketing$/m);
  const r5 = await run("route", "--title", "Water solver", "--branch", "t3/water"); all.push(r5); assert.match(r5.out, /final: dev$/m);
  const r6 = await run("test"); all.push(r6); srv.close();
  assert.equal(r6.code, 0, r6.out); assert.match(r6.out, /OK dev/); assert.match(r6.out, /OK marketing/);
  assert.deepEqual(got.map((g) => [g.url.slice(1, 4), g.auth.split(" ")[1].slice(0, 3), g.body.subscriber, g.body.test]), [["dev", "dev", "dev", true], ["mkt", "mkt", "marketing", true]]);
  const r7 = await run("unsubscribe", "marketing"); all.push(r7); assert.match(r7.out, /left: dev/);
  const r8 = await run("subscribe", "x"); all.push(r8); assert.notEqual(r8.code, 0); assert.match(r8.out, /needs --url-file/);
  for (const r of all) for (const bad of ["SECRETPATH", "devtokenvalue", "mkttokenvalue", "127.0.0.1"]) assert.ok(!r.out.includes(bad), `${bad} printed: ${r.out}`);
});
test("subscribers: first subscribe on a single-webhook config keeps that webhook as \"default\"", async () => {
  const fs = require("fs"), os = require("os"), { execFileSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-subs-")), self = path.join(tmp, "t3listen");
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), self);
  fs.writeFileSync(path.join(tmp, "listen.json"), JSON.stringify({ url: "https://example.invalid/old", headers: {}, watch: ["final"] }));
  fs.writeFileSync(path.join(tmp, "new.json"), JSON.stringify({ url: "https://example.invalid/new", headers: { "X-Key": "abcdefgh12345" } }));
  const out = execFileSync(process.execPath, [self, "subscribe", "new", "--url-file", path.join(tmp, "new.json"), "--include-thread", "thread:x:*"]).toString();
  assert.match(out, /subscriber "default"/); assert.ok(!out.includes("example.invalid") && !out.includes("abcdefgh"));
  const c = JSON.parse(fs.readFileSync(path.join(tmp, "listen.json"), "utf8"));
  assert.deepEqual(c.subscribers.map((x) => [x.name, x.url]), [["default", "https://example.invalid/old"], ["new", "https://example.invalid/new"]]);
  assert.deepEqual(c.watch, ["final"]); assert.equal(l.configFrom(c).subscribers[0].watch.join(), "final");
});
test("subscribers CLI: --key-file sends the key as Authorization: Bearer, never printed", () => {
  const fs = require("fs"), os = require("os"), { execFileSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-subs-")), self = path.join(tmp, "t3listen");
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), self);
  fs.writeFileSync(path.join(tmp, "listen.json"), JSON.stringify({ subscribers: [] }));
  fs.writeFileSync(path.join(tmp, "u.txt"), "https://example.invalid/hookpath\n"); fs.writeFileSync(path.join(tmp, "k.txt"), "rawkeyvalue987654321\n");
  const out = execFileSync(process.execPath, [self, "subscribe", "m", "--url-file", path.join(tmp, "u.txt"), "--key-file", path.join(tmp, "k.txt")]).toString();
  assert.ok(!/hookpath|rawkeyvalue/.test(out), out); assert.match(out, /1 header\(s\)/);
  const c = JSON.parse(fs.readFileSync(path.join(tmp, "listen.json"), "utf8"));
  assert.deepEqual(c.subscribers[0].headers, { Authorization: "Bearer rawkeyvalue987654321" });
  execFileSync(process.execPath, [self, "subscribe", "m", "--key-file", path.join(tmp, "k.txt"), "--key-header", "X-Key"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "listen.json"), "utf8")).subscribers[0].headers["X-Key"], "rawkeyvalue987654321");
});
