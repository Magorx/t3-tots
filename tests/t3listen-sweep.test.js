// No live T3 or installed tools: pure helpers, temporary script copies and a local fixture server only.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), { execFile } = require("node:child_process");
const source = path.join(__dirname, "..", "tools", "t3listen"), l = require(source);
const now = Date.parse("2026-10-28T12:00:00Z"), at = "2026-10-28T11:00:00.000Z";
const thread = (extra = {}) => ({ id: "thread-one-0001", title: "One", status: "idle", updatedAt: at, ...extra });
const projection = (extra = {}) => ({ runs: [], turnItems: [], runtimeRequests: [], ...extra });

test("sweep status: running shell and projection states, including starting/preparing", () => {
  for (const t of [{ activeRunId: "r" }, { status: "running" }, { status: "starting" }, { status: "preparing" }])
    assert.equal(l.sweepStatus(thread(t), projection(), now).status, "running");
  assert.equal(l.sweepStatus(thread(), projection({ runs: [{ id: "r", status: "running" }] }), now).status, "running");
  assert.equal(l.sweepStatus({}, projection({ thread: thread({ activeRunId: "r" }) }), now).status, "running");
});
test("sweep status: open questions and approvals take precedence over active runs and errors", () => {
  for (const kind of ["user_input", "command", "approval", "file_change"]) {
    const p = projection({ runtimeRequests: [{ id: "q", kind, status: "pending", responseCapability: { type: "not_resumable" } }] });
    assert.equal(l.sweepStatus(thread({ activeRunId: "r", lastError: { message: "old" } }), p, now).status, "waiting-user");
    assert.equal(l.sweepStatus(thread({ pendingRuntimeRequest: { id: "q", kind } }), projection(), now).status, "waiting-user");
  }
});
test("sweep status: skips the same request kinds as t3ctl and ignores resolved requests", () => {
  for (const kind of ["dynamic_tool_call", "auth_refresh"]) {
    const r = { id: "q", kind, status: "pending" };
    assert.equal(l.sweepStatus(thread({ pendingRuntimeRequest: r }), projection({ runtimeRequests: [r] }), now).status, "idle-finished");
  }
  for (const status of ["answered", "resolved", "cancelled", "expired", "dismissed"]) {
    const r = { id: "q", kind: "user_input", status };
    assert.equal(l.sweepStatus(thread({ pendingRuntimeRequest: r }), projection({ runtimeRequests: [r] }), now).status, "idle-finished");
  }
});
test("sweep status: failures and interruptions by error; a clean cancellation is idle", () => {
  for (const status of ["failed", "error"]) {
    assert.equal(l.sweepStatus(thread({ status }), projection(), now).status, "error");
    assert.equal(l.sweepStatus(thread(), projection({ runs: [{ id: "r", status }] }), now).status, "error");
  }
  for (const extra of [{ lastError: { message: "provider failed" } }, { error: "provider failed" }, { lastErrorClass: "server_error" }])
    assert.equal(l.sweepStatus(thread(), projection({ runs: [{ id: "r", status: "interrupted", ...extra }] }), now).status, "error");
  const runs = [{ id: "r", status: "interrupted" }];
  assert.equal(l.sweepStatus(thread(), projection({ runs, turnItems: [{ type: "error", runId: "r" }] }), now).status, "error");
  for (const status of ["interrupted", "cancelled", "completed"])
    assert.equal(l.sweepStatus(thread(), projection({ runs: [{ id: "r", status }] }), now).status, "idle-finished");
  assert.equal(l.sweepStatus(thread({ lastError: { message: "failed" } }), projection(), now).status, "error");
});
test("sweep status: historical failures do not mask a newer completed or running run", () => {
  const runs = [{ id: "new", ordinal: 2, status: "completed" }, { id: "old", ordinal: 1, status: "failed" }];
  assert.equal(l.sweepStatus(thread(), projection({ runs }), now).status, "idle-finished");
  assert.equal(l.sweepStatus(thread({ latestRunId: "old" }), projection({ runs }), now).status, "error");
  assert.equal(l.sweepStatus(thread({ activeRunId: "new" }), projection({ runs }), now).status, "running");
  assert.equal(l.sweepStatus(thread(), projection({ runs: [
    { id: "new", startedAt: at, status: "completed" }, { id: "old", startedAt: "2026-10-28T10:00:00Z", status: "failed" },
  ] }), now).status, "idle-finished");
});
test("sweep activity: latest shell, thread, run, message or request timestamp; invalid/missing dates", () => {
  const p = projection({ thread: { updatedAt: "2026-10-28T11:10:00Z" }, runs: [{ completedAt: "2026-10-28T11:20:00Z" }],
    turnItems: [{ updatedAt: "2026-10-28T11:30:00Z" }, { createdAt: "bad" }], runtimeRequests: [{ resolvedAt: "2026-10-28T11:40:00Z" }] });
  assert.deepEqual(l.sweepStatus(thread(), p, now), { status: "idle-finished", lastActivityAt: "2026-10-28T11:40:00.000Z", ageMin: 20 });
  assert.deepEqual(l.sweepStatus({}, projection(), now), { status: "idle-finished", lastActivityAt: null, ageMin: null });
  assert.equal(l.sweepStatus(thread({ updatedAt: "2026-10-28T13:00:00Z" }), projection(), now).ageMin, 0);
});
test("sweep verdict table: attention and running win over review/age; idle is stale only over N hours", () => {
  const cases = [
    [{ status: "error", reviewed: true, ageMin: 900 }, "needs-attention"],
    [{ status: "waiting-user", reviewed: true, ageMin: 900 }, "needs-attention"],
    [{ status: "running", reviewed: true, ageMin: 900 }, "running-ok"],
    [{ status: "idle-finished", reviewed: true, ageMin: 1 }, "stale"],
    [{ status: "idle-finished", reviewed: false, ageMin: 361 }, "stale"],
    [{ status: "idle-finished", reviewed: false, ageMin: 360 }, "finished-unreviewed"],
    [{ status: "idle-finished", reviewed: false, ageMin: null }, "finished-unreviewed"],
    [{ status: "running", settled: true }, "settled"], [{ gone: true }, "gone"],
  ];
  for (const [input, expected] of cases) assert.equal(l.sweepVerdict(input), expected, JSON.stringify(input));
  assert.equal(l.sweepVerdict({ status: "idle-finished", ageMin: 61 }, 1), "stale");
  assert.equal(l.sweepVerdict({ status: "idle-finished", ageMin: 61 }, 2), "finished-unreviewed");
});
test("sweep members: bot match, empty bot uses routing, explicit bot wins, out and routing-only excluded", () => {
  const shelf = { threads: { direct: { bot: "dev" }, fallback: { bot: "" }, unknown: {}, wrong: { bot: "marketing" }, out: { bot: "dev" } }, out: { out: {} } };
  const routing = { owners: { direct: "marketing", fallback: { owner: "dev" }, unknown: "dev", wrong: "dev", routingOnly: "dev" } };
  assert.deepEqual(l.sweepMembers(shelf, routing, "dev"), ["direct", "fallback", "unknown"]);
  assert.deepEqual(l.sweepMembers(shelf, routing, "marketing"), ["wrong"]);
  for (const bad of [null, [], {}, { threads: null }, { threads: [] }]) assert.deepEqual(l.sweepMembers(bad, routing, "dev"), []);
});
const report = (extra = {}, clock = now) => l.sweepReport({ owner: "dev", shelf: { threads: { "thread-one-0001": { bot: "dev" } } },
  snapshots: { "thread-one-0001": { t: thread(), p: projection() } }, ...extra }, clock);
test("sweep report: reviewed upTo covers activity; a newer turn invalidates it while retaining reviewedAt", () => {
  const reviewed = { threads: { "thread-one-0001": { at: "2026-10-28T11:30:00Z", by: "dev", upTo: at } } };
  let out = report({ reviewed }); assert.equal(out.threads[0].reviewed, true); assert.equal(out.threads[0].verdict, "stale");
  out = report({ reviewed, snapshots: { "thread-one-0001": { t: thread({ updatedAt: "2026-10-28T11:45:00Z" }), p: projection() } } });
  assert.equal(out.threads[0].reviewed, false); assert.equal(out.threads[0].reviewedAt, "2026-10-28T11:30:00Z");
  assert.equal(out.threads[0].verdict, "finished-unreviewed");
  out = report({ reviewed: { threads: { "thread-one-0001": { upTo: "bad" } } } }); assert.equal(out.threads[0].reviewed, false);
  assert.equal(report({}, now + 6 * 36e5).threads[0].verdict, "stale");
});
test("sweep report: settled skipped and counted, --all lists them, explicit unsettled wins", () => {
  for (const settled of [{ settledAt: at }, { settledOverride: "settled" }]) {
    const snapshots = { "thread-one-0001": { t: thread(settled), p: projection() } };
    assert.deepEqual(report({ snapshots }).threads, []); assert.deepEqual(report({ snapshots }).counts, { settled: 1 });
    assert.equal(report({ snapshots, all: true }).threads[0].verdict, "settled");
  }
  assert.equal(report({ snapshots: { "thread-one-0001": { t: thread({ settledAt: at, settledOverride: "unsettled" }), p: projection() } } }).threads.length, 1);
});
test("sweep report: gone has no invented activity or reviewed state; shape and count keys are verdicts", () => {
  const out = report({ snapshots: { "thread-one-0001": { p: null } } });
  assert.deepEqual(out, { owner: "dev", checkedAt: new Date(now).toISOString(), hours: 6, threads: [{ id: "thread-one-0001", title: "thread-one-0001",
    status: null, lastActivityAt: null, ageMin: null, reviewed: false, reviewedAt: null, verdict: "gone" }], counts: { gone: 1 } });
  assert.deepEqual(report({ shelf: {} }).counts, {});
});
test("Grok path: override, default base, T3CODE_HOME base or userdata; ignores T3_HOME", () => {
  const home = path.resolve(os.tmpdir(), "fake-home"), base = path.join(home, "custom");
  assert.equal(l.grokFile({}, home), path.join(home, ".t3", "custom-t3", "grok-shelf.json"));
  for (const root of [base, path.join(base, "userdata"), path.join(base, "userdata") + path.sep])
    assert.equal(l.grokFile({ T3CODE_HOME: root }, home), path.join(base, "custom-t3", "grok-shelf.json"));
  assert.equal(l.grokFile({ T3_HOME: base }, home), l.grokFile({}, home));
  assert.equal(l.grokFile({ T3_CUSTOM_GROK_FILE: "explicit.json" }, home), "explicit.json");
});

function temporary(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-sweep-")), self = path.join(tmp, "t3listen"), runtime = path.join(tmp, "runtime");
  fs.copyFileSync(source, self); fs.mkdirSync(runtime); fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const env = { ...process.env, T3_HOME: runtime, T3CODE_HOME: runtime, T3_CUSTOM_GROK_FILE: path.join(tmp, "grok-shelf.json") };
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [self, ...args], { env },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr })));
  return { tmp, self, runtime, env, run };
}
async function fixture(t) {
  const f = temporary(t), hits = [], state = { shell: { threads: [thread()], archivedThreads: [] }, projections: { "thread-one-0001": projection({ thread: thread() }) } };
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url); hits.push(`${req.method} ${url}`); res.setHeader("Content-Type", "application/json");
    if (url === "/api/orchestration/shell") { res.statusCode = state.shellCode || 200; return res.end(JSON.stringify(state.shell)); }
    const p = state.projections[url.slice("/api/orchestration/threads/".length)];
    res.statusCode = state.threadCode || (p ? 200 : 404); res.end(JSON.stringify({ projection: p }));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  fs.writeFileSync(path.join(f.runtime, "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const shelf = { version: 1, threads: { "thread-one-0001": { bot: "dev" } }, out: {} };
  fs.writeFileSync(f.env.T3_CUSTOM_GROK_FILE, JSON.stringify(shelf));
  return { ...f, hits, state, shelf };
}
test("reviewed file: write/replace/undo preserves other marks, uses atomic private files and releases lock on bad JSON", (t) => {
  const f = temporary(t), lt = require(f.self), file = path.join(f.tmp, "reviewed.json");
  assert.equal(lt.markReviewed("one", { by: "dev", upTo: at, now }), true);
  lt.markReviewed("two", { by: "marketing", upTo: at, now }); lt.markReviewed("one", { by: "dev2", upTo: at, now: now + 1000 });
  let doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(doc, { version: 1, threads: { one: { at: new Date(now + 1000).toISOString(), by: "dev2", upTo: at },
    two: { at: new Date(now).toISOString(), by: "marketing", upTo: at } } });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(lt.markReviewed("one", { undo: true }), true); assert.equal(lt.markReviewed("one", { undo: true }), false);
  doc = JSON.parse(fs.readFileSync(file, "utf8")); assert.deepEqual(Object.keys(doc.threads), ["two"]);
  assert.throws(() => lt.markReviewed("bad", { upTo: "invalid" }), /NO_ACTIVITY/);
  fs.writeFileSync(file, "{broken"); assert.throws(() => lt.markReviewed("two", { undo: true }), /BAD_REVIEWED/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  assert.ok(!fs.readdirSync(f.tmp).some((name) => name.endsWith(".lock") || name.endsWith(".part")));
});
test("reviewed CLI: title resolution, --by, snapshot activity, undo and no listener config", async (t) => {
  const f = await fixture(t), file = path.join(f.tmp, "reviewed.json");
  f.state.projections[thread().id].turnItems.push({ type: "assistant_message", createdAt: "2026-10-28T11:45:00Z" });
  let r = await f.run("reviewed", "One", "--by", "dev"); assert.equal(r.code, 0, r.out);
  const mark = JSON.parse(fs.readFileSync(file, "utf8")).threads[thread().id];
  assert.equal(mark.by, "dev"); assert.equal(mark.upTo, "2026-10-28T11:45:00.000Z"); assert.ok(Number.isFinite(Date.parse(mark.at)));
  r = await f.run("reviewed", thread().id, "--undo"); assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).threads, {});
  r = await f.run("reviewed", "missing-id-999"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).threads, {});
  assert.ok(f.hits.every((h) => h.startsWith("GET ")));
});
test("reviewed CLI: unavailable T3 refuses a mark; exact undo works offline", async (t) => {
  const f = temporary(t), file = path.join(f.tmp, "reviewed.json");
  let r = await f.run("reviewed", thread().id); assert.equal(r.code, 1); assert.match(r.out, /T3_NOT_REACHABLE/); assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, threads: { [thread().id]: { at, by: "dev", upTo: at } } }));
  r = await f.run("reviewed", thread().id, "--undo", "--exact"); assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).threads, {});
});
test("sweep CLI: one JSON object, routing fallback, settled counts/--all, hidden snapshot and gone; never writes even with --log", async (t) => {
  const f = await fixture(t), shelf = f.shelf;
  shelf.threads.settled = { bot: "dev" }; shelf.threads.gone = { bot: "dev" }; shelf.threads.hidden = { bot: "" };
  shelf.threads.other = { bot: "marketing" }; shelf.threads.out = { bot: "dev" }; shelf.out.out = {};
  fs.writeFileSync(f.env.T3_CUSTOM_GROK_FILE, JSON.stringify(shelf));
  fs.writeFileSync(path.join(f.tmp, "routing.json"), JSON.stringify({ owners: { hidden: "dev", other: "dev", routingOnly: "dev" } }));
  f.state.shell.archivedThreads.push(thread({ id: "settled", title: "Settled", settledAt: at }));
  f.state.projections.settled = projection({ thread: f.state.shell.archivedThreads[0] });
  f.state.projections.hidden = projection({ thread: thread({ id: "hidden", title: "Hidden", status: "running" }) });
  // Reject every filesystem mutation, plus config reads: this also catches locks/part files that get removed afterwards.
  const guard = path.join(f.tmp, "readonly.cjs");
  fs.writeFileSync(guard, `const fs = require("node:fs");
for (const key of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "chmodSync", "unlinkSync", "rmSync", "rmdirSync", "truncateSync", "writeSync"]) fs[key] = () => { throw new Error("UNEXPECTED_WRITE " + key); };
const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith("listen.json")) throw new Error("UNEXPECTED_CONFIG_READ"); return read.call(this, file, ...args); };
`);
  f.env.NODE_OPTIONS = `--require=${guard}`;
  const before = fs.readdirSync(f.tmp).sort();
  let r = await f.run("sweep", "--owner", "dev", "--json", "--log"); assert.equal(r.code, 0, r.out); assert.equal(r.stderr, "");
  let out = JSON.parse(r.stdout); assert.equal(out.owner, "dev"); assert.equal(out.hours, 6); assert.ok(Number.isFinite(Date.parse(out.checkedAt)));
  assert.deepEqual(out.threads.map((x) => x.id), [thread().id, "gone", "hidden"]);
  assert.equal(out.threads.find((x) => x.id === "gone").verdict, "gone");
  assert.equal(out.threads.find((x) => x.id === "hidden").verdict, "running-ok"); assert.equal(out.counts.settled, 1);
  r = await f.run("sweep", "--owner=dev", "--hours=1000000", "--all", "--json"); assert.equal(r.code, 0, r.out);
  out = JSON.parse(r.stdout); assert.equal(out.threads.find((x) => x.id === "settled").verdict, "settled"); assert.equal(out.hours, 1000000);
  r = await f.run("sweep", "--owner", "dev"); assert.equal(r.code, 0, r.out); assert.match(r.out, /counts: .*settled=1/);
  assert.deepEqual(fs.readdirSync(f.tmp).sort(), before);
  assert.ok(f.hits.every((h) => h.startsWith("GET "))); assert.ok(!f.hits.some((h) => /other|routingOnly|\/out$/.test(h)));
});
test("sweep CLI: missing/broken shelf and reviewed files are tolerated without repair writes", async (t) => {
  const f = await fixture(t);
  for (const value of [null, "{broken", "null", "[]", '{"threads":[]}']) {
    if (value === null) fs.unlinkSync(f.env.T3_CUSTOM_GROK_FILE); else fs.writeFileSync(f.env.T3_CUSTOM_GROK_FILE, value);
    const r = await f.run("sweep", "--owner", "dev", "--json"); assert.equal(r.code, 0, r.out); assert.deepEqual(JSON.parse(r.stdout).threads, []);
    assert.ok(!fs.existsSync(path.join(f.tmp, "reviewed.json")));
  }
  fs.writeFileSync(f.env.T3_CUSTOM_GROK_FILE, JSON.stringify(f.shelf)); fs.writeFileSync(path.join(f.tmp, "reviewed.json"), "broken");
  const r = await f.run("sweep", "--owner", "dev", "--json"); assert.equal(r.code, 0, r.out); assert.equal(JSON.parse(r.stdout).threads[0].reviewed, false);
  assert.equal(fs.readFileSync(path.join(f.tmp, "reviewed.json"), "utf8"), "broken");
});
test("sweep CLI: unreachable runtime/shell/snapshot use T3_NOT_REACHABLE, never misreport gone", async (t) => {
  const offline = temporary(t); let r = await offline.run("sweep", "--owner", "dev", "--json");
  assert.equal(r.code, 1); assert.match(r.out, /T3_NOT_REACHABLE/); assert.equal(r.stdout, "");
  const f = await fixture(t); f.state.shellCode = 503;
  r = await f.run("sweep", "--owner", "dev", "--json"); assert.equal(r.code, 1); assert.match(r.out, /T3_NOT_REACHABLE/);
  f.state.shellCode = 200; f.state.threadCode = 503;
  r = await f.run("sweep", "--owner", "dev", "--json"); assert.equal(r.code, 1); assert.match(r.out, /T3_NOT_REACHABLE/); assert.equal(r.stdout, "");
});
test("sweep/reviewed CLI: required arguments and invalid hour values fail before any connection or write", async (t) => {
  const f = temporary(t);
  for (const args of [["sweep"], ["sweep", "--owner"], ["sweep", "--owner", "dev", "--hours"], ["sweep", "--owner", "dev", "--hours="],
    ["sweep", "--owner", "dev", "--hours", "NaN"], ["sweep", "--owner", "dev", "--hours=-1"], ["reviewed"], ["reviewed", thread().id, "--by"]]) {
    const r = await f.run(...args); assert.equal(r.code, 1, args.join(" ")); assert.match(r.out, /USAGE/);
  }
  assert.ok(!fs.existsSync(path.join(f.tmp, "reviewed.json")));
});
