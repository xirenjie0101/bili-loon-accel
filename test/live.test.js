"use strict";
/*
 * What 2.0 adds on top of the BTR-iOS kernel: knowing which app asks and where its requests go, and
 * telling us live. Checked here against the mock CDN and a mock GitHub Contents API:
 *   - every media request becomes an event (app, host, kind, timings), accelerated or not;
 *   - the events reach the telemetry repository in batches, idempotently, without signatures,
 *     account ids or video numbers in them;
 *   - observe mode, PCDN relays, web-view requests, unknown paths: passed through, but reported;
 *   - the playurl sniff finds the CDN hosts in REST JSON and in gzip-compressed gRPC frames;
 *   - cron heartbeats, "开始实时诊断", "网速体检", the self-test pages and the plugin file itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createMock } = require("./mock/server.js");
const { createFakeLoon, segmentPlayer, ffmpegLikePlayer } = require("./lib/fake-loon-proxy.js");
const { runLoonScript } = require("./lib/loon-vm.js");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "dist", "bili-accel.js");
const PLUGIN = path.join(ROOT, "dist", "BiliAccel.plugin");
const code = () => fs.readFileSync(SCRIPT, "utf8");
const mock = createMock({ port: 18590 });
let loon;
let proxyPort = 18591;
const AKAMAI = "upos-hz-mirrorakam.akamaized.net";
const ARGS = { mode: "加速", conns: "自动", ahead: "4MB", cache: "16MB", cdn: "大陆CDN", openEnded: "分块答复", sniff: true, token: "ghp_test", repo: "me/telemetry", notify: true };
const media = (name) => fs.readFileSync(path.join(ROOT, "test", "media", name));
const passed = (result) => !!result && typeof result === "object" && JSON.stringify(result) === "{}";

test.before(() => mock.start());
test.after(async () => { await loon?.stop(); await mock.stop(); });

async function freshLoon(argument = ARGS) {
  await loon?.stop();
  mock.resetStats();
  mock.resetProfiles();
  mock.state.github.files = {};
  mock.state.github.down = false;
  mock.state.github.delayMs = 0;
  proxyPort += 1;
  loon = createFakeLoon({ port: proxyPort, cdnPort: mock.port, scriptPath: SCRIPT, argument });
  await loon.start();
  return loon;
}

const run = (options) => runLoonScript({ code: code(), store: loon.store, argument: loon.settings.argument, httpClientPort: mock.port, ...options });
const files = () => Object.entries(mock.state.github.files).sort(([a], [b]) => a.localeCompare(b));
const allEvents = () => files().flatMap(([, file]) => file.ev || []);
// Lets every queued event go out: the cron entry point, as Loon would run it every minute.
async function cron() {
  const queue = loon.queue();
  if (queue) { queue.lastTry = 0; loon.store.set("bla_tq_v1", JSON.stringify(queue)); }
  return run({ request: undefined, scriptName: "BiliAccel 定时上报" });
}

test("international app, accelerated: the events say so, and they reach the telemetry repository", async () => {
  await freshLoon();
  const original = media("v360.m4s");
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone_i");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576 });
  assert.equal(Buffer.compare(result.bytes, original), 0, "every byte in place");
  await cron();
  await cron();
  const events = allEvents().filter((event) => event.ty === "m");
  assert.equal(events.length, result.requests, `one event per App request: ${events.length} / ${result.requests}`);
  assert.ok(events.every((event) => event.a === "intl" && event.pl === "iphone_i"), "recognised as the international app (platform=iphone_i)");
  assert.ok(events.every((event) => event.h === AKAMAI && event.sc === "https" && event.x === "m4s" && event.pf === "upgcxcode"));
  assert.ok(events.some((event) => event.k === "miss" && event.f > 0 && event.bk > 0 && event.hs && event.hs[0] >= 3), "a multi-mirror batch with its speed and the mirrors that carried it");
  assert.ok(events.some((event) => event.k === "hit" || event.k === "part"), "read-ahead hits are visible");
  assert.ok(events.some((event) => event.ar > 0 && event.dt > 0), "the App's own pace (bytes between two requests) is measured");
  assert.ok(events.some((event) => event.ctl && event.ctl.b > 0), "a baseline sample of the App's own address rode along");
  const sequence = events.map((event) => event.s);
  assert.deepEqual(sequence, [...new Set(sequence)], "no event delivered twice");
  const file = files()[0][1];
  assert.equal(file.ver, require("../package.json").version);
  assert.equal(file.cfg.mode, "accel");
  assert.ok(file.agg.nodes.length >= 3 && file.agg.st.seen > 0, "every file carries a snapshot of the mirrors and counters");
  assert.ok(files().every(([name]) => /^live\/[a-z2-9]{8}\/\d{4}-\d{2}-\d{2}\/(?:\d{7}|hb-\d+)\.json$/.test(name)), files().map(([name]) => name).join(" "));
  // privacy: nothing that identifies the viewer, the video or the signed address
  const text = JSON.stringify(mock.state.github.files);
  for (const secret of ["upsig", "hdnts", "trid", "uparams", "deadline=", "/upgcxcode/01", "1001-1-", "mid=", "buvid", "ig8euxZM"]) assert.ok(!text.includes(secret), `${secret} stays on the phone`);
  assert.equal(loon.queue().ev.length, 0, "the queue is empty once delivered");
  assert.ok(loon.log.notifications.some((line) => /正在加速（国际版）/.test(line)), "the notification names the app");
});

test("pink app vs. international app are told apart; status page shows both and the telemetry line", async () => {
  await freshLoon();
  await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "a96", "iphone"), size: media("a96.m4s").length, segment: 524288 });
  await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1002, "a96", "iphone_i"), size: media("a96.m4s").length, segment: 524288 });
  await cron();
  const apps = new Set(allEvents().filter((event) => event.ty === "m").map((event) => event.a));
  assert.deepEqual([...apps].sort(), ["cn", "intl"]);
  const page = await run({ request: { url: "https://www.bilibili.com/__bla__/", method: "GET", headers: {} } });
  assert.match(page.response.body, /App 类型<\/td><td>国内版 \d+ · 国际版 \d+|App 类型<\/td><td>国际版 \d+ · 国内版 \d+/);
  assert.match(page.response.body, /实时遥测<\/td><td>设备 [a-z2-9]{8} → me\/telemetry · 已送达 \d+ 个文件/);
  assert.match(page.response.body, /复制诊断/);
});

test("observe mode passes everything through but still times the App: the baseline to compare against", async () => {
  await freshLoon({ ...ARGS, mode: "只观察（对照）" });
  const original = media("v360.m4s");
  const result = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v360", "iphone_i"), size: original.length, segment: 262144, stopAfterBytes: 3 * 262144 });
  assert.equal(loon.log.scriptAnswers, 0, "the script answered nothing itself");
  assert.equal(loon.log.passedThrough, result.requests);
  await cron();
  const events = allEvents().filter((event) => event.ty === "m");
  assert.ok(events.every((event) => event.k === "obs"), "every event says observe");
  const paced = events.filter((event) => event.ar > 0);
  assert.ok(paced.length >= 1, "the App's pace on its own route is measured");
  assert.ok(paced.every((event) => event.ar < 80), `…and it is the slow origin's ~40 KB/s: ${paced.map((event) => event.ar)}`);
  const state = loon.state();
  assert.ok(state.stats.arObs > 0 && !(state.stats.arAcc > 0));
});

test("PCDN relays, web-view requests and unknown paths are passed through and reported, with the reason", async () => {
  await freshLoon();
  const relay = "http://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/01/10/1001/1001-1-30080.m4s?os=mcdn&platform=iphone_i&upsig=x";
  const web = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone_i");
  const odd = "https://upos-sz-mirrorcos.bilivideo.com/ugaxcode/01/10/1001/1001-1-30080.m4s?platform=iphone";
  for (const [target, headers] of [[relay, {}], [web, { Origin: "https://www.bilibili.com" }], [odd, {}]]) {
    const result = await run({ request: { url: target, method: "GET", headers: { Range: "bytes=0-1048575", "User-Agent": "Bilibili Freedoooooom/MarkII", ...headers } } });
    assert.ok(passed(result), `${target} passes through`);
  }
  await cron();
  const kinds = allEvents().filter((event) => event.ty === "m").map((event) => `${event.k}:${event.a}`);
  assert.deepEqual(kinds, ["relay:intl", "skip:intl", "unknown:cn"]);
  const events = allEvents();
  assert.equal(events[0].pt, 4483);
  assert.equal(events[0].sc, "http");
  assert.match(events[1].r, /网页/);
  assert.match(events[2].r, /ugaxcode/);
});

function grpcFrame(message, compress) {
  const payload = compress ? zlib.gzipSync(message) : message;
  const head = Buffer.alloc(5);
  head[0] = compress ? 1 : 0;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function fakeProto(urls) {
  // length-prefixed strings with tag bytes in between — what protobuf looks like from outside
  const parts = [];
  for (const value of urls) {
    const bytes = Buffer.from(value);
    parts.push(Buffer.from([0x2a]), Buffer.from([bytes.length & 0x7f | 0x80, bytes.length >> 7]), bytes, Buffer.from([0x32, 0x05]), Buffer.from("hello"));
  }
  return Buffer.concat(parts);
}

test("playurl sniff: gzip-compressed gRPC (PlayViewUnite) — hosts counted, PCDN noticed, response untouched", async () => {
  await freshLoon();
  const urls = [
    "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/80/20/1001/1001-1-30080.m4s?e=x&platform=iphone_i&upsig=abc",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/80/20/1001/1001-1-30080.m4s?hdnts=1",
    "http://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/80/20/1001/1001-1-30280.m4s?os=mcdn",
    "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/80/20/1001/1001-1-30280.m4s?e=y",
    "https://i0.hdslb.com/bfs/archive/cover.jpg"
  ];
  const body = new Uint8Array(grpcFrame(fakeProto(urls), true));
  const result = await run({
    request: { url: "https://app.bilibili.com/bilibili.app.playerunite.v1.Player/PlayViewUnite", method: "POST", headers: { "User-Agent": "bili-inter/73300100 os/ios model/iPhone 15 mobi_app/iphone_i build/73300100", "Content-Type": "application/grpc" } },
    response: { status: 200, headers: { "Content-Type": "application/grpc", "grpc-encoding": "gzip" }, body }
  });
  assert.ok(passed(result), "the response goes on unchanged");
  await cron();
  const sniff = allEvents().find((event) => event.ty === "api");
  assert.ok(sniff, "sniff event delivered");
  assert.equal(sniff.a, "intl");
  assert.equal(sniff.via, "grpc");
  assert.equal(sniff.gz, "gzip");
  assert.equal(sniff.n, 4, "four media addresses (the cover image is not one)");
  assert.deepEqual(sniff.hosts, { "upos-sz-mirrorcosov.bilivideo.com": 2, "upos-hz-mirrorakam.akamaized.net": 1, "xy1x2x3x4xy.mcdn.bilivideo.cn:4483": 1 });
  assert.equal(sniff.relay, 1);
  assert.equal(sniff.ep, "app.playerunite.v1.Player/PlayViewUnite");
  assert.ok(!JSON.stringify(sniff).includes("upsig"), "no signatures");
  const page = await run({ request: { url: "https://www.bilibili.com/__bla__/", method: "GET", headers: {} } });
  assert.match(page.response.body, /播放地址侦察<\/td><td>[^<]*国际版 app\.playerunite\.v1\.Player\/PlayViewUnite：4 个地址（PCDN 1）/);
});

test("playurl sniff: REST JSON with escaped slashes; gRPC metadata names the app when the UA does not", async () => {
  await freshLoon();
  const json = JSON.stringify({ code: 0, data: { dash: { video: [{ base_url: "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/1/2/3/3-1-30064.m4s?e=1", backup_url: ["https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3/3-1-30064.m4s?e=1"] }] } } }).replace(/\//g, "\\/");
  await run({
    request: { url: "https://app.bilibili.com/x/v2/playurl?mobi_app=iphone&build=80300100&access_key=SECRET&cid=123", method: "GET", headers: { "User-Agent": "bili-universal/80300100" } },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: new Uint8Array(Buffer.from(json)) }
  });
  const meta = Buffer.concat([Buffer.from([0x0a, 0x08]), Buffer.from("iphone_i"), Buffer.from([0x10, 0x01])]).toString("base64");
  await run({
    request: { url: "https://grpc.biliapi.net/bilibili.app.playurl.v1.PlayURL/PlayView", method: "POST", headers: { "User-Agent": "grpc-objc/1.0", "x-bili-metadata-bin": meta } },
    response: { status: 200, headers: { "Content-Type": "application/grpc" }, body: new Uint8Array(grpcFrame(fakeProto(["https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=1"]), false)) }
  });
  await cron();
  const [rest, grpc] = allEvents().filter((event) => event.ty === "api");
  assert.equal(rest.via, "rest");
  assert.equal(rest.a, "cn");
  assert.deepEqual(rest.hosts, { "upos-sz-mirrorali.bilivideo.com": 1, "cn-hk-eq-01-03.bilivideo.com": 1 });
  assert.deepEqual(rest.qp, { mobi_app: "iphone", build: "80300100" }, "only harmless query parameters (no access_key, no cid)");
  assert.equal(grpc.a, "intl", "mobi_app from x-bili-metadata-bin");
  assert.equal(grpc.n, 1);
});

test("telemetry delivery is idempotent: a batch whose answer was lost is sent again and not stored twice", async () => {
  await freshLoon();
  await run({ request: { url: "http://1.2.3.4:4480/upgcxcode/01/10/1001/1001-1-30080.m4s?platform=iphone_i", method: "GET", headers: { Range: "bytes=0-99" } } });
  await cron();
  assert.equal(files().length, 1);
  // pretend Loon ended the script before GitHub's 201 came back: the batch is still marked in flight
  const queue = loon.queue();
  const firstEvent = files()[0][1].ev[0];
  queue.ev = [firstEvent];
  queue.inflight = { a: firstEvent.s, b: firstEvent.s, at: Date.now(), day: files()[0][0].split("/")[2] };
  loon.store.set("bla_tq_v1", JSON.stringify(queue));
  await cron();
  assert.equal(files().length, 1, "GitHub's 422 for the same file counts as delivered");
  assert.equal(loon.queue().ev.length, 0);
  assert.equal(loon.queue().inflight, null);
});

test("cron: heartbeats only during a live session; wrong token and unreachable GitHub are reported, events kept", async () => {
  await freshLoon();
  await cron();
  assert.equal(files().length, 0, "nothing to send, no live session: no file");
  const live = await run({ request: undefined, scriptName: "BiliAccel 开始实时诊断" });
  assert.match(live.content, /已连上遥测仓库 me\/telemetry/);
  const hello = allEvents().find((event) => event.ty === "hi");
  assert.ok(hello && hello.ungzip === 1, "hello event (with whether $utils.ungzip exists)");
  await cron();
  assert.ok(files().some(([name]) => /\/hb-\d+\.json$/.test(name)), "a heartbeat during the live session");

  await freshLoon({ ...ARGS, token: "ghp_wrong" });
  await run({ request: { url: "http://1.2.3.4:4480/upgcxcode/01/10/1001/1001-1-30080.m4s", method: "GET", headers: {} } });
  await cron();
  assert.equal(files().length, 0);
  assert.match(loon.queue().err, /^401/);
  assert.equal(loon.queue().ev.length, 1, "the event waits for a working token");
  const reply = await run({ request: undefined, scriptName: "BiliAccel 开始实时诊断" });
  assert.match(reply.content, /401/);

  await freshLoon({ ...ARGS, token: "" });
  await run({ request: { url: "http://1.2.3.4:4480/upgcxcode/01/10/1001/1001-1-30080.m4s", method: "GET", headers: {} } });
  await cron();
  assert.equal(mock.stats.githubPuts || 0, 0, "no token: nothing is sent anywhere");
});

test("self-test pages: the https and http media rules answer on the phone and report live", async () => {
  await freshLoon();
  for (const scheme of ["https", "http"]) {
    const page = await run({ request: { url: `${scheme}://upos-sz-mirrorali.bilivideo.com/__bla_selftest__.m4s`, method: "GET", headers: { "User-Agent": "Mozilla/5.0 (iPhone) Safari", "Sec-Fetch-Mode": "navigate" } } });
    assert.equal(page.response.status, 200);
    assert.match(page.response.body, new RegExp(`${scheme === "https" ? "HTTPS（MITM）" : "HTTP"} 媒体规则已触发`));
  }
  const rules = allEvents().filter((event) => event.ty === "rule").map((event) => event.sc);
  assert.deepEqual(rules, ["https", "http"], "both visits are already in the repository");
});

test("网速体检: one connection to the App's address vs 8 and 16 mirror connections, reported", async () => {
  await freshLoon();
  // the App played something a moment ago
  await ffmpegLikePlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v720", "iphone_i"), stopAfterBytes: 600000 });
  const result = await run({ request: undefined, scriptName: "BiliAccel 网速体检", timeoutMs: 120000 });
  assert.match(result.content, /原地址单连接 \d+ KB\/s · 8 路 \d+ KB\/s（×[\d.]+） · 16 路 \d+ KB\/s/);
  const speed = allEvents().find((event) => event.ty === "spd");
  assert.equal(speed.src, "app:intl");
  assert.equal(speed.host, AKAMAI);
  assert.ok(speed.A.kb > 20 && speed.A.kb < 80, `the App's own route ≈ 40 KB/s: ${speed.A.kb}`);
  assert.ok(speed.B.kb > speed.A.kb * 3, `8 mirrors well ahead: ${speed.B.kb} vs ${speed.A.kb}`);
  assert.ok(speed.B.per.some((row) => row[2]), "the dead / refusing mirrors show up with their error");
  assert.equal(speed.C.n, 16);
});

test("the plugin file: new script syntax, every entry point, and the rules reach what they must", async () => {
  const plugin = fs.readFileSync(PLUGIN, "utf8");
  assert.match(plugin, /^#!loon_version = 3\.5\.1\(983\)$/m);
  for (const name of ["mode", "conns", "ahead", "cache", "cdn", "openEnded", "sniff", "token", "repo", "notify"]) assert.match(plugin, new RegExp(`^${name} = (?:select|switch|input),`, "m"), name);
  assert.match(plugin, /^mode = select,"加速",/m, "accelerate is the default");
  assert.match(plugin, /^token = input,"",/m, "no token by default: nothing leaves the phone until one is entered");
  const lines = plugin.split("\n");
  const media = lines.find((line) => /tag="BiliAccel 媒体加速"/.test(line));
  const rule = new RegExp(/~= \/(.+)\/i then/.exec(media)[1], "i");
  for (const sample of [
    "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=1",
    "http://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=1",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/3-1-30080.m4s",
    "https://cn-gdfs-ct-01-01.bilivideo.com/upgcxcode/1/2/3/3-1-30280.m4s",
    "http://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/1/2/3/3-1-30280.m4s",
    "http://111.22.33.44:8082/v1/resource/1-1-30080.m4s?os=mcdn",
    "https://upos-sz-mirrorali.bilivideo.com/__bla_selftest__.m4s",
    "https://upos-sz-mirror08c.bilivideo.com/upgcxcode/1/2/3/3-1-80.mp4?e=1"
  ]) assert.ok(rule.test(sample), `${sample} reaches the script`);
  for (const sample of ["https://i0.hdslb.com/bfs/archive/x.jpg", "https://example.akamaized.net/movie.mp4", "https://cdn.example.com/a.m4s"]) assert.ok(!rule.test(sample), `${sample} does not`);
  const sniff = lines.find((line) => /tag="BiliAccel 播放地址侦察"/.test(line));
  assert.match(sniff, /^response if /);
  assert.match(sniff, /requires_body=true, binary_body_mode=true/);
  const sniffRule = new RegExp(/~= \/(.+)\/i then/.exec(sniff)[1], "i");
  for (const sample of ["https://grpc.biliapi.net/bilibili.app.playurl.v1.PlayURL/PlayView", "https://app.bilibili.com/bilibili.app.playerunite.v1.Player/PlayViewUnite", "https://app.bilibili.com/bilibili.pgc.gateway.player.v2.PlayURL/PlayView", "https://app.biliapi.net/x/v2/playurl?cid=1", "https://api.bilibili.com/pgc/player/api/playurl?ep_id=1"]) assert.ok(sniffRule.test(sample), sample);
  assert.ok(!sniffRule.test("https://app.bilibili.com/x/v2/feed/index"));
  assert.ok(lines.some((line) => /^cron "\* \* \* \* \*" then script\(/.test(line) && /tag="BiliAccel 定时上报"/.test(line)));
  assert.ok(lines.some((line) => /^generic then script\(/.test(line) && /tag="BiliAccel 开始实时诊断"/.test(line)));
  assert.ok(lines.some((line) => /^generic then script\(/.test(line) && /tag="BiliAccel 网速体检"/.test(line)));
  for (const line of lines.filter((item) => /script\("/.test(item))) assert.match(line, /\{\$\{mode\}, \$\{conns\}, \$\{ahead\}, \$\{cache\}, \$\{cdn\}, \$\{openEnded\}, \$\{sniff\}, \$\{token\}, \$\{repo\}, \$\{notify\}\}/);
  const mitm = /^hostname = (.+)$/m.exec(plugin)[1].split(/\s*,\s*/);
  const covered = (host) => mitm.some((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*(?:\\.[^.]+)*?")}$`).test(host));
  for (const host of ["upos-hz-mirrorakam.akamaized.net", "upos-sz-mirrorcosov.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn", "www.bilibili.com", "app.bilibili.com", "grpc.biliapi.net", "app.biliapi.net"]) assert.ok(covered(host), `${host} is decrypted`);
  for (const host of ["i0.hdslb.com", "example.akamaized.net", "github.com", "api.github.com"]) assert.ok(!covered(host), `${host} is left alone`);
});
