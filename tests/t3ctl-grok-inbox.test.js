// Local Grok dialog writer/reader; every filesystem and CLI fixture is outside live T3 data.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process"), { once } = require("node:events");
const ctl = path.join(__dirname, "..", "tools", "t3ctl"), t = require(ctl), source = fs.readFileSync(ctl, "utf8");
function fixture(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3ctl-inbox-")), inbox = path.join(dir, "inbox");
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, T3_CUSTOM_GROK_INBOX: inbox, T3_HOME: path.join(dir, "no-t3"), T3CODE_HOME: path.join(dir, "no-t3"), T3_OWNER: "" };
  return { dir, inbox, env, run: (...args) => spawnSync(process.execPath, [ctl, ...args], { env, encoding: "utf8" }) };
}
function put(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }
const lines = (file) => fs.readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse);
const date = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const message = (id, ago, extra = {}) => ({ v: 1, id, at: new Date(Date.now() - ago * 3600000).toISOString(), from: "dev", text: id, attachments: [], ...extra });
function post(f, o = {}) { return t.writeGrokPost({ from: "dev", text: "hello", ...o }, undefined, f.inbox); }
// Exercise the real command dispatch, replacing init and shell in a VM so no credentials or API can be accessed.
async function runMock(f, argv, ready, threads = [], failure) {
  const logs = [], io = { ready, threads, failure, calls: 0 };
  const ctx = vm.createContext({ require, module: { exports: {} }, __dirname: f.dir, Buffer, SharedArrayBuffer, Int32Array, Atomics,
    process: { argv: [process.execPath, ctl, ...argv], env: f.env, exit: () => { throw new Error("exit"); } }, io,
    console: { log: (s) => logs.push(s), error: () => {} } });
  vm.runInContext(source + `\ninit = () => { io.calls++; return io.ready; }; get = async () => { if (io.failure) throw new Error(io.failure); return { threads: io.threads }; }; module.exports.main = main;`, ctx, { filename: ctl });
  let error; try { await ctx.module.exports.main(); } catch (e) { error = e; } return { logs, error, calls: io.calls };
}

test("grokInboxPath follows the shelf base rule, independent of the shelf override", () => {
  const home = path.join(os.tmpdir(), "inbox-home"), base = path.join(home, "custom");
  assert.equal(t.grokInboxPath({}, home), path.join(home, ".t3", "custom-t3", "grok-inbox"));
  for (const value of [base, path.join(base, "userdata"), path.join(base, "userdata") + path.sep, "~/custom/userdata"])
    assert.equal(t.grokInboxPath({ T3CODE_HOME: value, T3_HOME: "/ignored", T3_CUSTOM_GROK_FILE: "/ignored/shelf" }, home), path.join(base, "custom-t3", "grok-inbox"));
  assert.equal(t.grokInboxPath({ T3_CUSTOM_GROK_INBOX: "/override" }, home), "/override");
});

test("grok-post text-only CLI works without T3 or a token and returns the stored message", (ctx) => {
  const f = fixture(ctx), r = f.run("grok-post", "--from", "marketing", "--text", "# Hello\nmarkdown", "--title", "Cut", "--json");
  assert.equal(r.status, 0, r.stderr); const m = JSON.parse(r.stdout);
  assert.match(m.id, /^\d{8}T\d{6}-[a-f0-9]{6}$/); assert.equal(m.id.slice(0, 8), date(m.at).replace(/-/g, ""));
  assert.deepEqual(m, { v: 1, id: m.id, at: m.at, from: "marketing", title: "Cut", text: "# Hello\nmarkdown", attachments: [] });
  assert.deepEqual(lines(path.join(f.inbox, "messages.jsonl")), [m]); assert.ok(!fs.existsSync(path.join(f.inbox, ".lock")));
  assert.equal(fs.statSync(path.join(f.inbox, "messages.jsonl")).mode & 0o777, 0o644);
  const plain = f.run("grok-post", "--from", "dev", "--text", "next"); assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^posted \d{8}T\d{6}-[a-f0-9]{6} to the Grok dialog \(0 file\(s\)\)\n$/);
});

test("text-file decodes UTF-8 BOM, UTF-16 LE/BE and normalizes Windows newlines", (ctx) => {
  const f = fixture(ctx), text = "A duck 🦆\r\nsecond\rthird", le = Buffer.from(text, "utf16le"), be = Buffer.from(le); be.swap16();
  for (const [i, buf] of [Buffer.from("\uFEFF" + text), Buffer.concat([Buffer.from([255, 254]), le]), Buffer.concat([Buffer.from([254, 255]), be])].entries()) {
    const file = put(path.join(f.dir, `text-${i}.md`), buf), r = f.run("grok-post", "--from", "dev", "--text-file", file, "--json");
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).text, "A duck 🦆\nsecond\nthird");
  }
});

test("image/video attachment copies are independent, sanitized, deduplicated and mode 0644", (ctx) => {
  const f = fixture(ctx), a = put(path.join(f.dir, "a", "cut♥.mp4"), "video-data"), b = put(path.join(f.dir, "b", "cut?.mp4"), "other-video"), c = put(path.join(f.dir, "duck☃.png"), "png-data");
  const r = f.run("grok-post", "--from", "dev", "--attach", [a, b, c].join(","), "--json"); assert.equal(r.status, 0, r.stderr); const m = JSON.parse(r.stdout);
  assert.equal(m.text, ""); assert.deepEqual(m.attachments.map((a) => a.name), ["cut_.mp4", "cut_-2.mp4", "duck_.png"]);
  assert.deepEqual(m.attachments.map((a) => [a.kind, a.mime]), [["video", "video/mp4"], ["video", "video/mp4"], ["image", "image/png"]]);
  for (const [i, src] of [a, b, c].entries()) { const a = m.attachments[i], dst = path.join(f.inbox, a.file);
    assert.equal(a.file, `media/${m.id}/${a.name}`); assert.equal(a.size, fs.statSync(src).size); assert.deepEqual(fs.readFileSync(dst), fs.readFileSync(src));
    assert.equal(fs.statSync(dst).mode & 0o777, 0o644); const before = fs.readFileSync(dst); fs.writeFileSync(src, "changed"); assert.deepEqual(fs.readFileSync(dst), before); }
});

test("long names and case-insensitive clashes remain unique and at most 120 characters", (ctx) => {
  const f = fixture(ctx), a = put(path.join(f.dir, "a".repeat(130) + ".png"), "x"), b = put(path.join(f.dir, "A".repeat(130) + ".png"), "y");
  const m = post(f, { attach: [a, b, a].join(",") });
  assert.equal(new Set(m.attachments.map((a) => a.name.toLowerCase())).size, 3);
  for (const a of m.attachments) { assert.ok(a.name.length <= 120); assert.match(a.name, /^[A-Za-z0-9_ ()+-][A-Za-z0-9._ ()+-]*$/); }
});

test("attachment kinds cover avif, audio, uppercase extensions and unknown files", (ctx) => {
  const f = fixture(ctx), files = ["a.AVIF", "b.mov", "c.m4v", "d.webm", "e.mp3", "f.m4a", "g.wav", "h.ogg", "i.bin"].map((n) => put(path.join(f.dir, n), "x"));
  const m = post(f, { attach: files.join(",") });
  assert.deepEqual(m.attachments.map((a) => [a.kind, a.mime]), [["image", "image/avif"], ["video", "video/quicktime"], ["video", "video/x-m4v"], ["video", "video/webm"], ["audio", "audio/mpeg"], ["audio", "audio/mp4"], ["audio", "audio/wav"], ["audio", "audio/ogg"], ["file", "application/octet-stream"]]);
});

test("sensitive, hidden, missing, non-file and oversized attachments leave nothing behind", (ctx) => {
  const f = fixture(ctx), good = put(path.join(f.dir, "good.png"), "good"), large = put(path.join(f.dir, "large.mp4"), "");
  const stat = fs.lstatSync; ctx.mock.method(fs, "lstatSync", (p) => p === large ? { isFile: () => true, size: 4 * 1024 ** 3 + 1 } : stat(p));
  // Sensitive files are never created or read: refusal must happen on their path alone.
  for (const bad of ["token", "listen-secret.json", "googleAuth.json", ".env", "private.key", "credentials/data.png", ".hidden/data.png", "missing.png", ".", "large.mp4"]) {
    assert.throws(() => post(f, { attach: [good, path.join(f.dir, bad)].join(",") }), /BAD_ATTACHMENT/);
    assert.ok(!fs.existsSync(f.inbox), bad);
  }
  assert.throws(() => post(f, { attach: Array(21).fill(good).join(",") }), /BAD_ATTACHMENT/); assert.ok(!fs.existsSync(f.inbox));
});

test("copy failure removes partial media, preserves messages and releases the lock", (ctx) => {
  const f = fixture(ctx), a = put(path.join(f.dir, "a.png"), "a"), b = put(path.join(f.dir, "b.mp4"), "b"); post(f);
  const file = path.join(f.inbox, "messages.jsonl"), before = fs.readFileSync(file), copy = fs.copyFileSync; let calls = 0;
  ctx.mock.method(fs, "copyFileSync", (src, dst, flags) => { assert.equal(flags, fs.constants.COPYFILE_FICLONE); if (++calls === 2) throw new Error("copy failed"); return copy(src, dst, flags); });
  assert.throws(() => post(f, { attach: [a, b].join(",") }), /BAD_ATTACHMENT/); assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(!fs.existsSync(path.join(f.inbox, "media"))); assert.ok(!fs.existsSync(path.join(f.inbox, ".lock")));
});

test("rotation appends old messages by local date, preserves unreadable lines and renames atomically", (ctx) => {
  const f = fixture(ctx), old = message("old", 49), old2 = message("old2", 48), recent = message("recent", 2), file = path.join(f.inbox, "messages.jsonl");
  const raw = [JSON.stringify(old2), "{broken", JSON.stringify(recent), "null", JSON.stringify(old), '{"at":"invalid"}'].join("\n") + "\n";
  put(file, raw); const prior = message("prior", 50); put(path.join(f.inbox, "archive", date(old.at) + ".jsonl"), JSON.stringify(prior) + "\n");
  const rename = fs.renameSync; let renamed = false;
  ctx.mock.method(fs, "renameSync", (src, dst) => { assert.equal(src, file + ".part"); assert.equal(dst, file); assert.equal(fs.readFileSync(file, "utf8"), raw);
    assert.ok(fs.existsSync(path.join(f.inbox, ".lock"))); assert.equal(lines(src).length, 2); renamed = true; return rename(src, dst); });
  const m = post(f); assert.ok(renamed); assert.deepEqual(lines(file), [recent, m]);
  const archived = [old, old2].filter((x) => date(x.at) === date(old.at)); assert.deepEqual(lines(path.join(f.inbox, "archive", date(old.at) + ".jsonl")), [prior, ...archived]);
  if (date(old2.at) !== date(old.at)) assert.deepEqual(lines(path.join(f.inbox, "archive", date(old2.at) + ".jsonl")), [old2]);
  assert.equal(fs.readFileSync(path.join(f.inbox, "archive", "unreadable.jsonl"), "utf8"), '{broken\nnull\n{"at":"invalid"}\n');
  assert.ok(!fs.existsSync(file + ".part")); assert.ok(!fs.existsSync(path.join(f.inbox, ".lock")));
});

test("failed atomic rename preserves recent messages and removes temporary state and media", (ctx) => {
  const f = fixture(ctx); post(f); const file = path.join(f.inbox, "messages.jsonl"), before = fs.readFileSync(file), a = put(path.join(f.dir, "a.png"), "a");
  ctx.mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
  assert.throws(() => post(f, { attach: a }), /rename failed/); assert.deepEqual(fs.readFileSync(file), before);
  for (const n of ["messages.jsonl.part", ".lock", "media"]) assert.ok(!fs.existsSync(path.join(f.inbox, n)));
});

test("writer waits for another process and re-reads its messages under the lock", async (ctx) => {
  const f = fixture(ctx), script = `const t = require(${JSON.stringify(ctl)}); t.grokInboxLocked((dir) => { console.log('locked'); require('node:fs').readSync(0, Buffer.alloc(1), 0, 1, null); require('node:fs').writeFileSync(require('node:path').join(dir, 'messages.jsonl'), JSON.stringify(${JSON.stringify(message("child", 1))}) + '\\n'); });`;
  const child = spawn(process.execPath, ["-e", script], { env: f.env, stdio: ["pipe", "pipe", "pipe"] }); ctx.after(() => child.kill()); const done = once(child, "exit");
  await once(child.stdout, "data"); assert.ok(fs.existsSync(path.join(f.inbox, ".lock")));
  // Child releases after the parent's synchronous lock loop has started.
  child.stdin.end("x"); const m = post(f); assert.equal((await done)[0], 0);
  assert.deepEqual(lines(path.join(f.inbox, "messages.jsonl")).map((m) => m.id), ["child", m.id]);
});

test("GROK_INBOX_LOCKED waits 15 seconds without stealing a lock or writing messages", (ctx) => {
  const f = fixture(ctx), lock = path.join(f.inbox, ".lock"); fs.mkdirSync(lock, { recursive: true }); let now = 0;
  ctx.mock.method(Date, "now", () => now); ctx.mock.method(Atomics, "wait", () => { now += 1000; });
  assert.throws(() => post(f), /^Error: GROK_INBOX_LOCKED:/); assert.equal(now, 15000); assert.ok(fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(f.inbox), [".lock"]);
});

test("--from is required, defaults to T3_OWNER, and explicit --from wins", (ctx) => {
  const f = fixture(ctx); let r = f.run("grok-post", "--text", "hello"); assert.equal(r.status, 1); assert.match(r.stderr, /USAGE: --from/); assert.ok(!fs.existsSync(f.inbox));
  f.env.T3_OWNER = "marketing"; r = f.run("grok-post", "--text", "hello", "--json"); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).from, "marketing");
  r = f.run("grok-post", "--from", "dev", "--text", "hello", "--json"); assert.equal(JSON.parse(r.stdout).from, "dev");
});

test("post validates sender, text/title limits, exclusive text inputs and missing flag values", (ctx) => {
  const f = fixture(ctx);
  for (const o of [{ from: "bad/bot" }, { from: "a".repeat(41) }, { from: " " }, { text: "x".repeat(20001) }, { title: "x".repeat(201) }, { text: "" }, { text: " ", attach: "" }, { "text-file": "unused.md" }])
    assert.throws(() => post(f, o), /USAGE/);
  for (const flag of ["--text-file", "--from", "--attach"]) { const r = f.run("grok-post", flag); assert.equal(r.status, 1); assert.match(r.stderr, /USAGE/); }
  assert.ok(!fs.existsSync(f.inbox)); const m = post(f, { text: "x".repeat(20000), title: "x".repeat(200), from: "Bot 1._-" }); assert.equal(m.text.length, 20000);
});

test("--thread resolves through findThread, preserves ambiguity, or stores an offline id", async (ctx) => {
  const f = fixture(ctx), argv = ["grok-post", "--from", "dev", "--text", "hello", "--json"], th = { id: "thread:project:p:12345678", title: "Duck cut", updatedAt: "2026-10-28" };
  let r = await runMock(f, [...argv, "--thread", "Duck"], true, [th]); assert.equal(r.error, undefined); assert.deepEqual(JSON.parse(r.logs[0]).thread, { id: th.id, title: th.title }); assert.equal(r.calls, 1);
  for (const failure of [undefined, "T3_NOT_REACHABLE: offline"]) { r = await runMock(f, [...argv, "--thread", th.id], !!failure, [], failure); assert.equal(r.error, undefined); assert.deepEqual(JSON.parse(r.logs[0]).thread, { id: th.id }); }
  r = await runMock(f, [...argv, "--thread", "Duck cut"], false); assert.match(r.error.message, /T3_NOT_REACHABLE/);
  r = await runMock(f, [...argv, "--thread", "Duck"], true, [th, { id: "another-thread", title: "Duck edit", updatedAt: "2026-10-28" }]); assert.match(r.error.message, /AMBIGUOUS/);
  r = await runMock(f, [...argv, "--thread", th.id], true, []); assert.match(r.error.message, /NOT_FOUND/);
  r = await runMock(f, argv, false); assert.equal(r.error, undefined); assert.equal(r.calls, 0);
});

test("grok-inbox --days lists recent and archived messages oldest first with text and attachment names", (ctx) => {
  const f = fixture(ctx), old = message("old", 60), earlier = message("earlier", 30, { title: "Earlier cut", attachments: [{ name: "cut.mp4" }] }), recent = message("recent", 2, { text: "first line\nsecond line", attachments: [{ name: "duck.png" }] });
  put(path.join(f.inbox, "messages.jsonl"), JSON.stringify(recent) + "\n{broken\nnull\n");
  put(path.join(f.inbox, "archive", "old.jsonl"), [JSON.stringify(earlier), JSON.stringify(old), "bad"].join("\n") + "\n");
  let r = f.run("grok-inbox", "--json"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), [recent]);
  r = f.run("grok-inbox", "--days", "2", "--json"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), [earlier, recent]);
  const before = fs.readFileSync(path.join(f.inbox, "messages.jsonl")); r = f.run("grok-inbox", "--days", "2"); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 2); assert.match(r.stdout, /dev  Earlier cut  cut.mp4\n.*dev  first line  duck.png/); assert.ok(!r.stdout.includes("second line"));
  assert.deepEqual(fs.readFileSync(path.join(f.inbox, "messages.jsonl")), before); assert.ok(!fs.existsSync(path.join(f.inbox, ".lock")));
  for (const days of ["0", "-1", "1.5", "bad"]) { r = f.run("grok-inbox", "--days", days); assert.equal(r.status, 1); assert.match(r.stderr, /BAD_SETTING/); }
});

test("grok-inbox tolerates missing folders/files and malformed lines without writing", (ctx) => {
  const f = fixture(ctx); let r = f.run("grok-inbox", "--json"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), []); assert.ok(!fs.existsSync(f.inbox));
  put(path.join(f.inbox, "archive", "unreadable.jsonl"), "broken\nnull\n"); r = f.run("grok-inbox", "--json"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), []);
  assert.deepEqual(fs.readdirSync(f.inbox), ["archive"]);
});

test("usage includes grok-post and grok-inbox", (ctx) => {
  const f = fixture(ctx), r = f.run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grok-post --from bot \(--text markdown \| --text-file path\)/); assert.match(r.stdout, /grok-inbox \[--days 1\] \[--json\]/);
});
