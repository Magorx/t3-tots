// Grok shelf helpers and commands, isolated from live T3 and the user's tools folder.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const ctl = path.join(__dirname, "..", "tools", "t3ctl"), t = require(ctl), source = fs.readFileSync(ctl, "utf8");
function fixture(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3ctl-grok-")), file = path.join(dir, "custom-t3", "grok-shelf.json");
  const prev = process.env.T3_CUSTOM_GROK_FILE; process.env.T3_CUSTOM_GROK_FILE = file;
  ctx.after(() => { if (prev === undefined) delete process.env.T3_CUSTOM_GROK_FILE; else process.env.T3_CUSTOM_GROK_FILE = prev; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file };
}
function put(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const th = { id: "thread-one", title: "One", projectId: "project-one", settledAt: null, settledOverride: "unsettled" };
// Run the real CLI branches with API/claim functions replaced inside the module's VM.
// init never runs, no credential file is opened, and no network request can escape.
async function run(f, argv, options = {}) {
  const logs = [], errors = [], sent = [], claims = [], env = { T3_CUSTOM_GROK_FILE: f.file, ...options.env };
  const io = { ready: options.ready !== false, shell: { projects: [{ id: "project-one", title: "Project", workspaceRoot: f.dir, defaultModelSelection: { instanceId: "codex", model: "test" } }], threads: [th, ...(options.threads || [])] },
    sent, claims, failClaim: options.failClaim, claimHook: options.claimHook };
  const ctx = vm.createContext({ require, module: { exports: {} }, __dirname: f.dir, process: { argv: [process.execPath, ctl, ...argv], env, exit: (code) => { throw new Error(`exit ${code}`); } },
    console: { log: (s) => logs.push(String(s)), error: (s) => errors.push(String(s)) }, io, Buffer, SharedArrayBuffer, Int32Array, Atomics });
  vm.runInContext(source + `
    init = () => io.ready;
    get = async (p) => { if (!io.ready) throw new Error("offline"); return p === "/api/orchestration/shell" ? io.shell : { projection: { runs: [] } }; };
    rpc = async (tag, payload) => { io.sent.push({ tag, payload }); return { threadId: "created-thread" }; };
    claimOwner = (id, o, by) => { io.claims.push({ id, owner: ownerOf(o), by }); if (io.claimHook) io.claimHook(id); return !io.failClaim; };
    module.exports.main = main;`, ctx, { filename: ctl });
  let error = null; try { await ctx.module.exports.main(); } catch (e) { error = e; }
  return { logs, errors, sent, claims, error };
}

test("grokPath: default base, T3CODE_HOME base/userdata, override, and no T3_HOME influence", () => {
  const home = path.join(os.tmpdir(), "grok-home"), base = path.join(home, "custom");
  assert.equal(t.grokPath({}, home), path.join(home, ".t3", "custom-t3", "grok-shelf.json"));
  for (const value of [base, path.join(base, "userdata"), path.join(base, "userdata") + path.sep])
    assert.equal(t.grokPath({ T3CODE_HOME: value, T3_HOME: "/ignored" }, home), path.join(base, "custom-t3", "grok-shelf.json"));
  assert.equal(t.grokPath({ T3CODE_HOME: "~/custom/userdata" }, home), path.join(base, "custom-t3", "grok-shelf.json"));
  assert.equal(t.grokPath({ T3_HOME: base }, home), t.grokPath({}, home));
  assert.equal(t.grokPath({ T3_CUSTOM_GROK_FILE: "/override/shelf.json", T3CODE_HOME: base }, home), "/override/shelf.json");
});

test("readGrok: missing, broken, null and array files are empty; maps are normalized", (ctx) => {
  const { file } = fixture(ctx); assert.deepEqual(t.readGrok(), t.emptyGrok());
  for (const text of ["{broken", "null", "[]", '[{"threads":{}}]', "42"] ) { put(file, text); assert.deepEqual(t.readGrok(), t.emptyGrok()); }
  put(file, JSON.stringify({ threads: { a: { bot: "dev", title: "not stored", at: "now", by: "test" }, b: null }, out: [] }));
  assert.deepEqual(t.readGrok(), { version: 1, threads: { a: { bot: "dev", at: "now", by: "test" } }, out: {} });
});

test("grokLocked: creates directories, locks, writes .part and atomically renames with mode 0644", (ctx) => {
  const { file } = fixture(ctx); put(file, JSON.stringify(t.emptyGrok())); const old = fs.readFileSync(file, "utf8"); let renamed = false;
  const rename = fs.renameSync;
  ctx.mock.method(fs, "renameSync", (from, to) => {
    assert.equal(from, file + ".part"); assert.equal(to, file); assert.ok(fs.statSync(file + ".lock").isDirectory());
    assert.equal(fs.readFileSync(file, "utf8"), old); assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).threads.a.bot, "dev");
    renamed = true; return rename(from, to);
  });
  t.grokLocked((r) => { assert.ok(fs.existsSync(file + ".lock")); t.groupGrok(r, "a", "dev"); });
  assert.ok(renamed); assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.ok(!fs.existsSync(file + ".part")); assert.ok(!fs.existsSync(file + ".lock"));
});

test("grokLocked: strict refusal keeps broken/unreadable files byte-exact and releases its lock", (ctx) => {
  const { file } = fixture(ctx);
  for (const text of ["{broken", "[]", "null", '{"threads":[]}', '{"out":{"x":null}}']) {
    put(file, text); let called = false;
    assert.throws(() => t.grokLocked(() => { called = true; }), /^Error: BAD_GROK_FILE:/);
    assert.equal(called, false); assert.equal(fs.readFileSync(file, "utf8"), text); assert.ok(!fs.existsSync(file + ".lock")); assert.ok(!fs.existsSync(file + ".part"));
  }
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => t.grokLocked(() => assert.fail("must not mutate")), /BAD_GROK_FILE/);
  assert.ok(fs.statSync(file).isDirectory()); assert.ok(!fs.existsSync(file + ".lock"));
});

test("grokLocked: failed rename preserves the prior file and removes temporary state", (ctx) => {
  const { file } = fixture(ctx); put(file, JSON.stringify(t.emptyGrok())); const before = fs.readFileSync(file, "utf8");
  ctx.mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
  assert.throws(() => t.grokLocked((r) => t.groupGrok(r, "a", "dev")), /rename failed/);
  assert.equal(fs.readFileSync(file, "utf8"), before); assert.ok(!fs.existsSync(file + ".lock")); assert.ok(!fs.existsSync(file + ".part"));
});

test("grokLocked: waits for another writer, re-reads under lock and loses no members", async (ctx) => {
  const { file } = fixture(ctx);
  const child = spawn(process.execPath, ["-e", `const t = require(${JSON.stringify(ctl)}); t.grokLocked((r) => { t.groupGrok(r, "child", "dev"); console.log("locked"); require("node:fs").readSync(0, Buffer.alloc(1), 0, 1, null); });`],
    { env: { ...process.env, T3_CUSTOM_GROK_FILE: file }, stdio: ["pipe", "pipe", "pipe"] });
  ctx.after(() => child.kill()); const done = once(child, "exit");
  await once(child.stdout, "data"); assert.ok(fs.existsSync(file + ".lock")); child.stdin.end("x");
  t.grokLocked((r) => t.groupGrok(r, "parent", "marketing")); assert.equal((await done)[0], 0);
  assert.deepEqual(Object.keys(t.readGrok().threads).sort(), ["child", "parent"]); assert.ok(!fs.existsSync(file + ".lock"));
});

test("grokLocked: refuses a lock after 15 seconds without stealing it or dispatching the callback", (ctx) => {
  const { file } = fixture(ctx); fs.mkdirSync(file + ".lock", { recursive: true }); let now = 0;
  ctx.mock.method(Date, "now", () => now); ctx.mock.method(Atomics, "wait", () => { now += 1000; });
  assert.throws(() => t.grokLocked(() => assert.fail("locked callback")), /^Error: GROK_LOCKED:/);
  assert.equal(now, 15000); assert.ok(fs.existsSync(file + ".lock")); assert.ok(!fs.existsSync(file));
});

test("group/ungroup: explicit membership, out veto, regroup and safe special ids", (ctx) => {
  fixture(ctx); const at = "2026-10-28T00:00:00.000Z";
  t.grokLocked((r) => { t.groupGrok(r, "a", "dev", "t3ctl group", at); t.groupGrok(r, "__proto__", ""); });
  let r = t.readGrok(); assert.equal(t.grokMember(r, "a"), true); assert.equal(t.grokMember(r, "__proto__"), true); assert.equal(t.grokMember(r, "toString"), false);
  r.out.a = { at, by: "t3ctl ungroup" }; assert.equal(t.grokMember(r, "a"), false);
  t.grokLocked((r) => t.ungroupGrok(r, "a", at)); r = t.readGrok(); assert.ok(!Object.hasOwn(r.threads, "a")); assert.deepEqual(r.out.a, { at, by: "t3ctl ungroup" });
  t.grokLocked((r) => t.groupGrok(r, "a", "marketing", "t3ctl group", at)); r = t.readGrok(); assert.equal(t.grokMember(r, "a"), true); assert.ok(!Object.hasOwn(r.out, "a"));
  assert.deepEqual(r.threads.a, { bot: "marketing", at, by: "t3ctl group" });
});

test("grokGate: member, non-member, out veto, unknown owner, other bot and force decisions", () => {
  const r = t.emptyGrok(); t.groupGrok(r, "dev", "dev"); t.groupGrok(r, "unknown", ""); t.groupGrok(r, "out", "dev"); t.ungroupGrok(r, "out");
  assert.equal(t.grokGate(r, "dev", {}, {}), null); // no refusal when caller owner is unknown
  for (const id of ["dev", "unknown"]) assert.equal(t.grokGate(r, id, { owner: "dev" }, {}), null);
  for (const id of ["missing", "out"]) assert.equal(t.grokGate(r, id, {}, {}).code, "NOT_GROK");
  assert.equal(t.grokGate(r, "dev", { owner: "marketing" }, {}).code, "NOT_YOUR_THREAD");
  assert.equal(t.grokGate(r, "dev", {}, { T3_OWNER: "marketing" }).code, "NOT_YOUR_THREAD");
  assert.equal(t.grokGate(r, "dev", { owner: "dev" }, { T3_OWNER: "marketing" }), null);
  for (const id of ["dev", "missing", "out"]) assert.equal(t.grokGate(r, id, { owner: "marketing", force: true }, {}), null);
});

test("group and ungroup commands use explicit/env/routing/unknown owners and never dispatch", async (ctx) => {
  const f = fixture(ctx); put(path.join(f.dir, "routing.json"), JSON.stringify({ owners: { [th.id]: { owner: "route" } } }));
  const cases = [[{ env: { T3_OWNER: "env" } }, ["--owner", "explicit"], "explicit"], [{ env: { T3_OWNER: "env" } }, [], "env"], [{}, [], "route"]];
  for (const [options, args, owner] of cases) {
    const r = await run(f, ["group", "--thread", th.id, ...args], options); assert.equal(r.error, null); assert.equal(r.sent.length, 0); assert.equal(t.readGrok().threads[th.id].bot, owner);
  }
  fs.unlinkSync(path.join(f.dir, "routing.json")); let r = await run(f, ["group", "--thread", th.id]); assert.equal(r.error, null); assert.equal(t.readGrok().threads[th.id].bot, "");
  r = await run(f, ["ungroup", "--thread", th.id]); assert.equal(r.error, null); assert.equal(r.sent.length, 0); assert.equal(t.grokMember(t.readGrok(), th.id), false); assert.equal(t.readGrok().out[th.id].by, "t3ctl ungroup");
  r = await run(f, ["group", "--thread", th.id]); assert.equal(r.error, null); assert.equal(t.grokMember(t.readGrok(), th.id), true); assert.ok(!Object.hasOwn(t.readGrok().out, th.id));
});

test("grok lists only members, filters bots and enriches title/settled without writing", async (ctx) => {
  const f = fixture(ctx); t.grokLocked((r) => { t.groupGrok(r, th.id, "dev"); t.groupGrok(r, "settled", "marketing"); t.groupGrok(r, "gone", "dev"); t.groupGrok(r, "excluded", "dev"); r.out.excluded = { at: "now", by: "test" }; });
  const before = fs.readFileSync(f.file, "utf8"), options = { threads: [{ id: "settled", title: "Done", settledAt: "now" }] };
  let r = await run(f, ["grok", "--json"], options); assert.equal(r.error, null); assert.equal(r.sent.length, 0);
  assert.deepEqual(JSON.parse(r.logs[0]), [{ id: th.id, bot: "dev", title: "One", settled: false }, { id: "settled", bot: "marketing", title: "Done", settled: true }, { id: "gone", bot: "dev", title: null, settled: null }]);
  r = await run(f, ["grok", "--owner", "marketing", "--json"], options); assert.deepEqual(JSON.parse(r.logs[0]).map((v) => v.id), ["settled"]);
  r = await run(f, ["grok"], options); assert.match(r.logs[0], /thread-one  bot=dev  settled=false  One/); assert.match(r.logs[1], /settled=true  Done/);
  r = await run(f, ["grok", "--json"], { ready: false }); assert.equal(r.error, null); assert.equal(JSON.parse(r.logs[0])[0].title, null);
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.ok(!fs.existsSync(f.file + ".lock")); assert.ok(!fs.existsSync(f.file + ".part"));
});

test("settle/unsettle commands refuse non-members and other owners before sending anything", async (ctx) => {
  const f = fixture(ctx);
  for (const cmd of ["settle", "unsettle"]) {
    let r = await run(f, [cmd, "--thread", th.id]); assert.ok(r.error); assert.match(r.errors[0], /^NOT_GROK: the user settles main-list threads; pass --force only when the user asked for this thread$/); assert.equal(r.sent.length, 0);
    t.grokLocked((v) => t.groupGrok(v, th.id, "dev"));
    r = await run(f, [cmd, "--thread", th.id, "--owner", "marketing"]); assert.ok(r.error); assert.match(r.errors[0], /^NOT_YOUR_THREAD:/); assert.equal(r.sent.length, 0);
    r = await run(f, [cmd, "--thread", th.id], { env: { T3_OWNER: "marketing" } }); assert.ok(r.error); assert.match(r.errors[0], /^NOT_YOUR_THREAD:/); assert.equal(r.sent.length, 0);
    r = await run(f, [cmd, "--thread", th.id, "--owner", "dev"]); assert.equal(r.error, null); assert.equal(r.sent.length, 1); assert.equal(r.sent[0].payload.type, "thread." + cmd);
    r = await run(f, [cmd, "--thread", th.id, "--owner", "marketing", "--force"]); assert.equal(r.error, null); assert.equal(r.sent.length, 1);
    t.grokLocked((v) => t.ungroupGrok(v, th.id));
    r = await run(f, [cmd, "--thread", th.id, "--force"]); assert.equal(r.error, null); assert.equal(r.sent.length, 1);
    if (cmd === "unsettle") assert.equal(r.sent[0].payload.reason, "user");
  }
});

test("new/fork add Grok membership after claiming, including when a claim fails", async (ctx) => {
  const f = fixture(ctx);
  for (const cmd of ["new", "fork"]) {
    const args = cmd === "new" ? ["--project", "project-one", "--prompt", "Start"] : ["--thread", th.id];
    let claimed = false;
    const r = await run(f, [cmd, ...args], { env: { T3_OWNER: "dev" }, failClaim: true, claimHook: (id) => { assert.equal(t.grokMember(t.readGrok(), id), false); claimed = true; } });
    assert.equal(r.error, null); assert.ok(claimed); const id = r.claims[0].id;
    assert.equal(t.readGrok().threads[id].bot, "dev"); assert.equal(t.readGrok().threads[id].by, "t3ctl " + cmd); assert.ok(Number.isFinite(Date.parse(t.readGrok().threads[id].at)));
    assert.ok(r.logs.includes("grok: in the Grok section (owner dev)")); assert.equal(r.sent.length, 1);
  }
});

test("new/fork --no-grok preserve the routing claim, and no owner creates no shelf", async (ctx) => {
  const f = fixture(ctx);
  for (const cmd of ["new", "fork"]) for (const owner of [false, true]) {
    const args = cmd === "new" ? ["--project", "project-one", "--prompt", "Start"] : ["--thread", th.id];
    const r = await run(f, [cmd, ...args, ...(owner ? ["--owner", "dev", "--no-grok"] : [])]);
    assert.equal(r.error, null); assert.equal(r.claims[0].owner, owner ? "dev" : null); assert.ok(!fs.existsSync(f.file)); assert.equal(r.sent.length, 1); assert.ok(!r.logs.some((s) => s.startsWith("grok:")));
  }
  assert.equal(t.missingValue(t.args(["--no-grok"]), "new"), undefined);
});

test("new/fork Grok failure keeps the thread and prints the retry command", async (ctx) => {
  const f = fixture(ctx); put(f.file, "{broken");
  for (const cmd of ["new", "fork"]) {
    const args = cmd === "new" ? ["--project", "project-one", "--prompt", "Start"] : ["--thread", th.id];
    const r = await run(f, [cmd, ...args, "--owner", "dev"]); assert.equal(r.error, null); assert.equal(r.sent.length, 1);
    assert.match(r.errors[0], /^BAD_GROK_FILE:/); assert.ok(r.errors[0].includes(`t3ctl group --thread ${r.claims[0].id} --owner dev`));
    assert.equal(fs.readFileSync(f.file, "utf8"), "{broken");
  }
});

test("usage includes Grok commands, settle force and new/fork opt-out", async (ctx) => {
  const r = await run(fixture(ctx), []); assert.equal(r.error, null);
  for (const usage of ["group --thread t [--owner X]", "ungroup --thread t", "grok [--owner X] [--json]", "settle|unsettle --thread t [--owner X] [--force]"]) assert.ok(r.logs[0].includes(usage), usage);
  assert.match(r.logs[0], /new --project.*?--no-grok/); assert.match(r.logs[0], /fork --thread[^|]*--no-grok/);
});
