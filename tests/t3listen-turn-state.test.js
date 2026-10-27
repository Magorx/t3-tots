// Recorded shapes from T3's shell/projection contracts; no live T3 or webhook access.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
const l = require("../tools/t3listen");
const parent = { id: "parent-thread", title: "Parent", status: "idle", latestRunId: "r1", pendingBackgroundTasks: [] };
const child = { id: "thread:delegated-task:child", title: "Child", status: "running", activeRunId: "c1", lineage: { parentThreadId: parent.id } };
const ended = (id = "r1", ordinal = 1) => ({ id, ordinal, status: "completed", startedAt: "2026-10-28T10:00:00Z", completedAt: "2026-10-28T10:01:00Z" });
const projection = (t = parent, runs = [ended()]) => ({ thread: t, runs, runtimeRequests: [], subagents: [], turnItems: [] });

function listener(watch = l.watchList(), saved) {
  let threads = [], projections = {}, hits = [], logs = [];
  const context = vm.createContext({
    require: (name) => name === "fs" ? { readFileSync() { throw new Error("no fixture file"); } } : require(name),
    __dirname, module: { exports: {} }, process: { argv: ["node", "t3listen", "--dry-run"], env: {} },
    console: { log: (line) => logs.push(line) }, setInterval: () => ({ unref() {} }), setTimeout,
    fetch: async (url, opts) => {
      assert.ok(!opts.method || opts.method === "GET", "dry-run must never POST or dispatch"); hits.push(url);
      if (url.endsWith("/shell")) return { ok: true, json: async () => ({ threads, projects: [] }) };
      const id = decodeURIComponent(url.split("/").at(-1)), p = projections[id];
      return { ok: !!p, status: p ? 200 : 404, json: async () => ({ projection: p }) };
    },
  });
  vm.runInContext(source + `\nglobalThis.h = { onItem, reportEnd, checkDeferred, seed(c, s) { C = c; if (s) S = s; }, state() { return S; } };`, context);
  context.h.seed({ machine: "fixture", approvals: true, skipStaleMinutes: 0, watch }, saved && JSON.parse(JSON.stringify(saved)));
  return {
    set(ts, ps) { threads = structuredClone(ts); projections = structuredClone(ps); },
    item: (v, full = false) => context.h.onItem({ base: "http://fixture", H: {} }, v, full),
    snapshot: () => context.h.onItem({ base: "http://fixture", H: {} }, { kind: "snapshot", snapshot: { threads, projects: [] } }, true),
    end: (t, id, opts) => context.h.reportEnd({ base: "http://fixture", H: {} }, t, id, opts),
    state: () => JSON.parse(JSON.stringify(context.h.state())),
    events: () => logs.filter((s) => s.includes("DRY-RUN payload ")).map((s) => JSON.parse(s.split("DRY-RUN payload ")[1])), hits,
  };
}

test("turnDetails: final, user requests/plans, queued runs, delegated and native subtasks", () => {
  const p = projection();
  assert.deepEqual(l.turnDetails(parent, p, []), { turnState: "final", turnHint: { runningSubtasks: 0, queued: 0, pending: 0, waitingCommand: null } });
  assert.equal(l.turnDetails(parent, p, [child]).turnState, "waiting-subagents");
  const linked = { ...parent, pendingBackgroundTasks: [{ kind: "subagent", taskId: "task1", childThreadId: child.id }] };
  assert.equal(l.turnDetails(linked, { ...p, subagents: [{ id: "task1", childThreadId: child.id, status: "running" }] }, [child]).turnHint.runningSubtasks, 1);
  assert.equal(l.turnDetails(parent, { ...p, subagents: [{ id: "native", status: "running" }] }, []).turnState, "waiting-subagents");
  assert.equal(l.turnDetails({ ...parent, hasActionableProposedPlan: true }, p, []).turnState, "waiting-user");
  assert.equal(l.turnDetails(parent, { ...p, runtimeRequests: [{ kind: "user_input", status: "pending" }] }, []).turnHint.pending, 1);
  assert.equal(l.turnDetails(parent, { ...p, runs: [...p.runs, { id: "q", status: "queued", queueHeld: true }] }, []).turnState, null);
  for (const [event, state] of [["thread.failed", "failed"], ["thread.cancelled", "cancelled"]]) assert.equal(l.turnDetails(parent, p, [child], event).turnState, state);
});

test("turnDetails: awaited commands hold completion; servers and limit autoResume do not", () => {
  const task = { taskId: "cmd", kind: "command", description: "Run tests" };
  const t = { ...parent, pendingBackgroundTasks: [task], limitRecovery: { autoResume: true } };
  assert.equal(l.turnDetails(t, projection(), []).turnState, "final");
  const details = l.turnDetails({ ...t, pendingBackgroundTasks: [{ ...task, awaited: true }] }, projection(), []);
  assert.equal(details.turnState, "waiting-command"); assert.equal(details.turnHint.waitingCommand, "Run tests");
  assert.equal(l.turnDetails({ ...t, pendingBackgroundTasks: [{ ...task, kind: "monitor", awaited: true }] }, projection(), []).turnState, "waiting-command");
  assert.equal(l.turnDetails({ ...t, pendingBackgroundTasks: [{ taskId: "bg", kind: "background_task" }] }, projection(), []).turnState, "waiting-command");
  assert.equal(l.turnDetails({ id: parent.id }, { providerThreads: [{ id: "old", pendingBackgroundTasks: [{ ...task, awaited: true }] }], thread: { activeProviderThreadId: "new" } }, []).turnState, "final");
});

test("dry-run: filtered parent turn, child completion races with follow-up, exactly one last-turn event", async () => {
  const h = listener(), running = { ...parent, status: "running", activeRunId: "r1" };
  h.set([running, child], { [parent.id]: projection(running) }); await h.snapshot();
  h.set([parent, child], { [parent.id]: projection() }); await h.item({ kind: "thread.updated", thread: parent });
  assert.equal(h.events().length, 0); assert.equal(h.state().deferred[parent.id].runId, "r1"); assert.equal(h.state().finished.r1, undefined);
  // The child has ended, but its result handoff has not queued the parent's follow-up yet.
  const doneChild = { ...child, status: "idle", activeRunId: null };
  const handingOff = { ...projection(), subagents: [{ id: "task", origin: "app_owned", runId: "r1", childThreadId: child.id, status: "completed", completionDelivery: { state: "pending", observedByRunId: null } }] };
  h.set([parent, doneChild], { [parent.id]: handingOff, [child.id]: projection(doneChild, [ended("c1")]) });
  await h.item({ kind: "thread.updated", thread: doneChild }); assert.equal(h.events().length, 0);
  // The live shell already knows the queued follow-up, before its stream update arrives.
  const next = { ...parent, status: "running", activeRunId: "r2", latestRunId: "r2" };
  h.set([next, doneChild], { [parent.id]: projection(next, [ended(), { id: "r2", ordinal: 2, status: "running", startedAt: ended().startedAt }]), [child.id]: projection(doneChild, [ended("c1")]) });
  await h.item({ kind: "thread.updated", thread: doneChild }); assert.equal(h.events().length, 0);
  await h.item({ kind: "thread.updated", thread: next });
  const final = { ...parent, latestRunId: "r2" };
  h.set([final, doneChild], { [parent.id]: projection(final, [ended(), ended("r2", 2)]) });
  await h.item({ kind: "thread.updated", thread: final }); await h.item({ kind: "thread.updated", thread: final });
  assert.deepEqual(h.events().map((e) => [e.event, e.runId, e.turnState]), [["thread.finished", "r2", "final"]]);
});

test("dry-run: deferred same-run final survives reconnect/restart and opt-in interim notifications", async () => {
  for (const watch of [l.watchList(), [...l.watchList(), "waiting-subagents"]]) {
    const h = listener(watch); h.set([parent, child], { [parent.id]: projection() });
    await h.end(parent, "r1"); await h.end(parent, "r1");
    assert.equal(h.events().length, watch.includes("waiting-subagents") ? 1 : 0);
    const restored = listener(watch, h.state());
    restored.set([parent], { [parent.id]: projection() }); await restored.snapshot(); await restored.snapshot();
    assert.deepEqual(restored.events().map((e) => e.turnState), ["final"]);
    assert.equal(restored.state().deferred[parent.id], undefined);
    if (h.events().length) assert.notEqual(h.events()[0].eventId, restored.events()[0].eventId);
  }
});

test("dry-run: queued/held messages suppress final; catch-up reports only the latest successful turn", async () => {
  const h = listener(), p = projection(parent, [ended(), ended("r2", 2), { id: "q", status: "queued", queueHeld: true }]);
  h.set([parent], { [parent.id]: p }); await h.end(parent, "r1"); assert.equal(h.events().length, 0);
  const t = { ...parent, latestRunId: "r2" }; p.runs.pop(); p.thread = t;
  h.set([t], { [parent.id]: p }); await h.end(t, null, { since: 1 }); await h.end(t, null, { since: 1 });
  assert.deepEqual(h.events().map((e) => e.runId), ["r2"]);
});

test("dry-run: a follow-up that starts and ends between shell updates still reports final", async () => {
  const h = listener(); h.set([parent, child], { [parent.id]: projection() }); await h.snapshot(); await h.end(parent, "r1");
  const final = { ...parent, latestRunId: "r2" };
  h.set([final], { [parent.id]: projection(final, [ended(), ended("r2", 2)]) });
  await h.item({ kind: "thread.updated", thread: final }); await h.item({ kind: "thread.updated", thread: final });
  assert.deepEqual(h.events().map((e) => [e.runId, e.turnState]), [["r2", "final"]]);
});

test("dry-run: failed/cancelled keep their names, approvals remain gated by waiting-user", async () => {
  const h = listener();
  for (const [status, event] of [["failed", "thread.failed"], ["cancelled", "thread.cancelled"]]) {
    const t = { ...parent, latestRunId: status }, p = projection(t, [{ ...ended(status), status }]);
    h.set([t], { [parent.id]: p }); await h.end(t, status);
    assert.equal(h.events().at(-1).event, event); assert.equal(h.events().at(-1).turnState, status);
  }
  const q = listener(["final"]), request = { id: "approval", kind: "command", status: "pending", createdAt: ended().completedAt };
  const t = { ...parent, pendingRuntimeRequest: request };
  q.set([t], { [parent.id]: { ...projection(t), runtimeRequests: [request] } }); await q.snapshot(); await q.end(t, "r1");
  assert.equal(q.events().length, 0);
});

test("dry-run: command wait clears on parent update; requests retain their opened/resolved paths", async () => {
  const h = listener(), t = { ...parent, pendingBackgroundTasks: [{ taskId: "c", kind: "command", awaited: true, description: "Run tests" }] };
  h.set([t], { [parent.id]: projection(t) }); await h.end(t, "r1"); assert.equal(h.events().length, 0);
  h.set([parent], { [parent.id]: projection() }); await h.item({ kind: "thread.updated", thread: parent });
  assert.equal(h.events()[0].turnState, "final");
  const q = listener(), request = { id: "question", kind: "user_input", status: "pending", createdAt: ended().completedAt };
  const waiting = { ...parent, pendingRuntimeRequest: request }, p = { ...projection(waiting), runtimeRequests: [request] };
  q.set([waiting], { [parent.id]: p }); await q.snapshot(); await q.end(waiting, "r1");
  assert.deepEqual(q.events().map((e) => [e.event, e.turnState]), [["request.opened", "waiting-user"]]);
  p.runtimeRequests[0].status = "resolved"; q.set([parent], { [parent.id]: p }); await q.item({ kind: "thread.updated", thread: parent });
  assert.ok(q.events().some((e) => e.event === "request.resolved" && e.turnState === "waiting-user"));
});

test("watch CLI: validates startup, preserves secret fields, prints only states, dry-run does not write", async () => {
  const os = require("os"), { execFileSync, spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-watch-")), script = path.join(dir, "t3listen"), conf = path.join(dir, "listen.json");
  fs.writeFileSync(script, source);
  const c = { url: "https://example.com/fixture-only", headers: { "X-Fixture": "private-fixture-value" }, approvals: true, extra: { keep: 1 } };
  const run = (...args) => execFileSync(process.execPath, [script, "watch", ...args], { encoding: "utf8" });
  try {
    fs.writeFileSync(conf, JSON.stringify(c)); assert.match(run(), /final,waiting-user,failed,cancelled/);
    const before = fs.readFileSync(conf, "utf8"); run("final,waiting-command", "--dry-run"); assert.equal(fs.readFileSync(conf, "utf8"), before);
    const out = run("final,waiting-subagents"); assert.ok(!out.includes(c.url)); assert.ok(!out.includes(c.headers["X-Fixture"]));
    assert.deepEqual(JSON.parse(fs.readFileSync(conf)), { ...c, watch: ["final", "waiting-subagents"] });
    if (process.platform !== "win32") assert.equal(fs.statSync(conf).mode & 0o777, 0o600);
    for (const watch of [["typo"], "final", null, ["final", "private-fixture-value"]]) {
      fs.writeFileSync(conf, JSON.stringify({ ...c, watch }));
      const r = spawnSync(process.execPath, [script, "--dry-run", "--once", "--timeout", "1"], { encoding: "utf8" });
      assert.equal(r.status, 1); assert.match(r.stderr, /BAD_LISTEN_CONFIG: watch/); assert.ok(!r.stderr.includes("private-fixture-value"));
    }
    fs.writeFileSync(conf, JSON.stringify(c)); const r = spawnSync(process.execPath, [script, "watch", "typo"], { encoding: "utf8" });
    assert.equal(r.status, 1); assert.deepEqual(JSON.parse(fs.readFileSync(conf)), c);
    run(""); assert.deepEqual(JSON.parse(fs.readFileSync(conf)).watch, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
