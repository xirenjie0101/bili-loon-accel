/*
 * BiliAccel · B 站双端加速（国际版 + 国内版）· 实时诊断版  —  __BLA_VERSION__
 *
 * 一个脚本，五个入口（由 Loon 插件按场景调用）：
 *   1. 媒体请求（request）：哔哩哔哩 App 取视频分段时，按“线程撕裂者”的办法向多个 CDN 节点并行要字节块，
 *      多取的部分放进 $persistentStore 当预读缓存，App 下一次要的时候直接给。任何一步不对就原样放行。
 *      加速内核来自 BTR-iOS 1.5（移植自开源项目 Bilibili-thread-ripper，MIT）。
 *   2. 播放地址侦察（response）：只读不改。看 App 拿到的播放地址都指向哪些 CDN（REST JSON 和 gRPC 都看），
 *      用来判断“为什么没加速”——比如 App 拿到的全是 PCDN 地址，或者视频走了插件没覆盖的域名。
 *   3. 统计页（request，www.bilibili.com/__bla__/）：Safari 里打开就能看。
 *   4. 定时上报（cron，每分钟）：把这段时间的运行记录写进你自己的私有 GitHub 仓库（实时遥测）。
 *   5. 手动运行（generic）：“开始实时诊断”“网速体检”。
 *
 * 实时遥测只写你在插件参数里填的仓库，用你自己的令牌；写进去的只有：CDN 主机名、请求大小、耗时、速度、
 * 原因、App 类型（国际版 / 国内版）和版本号。不写 Cookie、账号、完整视频地址（签名、mid、buvid）、视频编号。
 * Generated file — edit src/ and run `node build.js` instead.
 */
var BTRA_VERSION = "__BLA_VERSION__";
var BTRA_STORE_KEY = "bla_state_v1";
var BTRA_CACHE_PREFIX = "bla_c:";
var BTRA_STATUS_URL = "https://www.bilibili.com/__bla__/";
var BLA_TQ_KEY = "bla_tq_v1";            // telemetry queue (events waiting to be written to GitHub)
var BLA_LAST_MEDIA_KEY = "bla_last_media"; // the last media address the App used — stays on the device (speed test)
var BLA_DEFAULT_REPO = "__BLA_TELEMETRY_REPO__";
var BLA_FLUSH_MIN_MS = 20000;            // media runs write to GitHub at most this often (cron: every minute)
var BLA_LIVE_AFTER_MS = 20 * 60000;      // heartbeats continue this long after the last activity
var BLA_TQ_MAX = 400;                    // events kept while GitHub is unreachable
var BLA_BATCH_EVENTS = 160;
var BLA_CONTROL_EVERY_MS = 45000;        // how often one read-ahead piece goes to the App's own address (the baseline)
var BLA_CONTROL_BYTES = 512 * 1024;
// Hosts the Bilibili apps fetch media from (upstream BTR's MEDIA_HOST_RE, plus raw IPs of PCDN boxes).
var BLA_MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;
var BLA_RELAY_HOST_RE = /(?:^|\.)(?:mcdn\.bilivideo\.(?:com|cn|net)|szbdyd\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$|^\d{1,3}(?:\.\d{1,3}){3}$/i;
// Every distinct mirror is an independent route with its own bandwidth, so the way to go faster
// over a congested overseas link is to add more of them together, not to lean on one. A mirror
// that turns out dead or wrong-signed simply fails its probes and is rested; the cost of listing
// one that does not work is a couple of wasted probes.
var BTRA_MAINLAND = [
  "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorali02.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorhwb.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com",
  "upos-sz-mirror08h.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcosb.bilivideo.com",
  "upos-sz-upcdntx.bilivideo.com", "upos-sz-upcdnbda2.bilivideo.com", "upos-sz-upcdnqn.bilivideo.com",
  "upos-sz-upcdnws.bilivideo.com"
];
var BTRA_OVERSEAS = [
  "upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com",
  "cn-hk-eq-bcache-01.bilivideo.com"
];
var BTRA_SLICE_MS = 1000;             // every connection is given what it should deliver in this time
var BTRA_EXTRA_SHARE = 0.8;            // read-ahead pieces are cut a little shorter, so they land first
var BTRA_BUSY_KEY = "bla_busy";
var BTRA_BUSY_MS = 2500;               // how long a connection started by another run is assumed to be in use
var BTRA_ASSUMED_BPS = 40;             // bytes per ms assumed for a mirror nobody has measured (≈ 40 KB/s)
var BTRA_PER_HOST = 6;                 // connections to one mirror at a time (iOS queues more than that)
var BTRA_EXPLORE = 4;                  // unmeasured mirrors probed per batch, so a wider pool is learned quickly
var BTRA_MIN_SLOT = 8 * 1024;          // a mirror doing even ~8 KB/s still earns a slot: bandwidth is summed
var BTRA_MAX_PIECE = 1024 * 1024;
var BTRA_MAX_BATCH = 8 * 1024 * 1024;
var BTRA_MAX_REPLY = 8 * 1024 * 1024;
var BTRA_EXACT_LIMIT = 2 * 1024 * 1024;
var BTRA_OPEN_REPLY = 2 * 1024 * 1024;
var BTRA_PIECE_TIMEOUT = 9000;
var BTRA_HEDGE_BUDGET = 4;
// 2.0.1: measured on a real phone (Los Angeles), the App's own HTTP route gave 0.8–1.3 MB/s on one
// connection while every mirror reached over HTTPS gave 2–70 KB/s, and waiting 8 s for them made the App
// stall and re-ask. Whatever cannot be put together quickly goes back to the App's own route at once.
var BTRA_DEADLINE = 2500;
var BTRA_CACHE_TTL = 10 * 60000;
var BTRA_BEHIND_KEEP = 512 * 1024;
// Automatic connection count (upstream 0.9.4.0, adapted): the ladder, where it starts, how long
// between steps, how long a step is on trial, how long a fruitless / refused level rests.
var BTRA_AUTO_LADDER = [8, 12, 16, 24, 32, 48];
var BTRA_AUTO_START = 2;
var BTRA_AUTO_STEP_MS = 2500;
var BTRA_AUTO_TRIAL_MS = 10000;
var BTRA_AUTO_WINDOW_MS = 20000;
var BTRA_AUTO_REST_MS = 90000;
var BTRA_AUTO_PUSHBACK_MS = 180000;
var BTRA_AUTO_WAIT_MS = 1500;          // the App waiting longer than this for its bytes is pressure
var BTRA_AUTO_STALL_MS = 3000;         // …longer than this, or asking again, counts as a stall
var BTRA_AUTO_GAIN = 1.1;              // a step is kept only when it made batches at least this much quicker
var BTRA_SLOW_SHARE = 12;              // a mirror under a twelfth of the fastest sits out (upstream)
var BTRA_MEASURE_TTL = 90000;          // …until its measurement is this old; then it is tried again
var BTRA_HEDGE_FASTER = 1.5;           // a hedge copy goes to a mirror measured this much faster
var BTRA_SAMPLE_FULL = 48 * 1024;      // a piece this long measures speed; shorter ones mostly RTT
var BTRA_PAIR_LIMIT = 2;               // refusals of one file before that mirror + file pair is dropped
var BTRA_PAIR_TTL = 20 * 60000;

(function btrIosAppMain() {
  "use strict";

  var request = typeof $request !== "undefined" && $request ? $request : {};
  var url = String(request.url || "");
  var startedAt = Date.now();
  var finished = false;

  /* ------------------------------------------------------------ small things */

  function header(headers, name) {
    if (!headers) return "";
    var wanted = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) return String(headers[key]);
    }
    return "";
  }

  function megabytes(value, fallback, allowOff) {
    var text = String(value === undefined || value === null ? "" : value);
    if (allowOff && /关|off|none|^0+(?:\.0+)?(?:MB)?$/i.test(text)) return 0;
    var parsed = parseFloat(text);
    return Math.round((parsed >= 0.5 && parsed <= 64 ? parsed : fallback) * 1048576);
  }

  function options() {
    var raw = typeof $argument !== "undefined" ? $argument : null;
    var map = {};
    if (raw && typeof raw === "object") map = raw;
    else if (typeof raw === "string" && raw) {
      var parts = raw.split("&");
      for (var index = 0; index < parts.length; index += 1) {
        var pair = parts[index].split("=");
        if (pair[0]) map[pair[0]] = pair.slice(1).join("=");
      }
    }
    // "自动" (the default, as upstream) or a fixed number of connections.
    var conns = parseInt(map.conns !== undefined ? map.conns : map.threads, 10);
    var fixed = conns >= 1 && conns <= 64;
    var off = function (value) { return value === false || value === "false" || value === 0 || value === "0"; };
    var token = String(map.token || "").replace(/^\s+|\s+$/g, "");
    if (/^(?:无|none|null|undefined|填你的令牌.*)$/i.test(token)) token = "";
    var repo = String(map.repo || "").replace(/^\s+|\s+$/g, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/+$/g, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) repo = BLA_DEFAULT_REPO;
    return {
      auto: !fixed,
      conns: fixed ? conns : BTRA_AUTO_LADDER[BTRA_AUTO_START],
      aheadBytes: megabytes(map.ahead, 4, true),
      cacheBytes: megabytes(map.cache, 16, true),
      overseas: /海外|overseas/i.test(String(map.cdn || "")),
      chunkReplies: !/放行|pass/i.test(String(map.openEnded || "")),
      notify: !off(map.notify),
      // "只观察（对照）": every media request goes through untouched, but is still timed and reported —
      // the baseline to compare the accelerated runs against.
      observe: /观察|observe|对照/i.test(String(map.mode || "")),
      sniff: !off(map.sniff),
      token: token,
      repo: repo,
      telemetry: !!token && !off(map.telemetry)
    };
  }

  /* ------------------------------------------------------------ who is asking, and for what */

  // Which app: the signed media address names the platform it was issued to (platform=iphone /
  // iphone_i / ipad …); the User-Agent of API calls names the app (bili-universal / bili-inter / bili-hd2).
  function appOf(agent, query) {
    var platform = (/[?&]platform=([A-Za-z0-9_]{1,16})/.exec(query || "") || /[?&]mobi_app=([A-Za-z0-9_]{1,16})/.exec(query || "") || [])[1] || "";
    var mobi = (/mobi_app\/([A-Za-z0-9_]{1,16})/.exec(agent || "") || [])[1] || "";
    var key = (platform || mobi).toLowerCase();
    var code = key === "iphone_i" || key === "android_i" ? "intl"
      : key === "iphone" || key === "android" ? "cn"
      : key === "ipad" || key === "iphone_b" || key === "android_hd" ? "hd"
      : /bstar/.test(key) ? "bstar"
      : key === "pc" || key === "html5" ? "web" : "";
    if (!code) {
      if (/bili-inter|bili-intl/i.test(agent)) code = "intl";
      else if (/bili-hd|bilibili-hd/i.test(agent)) code = "hd";
      else if (/bstar/i.test(agent)) code = "bstar";
      else if (/bili-universal|bili-blue|Bilibili Freedoooooom/i.test(agent)) code = "cn?";
      else code = "?";
    }
    return { code: code, platform: platform, mobi: mobi };
  }

  // The App's name and version from its User-Agent ("bili-inter/73300100", "Bilibili Freedoooooom/MarkII").
  function agentShort(agent) {
    var text = String(agent || "");
    var first = /^([A-Za-z][A-Za-z0-9 ._-]{0,30}\/[A-Za-z0-9._-]{1,20})/.exec(text);
    var build = /\bbuild\/(\d{4,10})/.exec(text);
    return ((first ? first[1] : text.slice(0, 32)) + (build ? " b" + build[1] : "")).slice(0, 48);
  }

  // Query parameters that say something about the route and nothing about the viewer.
  function safeQuery(query) {
    var out = {};
    var wanted = { platform: 1, os: 1, og: 1, bvc: 1, gen: 1, nettype: 1, f: 1, oi: 0, mobi_app: 1, build: 1, fnval: 1, fourk: 1, qn: 1, device: 1, cdn_type: 1 };
    var parts = String(query || "").replace(/^\?/, "").split("&");
    for (var index = 0; index < parts.length; index += 1) {
      var pair = parts[index].split("=");
      if (wanted[pair[0]]) out[pair[0]] = decodeURIComponentSafe(pair.slice(1).join("=")).slice(0, 24);
    }
    return out;
  }

  function decodeURIComponentSafe(text) {
    try { return decodeURIComponent(text); } catch (_error) { return text; }
  }

  function mediaShape(path) {
    var family = (/^\/([^/]+)\//.exec(path) || [])[1] || "";
    var ext = ((/\.([A-Za-z0-9]{2,5})$/.exec(path) || [])[1] || "").toLowerCase();
    // …-1-30080.m4s: 30080 = 1080P picture, 30280 = 192K sound (Bilibili's quality ids)
    var quality = (/-(\d{5})\.(?:m4s|mp4)$/.exec(path) || /-(\d{2,3})\.(?:mp4|flv)$/.exec(path) || [])[1] || "";
    return { family: family.slice(0, 20), ext: ext, q: quality ? Number(quality) : 0, audio: /^302\d\d$/.test(quality) };
  }

  /* ------------------------------------------------------------ text ↔ bytes */

  function utf8(text) {
    var out = [];
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); index += 1; }
      }
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return new Uint8Array(out);
  }

  // Bytes as a string of char codes 0–255: enough to find ASCII addresses inside protobuf or JSON.
  function latin1(bytes, limit) {
    var parts = [];
    var end = Math.min(bytes.length, limit || bytes.length);
    for (var index = 0; index < end; index += 8192) parts.push(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(index, Math.min(end, index + 8192)))));
    return parts.join("");
  }

  function toBytes(body) {
    if (!body) return new Uint8Array(0);
    if (typeof body === "string") return utf8(body);
    if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") return new Uint8Array(body);
    if (typeof body.subarray === "function") return body;
    return new Uint8Array(0);
  }

  function ungzip(bytes) {
    if (typeof $utils !== "undefined" && $utils && typeof $utils.ungzip === "function") return toBytes($utils.ungzip(bytes));
    throw new Error("这个 Loon 没有 $utils.ungzip");
  }

  /* ------------------------------------------------------------ live telemetry
   * Events go into a queue in the persistent store; now and then a batch is written to the private
   * GitHub repository named in the plugin's settings, as one JSON file (Contents API, PUT). The file
   * name comes from the first event in the batch, so sending the same batch twice (Loon ended the
   * script before GitHub's answer came back) cannot store it twice: GitHub refuses with 422 and that
   * counts as delivered.
   */

  function tqLoad() {
    try {
      var parsed = JSON.parse($persistentStore.read(BLA_TQ_KEY) || "null");
      if (parsed && typeof parsed === "object" && parsed.v === 1) return parsed;
    } catch (_error) {}
    var device = "";
    for (var index = 0; index < 8; index += 1) device += "abcdefghjkmnpqrstuvwxyz23456789".charAt(Math.floor(Math.random() * 31));
    return { v: 1, dev: device, seq: 0, ev: [], dropped: 0, inflight: null, lastTry: 0, okAt: 0, sent: 0, err: "", errAt: 0, liveUntil: 0, files: 0, srcOk: {} };
  }

  function tqSave(queue) {
    try { return $persistentStore.write(JSON.stringify(queue), BLA_TQ_KEY) !== false; } catch (_error) { return false; }
  }

  function tqPush(event) {
    try {
      var queue = tqLoad();
      queue.seq += 1;
      event.s = queue.seq;
      if (!event.t) event.t = Date.now();
      queue.ev.push(event);
      while (queue.ev.length > BLA_TQ_MAX) { queue.ev.shift(); queue.dropped += 1; }
      if (event.ty !== "hb") queue.liveUntil = Math.max(queue.liveUntil || 0, Date.now() + BLA_LIVE_AFTER_MS);
      tqSave(queue);
    } catch (_error) {}
  }

  function base64String(text) {
    return b64encode(utf8(text));
  }

  function pad(number, width) {
    var text = String(number);
    while (text.length < width) text = "0" + text;
    return text;
  }

  function localDay(time) {
    var date = new Date(time);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1, 2) + "-" + pad(date.getDate(), 2);
  }

  // A compact picture of the whole state, sent with every file: mirrors, connection level, cache…
  function aggregate() {
    var current = state || loadState();
    var now = Date.now();
    var nodes = [];
    for (var host in current.hosts) {
      var item = current.hosts[host];
      nodes.push([shortHost(host), Math.round((item.bps || 0) * 1000 / 1024), item.ok || 0, item.bad || 0, item.late || 0, item.until > now ? 1 : 0, item.refused || 0, item.limited || 0]);
    }
    nodes.sort(function (a, b) { return b[1] - a[1]; });
    var origins = [];
    for (var origin in current.origins) if (current.origins[origin] && typeof current.origins[origin] === "object") origins.push([origin, current.origins[origin].n]);
    origins.sort(function (a, b) { return b[1] - a[1]; });
    var cached = 0;
    for (var index = 0; index < current.cache.length; index += 1) cached += current.cache[index].b;
    var breakers = [];
    for (var name in current.breaker) if (current.breaker[name] && current.breaker[name].until > now) breakers.push(name + ": " + current.breaker[name].reason);
    var auto = current.auto || {};
    return {
      st: current.stats,
      conns: config.auto ? BTRA_AUTO_LADDER[typeof auto.lvl === "number" ? auto.lvl : BTRA_AUTO_START] : config.conns,
      autoWhy: auto.why || "",
      nodes: nodes.slice(0, 16),
      origins: origins.slice(0, 10),
      cache: [current.cache.length, Math.round(cached / 1024), current.flags.cacheOff || "", current.flags.storeTest ? (current.flags.storeTest.ok ? 1 : 0) : -1],
      breakers: breakers
    };
  }

  function configSummary() {
    return { mode: config.observe ? "observe" : "accel", conns: config.auto ? "auto" : config.conns, ahead: Math.round(config.aheadBytes / 1048576), cache: Math.round(config.cacheBytes / 1048576),
      cdn: config.overseas ? "overseas" : "mainland", open: config.chunkReplies ? "chunk" : "pass", sniff: config.sniff ? 1 : 0 };
  }

  // Writes the next batch (or a heartbeat) to GitHub. `src` says which entry point sent it — which
  // ones manage to deliver before Loon ends the script is itself something we want to learn.
  // done(ok, note) is called when GitHub answered (if Loon lets the script live that long).
  function telemetryFlush(src, force, done) {
    var finishFlush = function (ok, note) { if (done) { var callback = done; done = null; try { callback(ok, note); } catch (_error) {} } };
    if (!config.telemetry) { finishFlush(false, config.token ? "遥测已关闭" : "没有填遥测令牌"); return false; }
    var queue = tqLoad();
    var now = Date.now();
    if (!force && now - (queue.lastTry || 0) < BLA_FLUSH_MIN_MS) { finishFlush(false, "刚上报过"); return false; }
    var batch = null;
    if (queue.inflight && now - queue.inflight.at < 10 * 60000) batch = queue.inflight;
    else if (queue.ev.length) {
      var last = queue.ev[Math.min(queue.ev.length, BLA_BATCH_EVENTS) - 1].s;
      batch = { a: queue.ev[0].s, b: last, at: now, day: localDay(queue.ev[0].t || now) };
    }
    var heartbeat = !batch;
    if (heartbeat && !force && !(now < (queue.liveUntil || 0))) { finishFlush(false, "不在实时诊断时段"); return false; }
    var events = [];
    if (batch) for (var index = 0; index < queue.ev.length; index += 1) if (queue.ev[index].s >= batch.a && queue.ev[index].s <= batch.b) events.push(queue.ev[index]);
    if (batch && !events.length) { queue.inflight = null; tqSave(queue); batch = null; heartbeat = true; }
    var path = heartbeat ? "live/" + queue.dev + "/" + localDay(now) + "/hb-" + now + ".json" : "live/" + queue.dev + "/" + batch.day + "/" + pad(batch.a, 7) + ".json";
    var payload = {
      v: 1, app: "bili-loon-accel", ver: BTRA_VERSION, dev: queue.dev, src: src, sent: now, loon: typeof $loon !== "undefined" ? String($loon).slice(0, 80) : "",
      cfg: configSummary(), seq: batch ? [batch.a, batch.b] : null, dropped: queue.dropped || 0, pending: queue.ev.length,
      tq: { okAt: queue.okAt || 0, err: queue.err || "", srcOk: queue.srcOk || {} },
      ev: events, agg: aggregate()
    };
    queue.lastTry = now;
    if (batch) queue.inflight = batch;
    tqSave(queue);
    var body;
    try {
      body = JSON.stringify({ message: (heartbeat ? "hb " : "ev " + batch.a + "-" + batch.b + " ") + queue.dev + " " + src, content: base64String(JSON.stringify(payload)) });
    } catch (error) { finishFlush(false, "打包失败 " + String(error && error.message || error)); return false; }
    try {
      $httpClient.put({
        url: "https://api.github.com/repos/" + config.repo + "/contents/" + path,
        headers: {
          Authorization: "Bearer " + config.token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bili-loon-accel/" + BTRA_VERSION,
          "Content-Type": "application/json"
        },
        body: body,
        timeout: 9000
      }, function (error, response) {
        var status = response ? Number(response.status) : 0;
        var fresh = tqLoad();
        var ok = status === 200 || status === 201 || (status === 422 && !heartbeat);
        if (ok) {
          if (batch) {
            fresh.ev = fresh.ev.filter(function (event) { return event.s > batch.b; });
            if (fresh.inflight && fresh.inflight.a === batch.a) fresh.inflight = null;
            fresh.sent = (fresh.sent || 0) + events.length;
          }
          fresh.okAt = Date.now();
          fresh.files = (fresh.files || 0) + 1;
          fresh.err = "";
          fresh.srcOk = fresh.srcOk || {};
          fresh.srcOk[src] = (fresh.srcOk[src] || 0) + 1;
        } else {
          fresh.err = status === 401 ? "401：令牌无效或已过期" : status === 403 ? "403：令牌没有这个仓库的写权限（Contents: Read and write），或被 GitHub 限流"
            : status === 404 ? "404：仓库 " + config.repo + " 不存在，或令牌看不到它" : status ? "HTTP " + status : "网络错误 " + String(error || "");
          fresh.errAt = Date.now();
        }
        tqSave(fresh);
        finishFlush(ok, ok ? (heartbeat ? "心跳已送达" : events.length + " 条记录已送达") : fresh.err);
      });
    } catch (error) {
      finishFlush(false, "发送失败 " + String(error && error.message || error));
      return false;
    }
    return true;
  }

  function parseContentRange(value) {
    var match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || "").replace(/^\s+|\s+$/g, ""));
    if (!match) return null;
    return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
  }

  function sizeText(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function shortHost(host) {
    return String(host).replace(/\.bilivideo\.com$/, "");
  }

  function pathKeyOf(path) {
    var hash = 2166136261;
    for (var index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36) + ":" + path.slice(-16).replace(/[^A-Za-z0-9._-]/g, "");
  }

  /* ------------------------------------------------------------ base64
   * The persistent store keeps strings, so cached bytes travel as base64. Written by hand: the
   * script runtime has neither atob/btoa nor Buffer.
   */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64_CODES = null;
  var B64_REVERSE = null;

  function b64tables() {
    if (B64_CODES) return;
    B64_CODES = new Uint8Array(64);
    B64_REVERSE = new Uint8Array(256);
    for (var index = 0; index < 64; index += 1) {
      B64_CODES[index] = B64.charCodeAt(index);
      B64_REVERSE[B64.charCodeAt(index)] = index;
    }
  }

  function b64encode(bytes) {
    b64tables();
    var length = bytes.length;
    var full = length - (length % 3);
    var parts = [];
    var codes = [];
    var index = 0;
    while (index < full) {
      var b0 = bytes[index], b1 = bytes[index + 1], b2 = bytes[index + 2];
      codes.push(B64_CODES[b0 >> 2], B64_CODES[((b0 & 3) << 4) | (b1 >> 4)], B64_CODES[((b1 & 15) << 2) | (b2 >> 6)], B64_CODES[b2 & 63]);
      index += 3;
      if (codes.length >= 32768) { parts.push(String.fromCharCode.apply(null, codes)); codes = []; }
    }
    if (index < length) {
      var c0 = bytes[index], c1 = index + 1 < length ? bytes[index + 1] : 0;
      codes.push(B64_CODES[c0 >> 2], B64_CODES[((c0 & 3) << 4) | (c1 >> 4)], index + 1 < length ? B64_CODES[(c1 & 15) << 2] : 61, 61);
    }
    if (codes.length) parts.push(String.fromCharCode.apply(null, codes));
    return parts.join("");
  }

  function b64decode(text) {
    b64tables();
    var length = text.length;
    while (length > 0 && text.charCodeAt(length - 1) === 61) length -= 1;
    var out = new Uint8Array(Math.floor(length * 3 / 4));
    var o = 0;
    var index = 0;
    while (index + 4 <= length) {
      var a = B64_REVERSE[text.charCodeAt(index)], b = B64_REVERSE[text.charCodeAt(index + 1)];
      var c = B64_REVERSE[text.charCodeAt(index + 2)], d = B64_REVERSE[text.charCodeAt(index + 3)];
      out[o] = (a << 2) | (b >> 4);
      out[o + 1] = ((b & 15) << 4) | (c >> 2);
      out[o + 2] = ((c & 3) << 6) | d;
      o += 3;
      index += 4;
    }
    if (index < length) {
      var a2 = B64_REVERSE[text.charCodeAt(index)], b2 = B64_REVERSE[text.charCodeAt(index + 1)];
      out[o] = (a2 << 2) | (b2 >> 4);
      o += 1;
      if (index + 2 < length) { out[o] = ((b2 & 15) << 4) | (B64_REVERSE[text.charCodeAt(index + 2)] >> 2); o += 1; }
    }
    return o === out.length ? out : out.subarray(0, o);
  }

  /* ------------------------------------------------------------ state
   * Several copies of this script run at the same time (picture and sound are separate requests),
   * each in its own JavaScript context. They share one JSON record in Loon's store. A run decides
   * on the snapshot it read at the start, notes every change it makes as an operation, and replays
   * those operations on a freshly read record right before it ends, so that runs do not wipe out
   * each other's counters. Cached bytes live under their own keys; the record only lists them.
   */

  function emptyState() {
    return { v: 2, since: Date.now(), rr: 0, totals: {}, hosts: {}, recent: [], breaker: {}, streaks: {}, notes: {}, stats: {}, cache: [], heads: {}, flags: {}, runs: [], auto: {}, autoS: [], pairs: {}, origins: {}, sniffs: [] };
  }

  function loadState() {
    try {
      var parsed = JSON.parse($persistentStore.read(BTRA_STORE_KEY) || "null");
      if (parsed && typeof parsed === "object" && parsed.v === 2) {
        var base = emptyState();
        for (var key in base) if (parsed[key] === undefined || parsed[key] === null) parsed[key] = base[key];
        return parsed;
      }
    } catch (_error) {}
    return emptyState();
  }

  function hostRecord(state, host) {
    return state.hosts[host] || (state.hosts[host] = { ok: 0, bad: 0, late: 0, streak: 0, lateStreak: 0, until: 0, benches: 0, bps: 0, at: 0, refused: 0, limited: 0 });
  }

  function apply(state, op) {
    var kind = op[0];
    if (kind === "bump") state.stats[op[1]] = (state.stats[op[1]] || 0) + op[2];
    else if (kind === "set") state.stats[op[1]] = op[2];
    else if (kind === "ewma") state.stats[op[1]] = state.stats[op[1]] ? state.stats[op[1]] * 0.7 + op[2] * 0.3 : op[2];
    else if (kind === "rr") state.rr = ((state.rr || 0) + 1) % 1000000;
    else if (kind === "total") state.totals[op[1]] = { size: op[2], t: op[3], type: op[4] || "" };
    else if (kind === "recent") state.recent.push(op[1]);
    else if (kind === "rdone") {
      for (var recentIndex = state.recent.length - 1; recentIndex >= 0; recentIndex -= 1) {
        var seenEntry = state.recent[recentIndex];
        if (seenEntry.p === op[1] && seenEntry.s === op[2] && seenEntry.t === op[3]) { seenEntry.o = op[4]; seenEntry.ms = op[5]; if (op[6] >= 0) seenEntry.x = op[6]; break; }
      }
    }
    else if (kind === "late") {
      // A "late" mark only means this mirror is slow right now — which, over a congested overseas
      // link, is true of nearly all of them. A slow mirror still adds bandwidth, so lateness must
      // never bench it or knock down its measured speed (doing so used to snowball: every mirror
      // slow -> every mirror marked late -> speeds crushed toward zero -> the fastest ones benched
      // -> even less bandwidth). We only count it, for the status page. Real speed is learned from
      // what actually arrives (the "host" op), and only hard failures rest a mirror.
      var lateHost = hostRecord(state, op[1]);
      lateHost.late = (lateHost.late || 0) + 1;
      lateHost.lateStreak = (lateHost.lateStreak || 0) + 1;
    }
    else if (kind === "breaker") state.breaker[op[1]] = op[2];
    else if (kind === "streak") state.streaks[op[1]] = op[2] === null ? 0 : (state.streaks[op[1]] || 0) + op[2];
    else if (kind === "note") state.notes[op[1]] = op[2];
    else if (kind === "flag") state.flags[op[1]] = op[2];
    else if (kind === "run") { state.runs.push(op[1]); while (state.runs.length > 12) state.runs.shift(); }
    else if (kind === "sniff") { state.sniffs.push(op[1]); while (state.sniffs.length > 8) state.sniffs.shift(); }
    else if (kind === "min") state.stats[op[1]] = state.stats[op[1]] ? Math.min(state.stats[op[1]], op[2]) : op[2];
    else if (kind === "max") state.stats[op[1]] = Math.max(state.stats[op[1]] || 0, op[2]);
    else if (kind === "head") state.heads[op[1]] = { pos: op[2], t: op[3] };
    else if (kind === "cadd") state.cache.push(op[1]);
    else if (kind === "cdel") state.cache = state.cache.filter(function (entry) { return entry.k !== op[1]; });
    else if (kind === "auto") {
      // op[2]: the version of the record this run's decision was based on (every write gets a new,
      // unique one). If another run (the other stream) wrote in between, its decision stands; this
      // run only adds the levels it rested, and a push-back (op[3] === "down") still lowers the level.
      var current = state.auto || {};
      var incoming = op[1];
      if ((current.v || "") === (op[2] || "")) state.auto = incoming;
      else {
        var merged = { v: incoming.v + "m", lvl: current.lvl, at: current.at, why: current.why, trial: current.trial || null, rest: {}, log: (current.log || []).slice(), steps: current.steps || 0 };
        for (var mine in current.rest || {}) merged.rest[mine] = current.rest[mine];
        for (var theirs in incoming.rest || {}) {
          var had = merged.rest[theirs], add = incoming.rest[theirs];
          if (!had || (add.hard && !had.hard) || (add.hard === had.hard && add.until > had.until)) merged.rest[theirs] = add;
        }
        if (op[3] === "down" && typeof merged.lvl === "number" && incoming.lvl < merged.lvl) {
          merged.lvl = incoming.lvl; merged.trial = null; merged.at = incoming.at; merged.why = incoming.why;
          var lastStep = incoming.log && incoming.log[incoming.log.length - 1];
          if (lastStep) merged.log.push(lastStep);
          while (merged.log.length > 8) merged.log.shift();
          merged.steps += 1;
        }
        state.auto = merged;
      }
    }
    else if (kind === "asample") {
      state.autoS.push(op[1]);
      while (state.autoS.length > 40 || (state.autoS.length && op[1].t - state.autoS[0].t > 60000)) state.autoS.shift();
    }
    else if (kind === "origin") {
      var seenOrigin = state.origins[op[1]];
      state.origins[op[1]] = { n: (seenOrigin && seenOrigin.n || 0) + 1, t: op[2] };
    }
    else if (kind === "refused") {
      // This mirror serves other files but refused this one: only the pair is counted against.
      var refusing = hostRecord(state, op[1]);
      refusing.refused = (refusing.refused || 0) + 1;
      var pairKey = op[1] + " " + op[2];
      var pair = state.pairs[pairKey];
      state.pairs[pairKey] = { n: (pair && op[3] - pair.t < BTRA_PAIR_TTL ? pair.n : 0) + 1, t: op[3] };
    }
    else if (kind === "probe") { var probed = hostRecord(state, op[1]); if (probed.bps > 0) probed.at = op[2]; }
    else if (kind === "limited") {
      // op[3]: how many connections the mirror was carrying for us when it said no — what it
      // tolerates, for a while (0: it refused even a single one).
      var limitedHost = hostRecord(state, op[1]);
      limitedHost.limited = (limitedHost.limited || 0) + 1;
      if (op[3] > 0) { limitedHost.cap = op[3]; limitedHost.capAt = op[2]; }
    }
    else if (kind === "host") {
      var item = hostRecord(state, op[1]);
      if (op[2]) {
        item.ok += 1; item.streak = 0; item.lateStreak = 0; item.until = 0; item.benches = 0;
        // A first sample from a short piece is mostly round trip: it gives a speed to start from, but
        // not one to leave the mirror out on (it stays "old", so a slow-looking mirror is re-probed
        // with an ordinary piece first).
        if (op[5] >= BTRA_SAMPLE_FULL || item.bps > 0 || !(op[5] > 0)) item.at = op[3];
        // A short piece is mostly round trip and would mark the mirror down: its sample counts for
        // less the shorter it is (upstream ignores transfers under 48 KB for the same reason).
        var weight = 0.3 * (op[5] > 0 ? Math.min(1, op[5] / BTRA_SAMPLE_FULL) : 1);
        if (op[4] > 0) item.bps = item.bps ? item.bps * (1 - weight) + op[4] * weight : op[4];
      } else {
        item.bad += 1;
        item.streak += 1;
        // Only a mirror that keeps failing outright is rested (dead host, wrong signature, 403).
        // Three in a row, because over a congested link the odd timeout is normal and does not mean
        // the mirror is useless. Rest 3 minutes, then 9, capped at half an hour, and one success
        // clears it — we would rather keep a flaky mirror contributing than lose its bandwidth.
        if (item.streak >= 3 && !(item.until > op[3])) {
          item.benches = (item.benches || 0) + 1;
          item.until = op[3] + Math.min(30, 3 * Math.pow(3, item.benches - 1)) * 60000;
        }
      }
    }
  }

  var state = null;
  var ops = [];
  var config = options();

  function change() {
    var op = Array.prototype.slice.call(arguments);
    ops.push(op);
    apply(state, op);
  }

  function evict(fresh, now) {
    var cap = config.cacheBytes;
    var keep = [];
    var dropped = [];
    for (var index = 0; index < fresh.cache.length; index += 1) {
      var entry = fresh.cache[index];
      var head = fresh.heads[entry.p];
      var stale = !(now - entry.t <= BTRA_CACHE_TTL);
      var behind = head && entry.e < head.pos - BTRA_BEHIND_KEEP;
      if (stale || behind || !cap) dropped.push(entry); else keep.push(entry);
    }
    keep.sort(function (a, b) { return a.t - b.t; });
    var total = 0;
    for (var k = 0; k < keep.length; k += 1) total += keep[k].b;
    while (total > cap && keep.length) { var oldest = keep.shift(); total -= oldest.b; dropped.push(oldest); }
    fresh.cache = keep;
    return dropped;
  }

  function commit() {
    if (!ops.length) return;
    try {
      var fresh = loadState();
      for (var index = 0; index < ops.length; index += 1) apply(fresh, ops[index]);
      ops = [];
      var now = Date.now();
      fresh.recent = fresh.recent.filter(function (entry) { return now - entry.t <= 120000; }).slice(-40);
      var names = [];
      for (var key in fresh.totals) names.push(key);
      if (names.length > 80) {
        names.sort(function (a, b) { return fresh.totals[a].t - fresh.totals[b].t; });
        for (var cut = 0; cut < names.length - 60; cut += 1) delete fresh.totals[names[cut]];
      }
      var heads = [];
      for (var headKey in fresh.heads) heads.push(headKey);
      if (heads.length > 24) {
        heads.sort(function (a, b) { return fresh.heads[a].t - fresh.heads[b].t; });
        for (var drop = 0; drop < heads.length - 16; drop += 1) delete fresh.heads[heads[drop]];
      }
      var pairNames = [];
      for (var pairName in fresh.pairs) {
        if (!(now - fresh.pairs[pairName].t < BTRA_PAIR_TTL)) delete fresh.pairs[pairName];
        else pairNames.push(pairName);
      }
      if (pairNames.length > 80) {
        pairNames.sort(function (a, b) { return fresh.pairs[a].t - fresh.pairs[b].t; });
        for (var pairCut = 0; pairCut < pairNames.length - 60; pairCut += 1) delete fresh.pairs[pairNames[pairCut]];
      }
      var originNames = [];
      for (var originName in fresh.origins) {
        if (typeof fresh.origins[originName] !== "object") delete fresh.origins[originName];
        else originNames.push(originName);
      }
      if (originNames.length > 16) {
        // the most recently seen ones stay
        originNames.sort(function (a, b) { return fresh.origins[b].t - fresh.origins[a].t; });
        for (var originCut = 12; originCut < originNames.length; originCut += 1) delete fresh.origins[originNames[originCut]];
      }
      // Fuses and failure streaks are kept per origin host; with every regional node decrypted
      // there can be many of them. Expired fuses and cleared streaks go.
      for (var fuse in fresh.breaker) if (!(fresh.breaker[fuse] && fresh.breaker[fuse].until > now)) delete fresh.breaker[fuse];
      var streakNames = [];
      for (var streakName in fresh.streaks) {
        if (!fresh.streaks[streakName]) delete fresh.streaks[streakName];
        else streakNames.push(streakName);
      }
      for (var streakCut = 0; streakCut < streakNames.length - 40; streakCut += 1) delete fresh.streaks[streakNames[streakCut]];
      var dropped = evict(fresh, now);
      $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
      for (var d = 0; d < dropped.length; d += 1) {
        try { $persistentStore.write("", BTRA_CACHE_PREFIX + dropped[d].k); } catch (_error) {}
      }
    } catch (_error) {}
  }

  // The record of this run for the live telemetry (media runs fill it in as they go).
  var ev = null;

  function finish(result) {
    if (finished) return;
    finished = true;
    commit();
    busyClear();
    if (ev) {
      if (!ev.ms) ev.ms = Date.now() - startedAt;
      tqPush(ev);
    }
    $done(result);
  }

  var currentKey = null;
  var currentStart = 0;
  var currentAsked = 0;
  var runId = startedAt.toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  var busyNoted = false;

  function busyNote(hosts) {
    try {
      var busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {};
      var now = Date.now();
      for (var index = 0; index < hosts.length; index += 1) {
        var stamps = (busy[hosts[index]] || []).filter(function (stamp) { return stamp.r !== runId && now - stamp.t < BTRA_BUSY_MS; });
        stamps.push({ t: now, r: runId });
        busy[hosts[index]] = stamps;
      }
      for (var host in busy) if (!busy[host].length) delete busy[host];
      $persistentStore.write(JSON.stringify(busy), BTRA_BUSY_KEY);
      busyNoted = true;
    } catch (_error) {}
  }

  function busyClear() {
    if (!busyNoted) return;
    try {
      var busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {};
      var now = Date.now();
      for (var host in busy) {
        busy[host] = busy[host].filter(function (stamp) { return stamp.r !== runId && now - stamp.t < BTRA_BUSY_MS; });
        if (!busy[host].length) delete busy[host];
      }
      $persistentStore.write(JSON.stringify(busy), BTRA_BUSY_KEY);
    } catch (_error) {}
  }

  function passThrough(reason, kind) {
    if (ev) { ev.k = kind || "pass"; ev.r = String(reason || "").slice(0, 60); }
    change("bump", "passed", 1);
    if (reason) change("set", "lastPass", reason);
    if (currentKey !== null) change("rdone", currentKey, currentStart, startedAt, "pass", Date.now() - startedAt);
    change("run", { k: "pass", a: currentAsked, ms: Date.now() - startedAt, r: reason || "" });
    finish({});
  }

  function notifyOnce(key, everyMs, title, subtitle, body) {
    if (!config.notify) return;
    var now = Date.now();
    if (state.notes[key] && now - state.notes[key] < everyMs) return;
    change("note", key, now);
    try { $notification.post(title, subtitle, body); } catch (_error) {}
  }

  /* ------------------------------------------------------------ automatic connection count
   * Upstream's rule (0.9.4.0), fed with what an App-mode run can see. The browser version climbs when
   * the player stalls or its buffer stops growing; here the signs are the App waiting for its own
   * bytes (a batch whose App part took over BTRA_AUTO_WAIT_MS is pressure; over BTRA_AUTO_STALL_MS,
   * or the App asking for the same position again while the last answer was slow or still pending,
   * is a stall). Throughput is what full batches delivered per millisecond. It all lives in the
   * shared record, so picture and sound, and every later run, climb the same ladder.
   */

  function autoLevel() {
    var level = state.auto && typeof state.auto.lvl === "number" ? state.auto.lvl : BTRA_AUTO_START;
    return level >= 0 && level < BTRA_AUTO_LADDER.length ? level : BTRA_AUTO_START;
  }

  // A private copy of the automatic state to change and write back as a whole (last writer wins —
  // the two streams would compute the same step anyway).
  function autoCopy(now) {
    var current = state.auto || {};
    var rest = {};
    for (var level in current.rest || {}) if (current.rest[level] && current.rest[level].until > now) rest[level] = current.rest[level];
    var trial = null;
    if (current.trial) trial = { from: current.trial.from, to: current.trial.to, at: current.trial.at, base: current.trial.base, stalled: !!current.trial.stalled };
    return { v: current.v || "", lvl: autoLevel(), at: current.at || 0, why: current.why || "", trial: trial, rest: rest, log: (current.log || []).slice(-7), steps: current.steps || 0 };
  }

  // Writes the automatic state back, noting which version of it this run's decision was based on
  // (see the "auto" op). kind "down": a push-back, which must survive the other stream's write.
  var autoWrites = 0;
  function autoWrite(next, kind) {
    var basedOn = state.auto && state.auto.v || "";
    autoWrites += 1;
    next.v = runId + "." + autoWrites;
    change("auto", next, basedOn, kind || "");
  }

  function autoSet(next, now, why, kind) {
    next.at = now;
    next.why = why;
    next.steps += 1;
    next.log.push({ t: now, n: BTRA_AUTO_LADDER[next.lvl], m: why });
    while (next.log.length > 8) next.log.shift();
    autoWrite(next, kind);
  }

  // Bytes per millisecond that full batches at this level delivered between two moments.
  function autoThroughput(level, from, to) {
    var bytes = 0;
    var ms = 0;
    var count = 0;
    for (var index = 0; index < state.autoS.length; index += 1) {
      var sample = state.autoS[index];
      if (sample.l === level && sample.t >= from && sample.t <= to) { bytes += sample.b; ms += sample.ms; count += 1; }
    }
    return { bps: ms > 0 ? bytes / ms : 0, count: count };
  }

  // Every step up is a trial. After BTRA_AUTO_TRIAL_MS the full batches since must be clearly quicker
  // than the ones before it (BTRA_AUTO_GAIN: batch speeds are noisy, and "as quick as before" would
  // let noise walk the count up the ladder), otherwise the step is taken back and that level rests
  // for a while. Too few full batches meanwhile (the App had enough), or a stall during the trial,
  // prove nothing: the level stays.
  function autoJudge(now) {
    var trial = state.auto && state.auto.trial;
    if (!config.auto || !trial || now - trial.at < BTRA_AUTO_TRIAL_MS) return;
    var next = autoCopy(now);
    next.trial = null;
    var after = autoThroughput(trial.to, trial.at, now);
    if (trial.stalled || after.count < 2 || !(trial.base > 0) || after.bps >= trial.base * BTRA_AUTO_GAIN) { autoWrite(next); return; }
    next.lvl = trial.from;
    next.rest[trial.to] = { until: now + BTRA_AUTO_REST_MS, hard: false };
    autoSet(next, now, BTRA_AUTO_LADDER[trial.to] + " 条没有比 " + BTRA_AUTO_LADDER[trial.from] + " 条更快，退回");
  }

  // One level up. A level resting after a refusal (412 / 429) caps the climb; one resting after a
  // fruitless trial is skipped only on a stall.
  function autoUp(now, why, strong) {
    if (!config.auto) return false;
    var next = autoCopy(now);
    if (strong && next.trial && !next.trial.stalled) next.trial.stalled = true;
    if (now - next.at < BTRA_AUTO_STEP_MS) {
      if (strong && next.trial && !(state.auto.trial && state.auto.trial.stalled)) autoWrite(next);
      return false;
    }
    var here = next.rest[next.lvl];
    if (here && here.hard) return false;
    // Pressure alone moves only a level that has shown what it does (a full batch since it was set),
    // so that every trial has a baseline to beat, and not while a step is still on trial — each step
    // gets judged. A stall moves at once.
    if (!strong && autoThroughput(next.lvl, next.at, now).count < 1) return false;
    if (!strong && next.trial && !next.trial.stalled && now - next.trial.at < BTRA_AUTO_TRIAL_MS) return false;
    var target = next.lvl + 1;
    while (target < BTRA_AUTO_LADDER.length && next.rest[target]) {
      if (next.rest[target].hard || !strong) return false;
      target += 1;
    }
    if (target >= BTRA_AUTO_LADDER.length) return false;
    // The baseline: full batches at this level lately; failing that, any at this level; failing that,
    // the running average over all batches. (A step without a baseline could never be judged.)
    var base = autoThroughput(next.lvl, now - BTRA_AUTO_WINDOW_MS, now).bps || autoThroughput(next.lvl, 0, now).bps || state.stats.bps || 0;
    next.trial = { from: next.lvl, to: target, at: now, base: base, stalled: false };
    next.lvl = target;
    autoSet(next, now, why);
    return true;
  }

  // A mirror refused the load: one level down, and this level rests (hard) for a while.
  function autoPushback(now, status) {
    if (!config.auto) return;
    var next = autoCopy(now);
    next.rest[next.lvl] = { until: now + BTRA_AUTO_PUSHBACK_MS, hard: true };
    next.trial = null;
    if (next.lvl > 0) {
      next.lvl -= 1;
      autoSet(next, now, "节点返回 " + status + "（限流），退一档", "down");
    } else autoWrite(next, "down");
  }

  /* ------------------------------------------------------------ cache entries */

  function cacheEntries(pathKey, from, to) {
    var list = [];
    for (var index = 0; index < state.cache.length; index += 1) {
      var entry = state.cache[index];
      if (entry.p === pathKey && entry.e >= from && entry.s <= to) list.push(entry);
    }
    list.sort(function (a, b) { return a.s - b.s; });
    return list;
  }

  function readEntry(entry) {
    try {
      var text = $persistentStore.read(BTRA_CACHE_PREFIX + entry.k);
      if (typeof text !== "string" || !text) return null;
      var bytes = b64decode(text);
      if (bytes.length !== entry.b) return null;
      return bytes;
    } catch (_error) { return null; }
  }

  // Splits [from, to] into segments that are in the cache (with their bytes loaded) and gaps.
  function coverage(pathKey, from, to, load) {
    var segments = [];
    var cursor = from;
    var entries = cacheEntries(pathKey, from, to);
    for (var index = 0; index < entries.length && cursor <= to; index += 1) {
      var entry = entries[index];
      if (entry.e < cursor) continue;
      var bytes = null;
      if (load) {
        bytes = readEntry(entry);
        if (!bytes) { change("cdel", entry.k); continue; }
      }
      if (entry.s > cursor) segments.push({ s: cursor, e: Math.min(entry.s - 1, to), entry: null });
      var s = Math.max(entry.s, cursor);
      var e = Math.min(entry.e, to);
      segments.push({ s: s, e: e, entry: entry, bytes: bytes ? bytes.subarray(s - entry.s, e - entry.s + 1) : null });
      cursor = e + 1;
    }
    if (cursor <= to) segments.push({ s: cursor, e: to, entry: null });
    return segments;
  }

  function contiguousCachedEnd(pathKey, from) {
    var cursor = from - 1;
    var entries = cacheEntries(pathKey, from, from + BTRA_MAX_REPLY);
    for (var index = 0; index < entries.length; index += 1) {
      if (entries[index].s > cursor + 1) break;
      if (entries[index].e > cursor) cursor = entries[index].e;
    }
    return cursor;
  }

  function storeEntry(pathKey, start, bytes) {
    var key = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    var encoded = b64encode(bytes);
    var wrote = $persistentStore.write(encoded, BTRA_CACHE_PREFIX + key);
    if (wrote === false) return false;
    change("cadd", { k: key, p: pathKey, s: start, e: start + bytes.length - 1, b: bytes.length, t: Date.now() });
    return true;
  }

  // Once: can the store take a megabyte, and how long does it take? Decides whether caching is used.
  function storeSelfTest() {
    if (state.flags.storeTest) return;
    var result = { ok: false, at: Date.now() };
    try {
      var probe = new Uint8Array(1048576);
      for (var index = 0; index < probe.length; index += 1) probe[index] = (Math.imul(index, 2654435761) >>> 24) & 255;
      var t0 = Date.now();
      var encoded = b64encode(probe);
      var t1 = Date.now();
      var wrote = $persistentStore.write(encoded, BTRA_CACHE_PREFIX + "selftest");
      var t2 = Date.now();
      var back = $persistentStore.read(BTRA_CACHE_PREFIX + "selftest");
      var t3 = Date.now();
      var decoded = typeof back === "string" && back.length === encoded.length ? b64decode(back) : null;
      var t4 = Date.now();
      var same = !!decoded && decoded.length === probe.length;
      for (var check = 0; same && check < probe.length; check += 4099) if (decoded[check] !== probe[check]) same = false;
      result = { ok: wrote !== false && same, encMs: t1 - t0, writeMs: t2 - t1, readMs: t3 - t2, decMs: t4 - t3, at: Date.now() };
      try { $persistentStore.write("", BTRA_CACHE_PREFIX + "selftest"); } catch (_error) {}
    } catch (error) {
      result.error = String(error && error.message || error);
    }
    change("flag", "storeTest", result);
    if (!result.ok) change("flag", "cacheOff", "存储自检没通过");
  }

  /* ------------------------------------------------------------ status page */

  function appName(code) {
    return { intl: "国际版", cn: "国内版", "cn?": "国内版?", hd: "HD 版", bstar: "Bstar", web: "网页", "?": "未知" }[code] || code;
  }

  function kbps(bytesPerMs) {
    return Math.round((bytesPerMs || 0) * 1000 / 1024);
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function average(sum, count) {
    return count ? Math.round(sum / count) : 0;
  }

  function statusPage() {
    if (/[?&]reset=1(?:&|$)/.test(url)) {
      try {
        var old = loadState();
        for (var index = 0; index < old.cache.length; index += 1) $persistentStore.write("", BTRA_CACHE_PREFIX + old.cache[index].k);
        $persistentStore.write(JSON.stringify(emptyState()), BTRA_STORE_KEY);
      } catch (_error) {}
    }
    var current = loadState();
    var stats = current.stats;
    var now = Date.now();
    var breakers = [];
    for (var name in current.breaker) {
      if (current.breaker[name] && current.breaker[name].until > now) {
        breakers.push(escapeHtml(name.replace(/^origin:/, "") + "：" + current.breaker[name].reason + "（还剩 " + Math.ceil((current.breaker[name].until - now) / 60000) + " 分钟）"));
      }
    }
    var hosts = [];
    var liveHosts = 0;
    var benchedHosts = 0;
    var slowCount = 0;
    var aggBps = 0;
    var topBps = 0;
    for (var fastest in current.hosts) if (!(current.hosts[fastest].until > now) && current.hosts[fastest].bps > topBps) topBps = current.hosts[fastest].bps;
    var hostNames = [];
    for (var hostName in current.hosts) hostNames.push(hostName);
    hostNames.sort(function (a, b) { return (current.hosts[b].bps || 0) - (current.hosts[a].bps || 0); });
    for (var hn = 0; hn < hostNames.length; hn += 1) {
      var host = hostNames[hn];
      var item = current.hosts[host];
      var slow = !(item.until > now) && item.bps > 0 && item.bps < topBps / BTRA_SLOW_SHARE && now - (item.at || 0) < BTRA_MEASURE_TTL;
      if (item.until > now) benchedHosts += 1;
      else if (slow) slowCount += 1;
      else if (item.bps > 0) { liveHosts += 1; aggBps += item.bps; }
      hosts.push(escapeHtml(shortHost(host) + "：成功 " + (item.ok || 0) + " / 失败 " + (item.bad || 0) + " / 迟到 " + (item.late || 0) +
        (item.refused ? " / 拒绝单个视频 " + item.refused : "") + (item.limited ? " / 限流 " + item.limited : "") +
        (item.bps ? " · " + Math.round(item.bps * 1000 / 1024) + " KB/s" : "") + (item.until > now ? "（停用中）" : slow ? "（太慢，暂不用）" : "")));
    }
    var pairCount = 0;
    for (var pairName in current.pairs) if (current.pairs[pairName].n >= BTRA_PAIR_LIMIT && now - current.pairs[pairName].t < BTRA_PAIR_TTL) pairCount += 1;
    var hostSummary = "在用 " + liveHosts + " 个镜像 · 合计约 " + Math.round(aggBps * 1000 / 1024) + " KB/s" + (benchedHosts ? " · 停用 " + benchedHosts + " 个" : "") +
      (slowCount ? " · 太慢暂不用 " + slowCount + " 个" : "") + (pairCount ? " · 只对个别视频停用 " + pairCount + " 对" : "");
    // Automatic connection count: where it is, why, and the last few steps.
    var autoInfo = current.auto || {};
    var autoLvl = typeof autoInfo.lvl === "number" && autoInfo.lvl >= 0 && autoInfo.lvl < BTRA_AUTO_LADDER.length ? autoInfo.lvl : BTRA_AUTO_START;
    var connsText;
    if (!config.auto) connsText = "固定 " + config.conns + " 条（插件参数里选“自动”可以让它自己调）";
    else {
      connsText = "自动 · 现在 " + BTRA_AUTO_LADDER[autoLvl] + " 条" + (autoInfo.why ? "（" + autoInfo.why + "）" : "（起步）");
      if (autoInfo.trial && now - autoInfo.trial.at < BTRA_AUTO_TRIAL_MS * 3) connsText += " · 正在试 " + BTRA_AUTO_LADDER[autoInfo.trial.to] + " 条是否更快";
      var resting = [];
      for (var restLevel in autoInfo.rest || {}) if (autoInfo.rest[restLevel].until > now) resting.push(BTRA_AUTO_LADDER[restLevel] + " 条" + (autoInfo.rest[restLevel].hard ? "（被限流）" : "") + "休息 " + Math.ceil((autoInfo.rest[restLevel].until - now) / 1000) + " 秒");
      if (resting.length) connsText += " · " + resting.join("、");
      var steps = (autoInfo.log || []).slice().reverse();
      for (var st = 0; st < steps.length; st += 1) if (steps[st] && steps[st].t) connsText += "\n" + new Date(steps[st].t).toLocaleTimeString() + " → " + steps[st].n + " 条：" + steps[st].m;
    }
    var originList = [];
    for (var originName in current.origins) originList.push(originName);
    originList = originList.filter(function (name) { return current.origins[name] && typeof current.origins[name] === "object"; });
    originList.sort(function (a, b) { return current.origins[b].n - current.origins[a].n; });
    var originText = originList.slice(0, 8).map(function (name) { return escapeHtml(name + " × " + current.origins[name].n); }).join("<br>");
    var cached = 0;
    for (var c = 0; c < current.cache.length; c += 1) cached += current.cache[c].b;
    var test = current.flags.storeTest;
    var testText = !test ? "还没做" : test.ok ? "通过（1 MB：编码 " + test.encMs + " ms · 写入 " + test.writeMs + " ms · 读取 " + test.readMs + " ms · 解码 " + test.decMs + " ms）" : "没通过" + (test.error ? "：" + test.error : "");
    var misses = stats.misses || 0;
    var hits = stats.hits || 0;
    var runLines = [];
    var kinds = { hit: "命中", part: "部分命中", miss: "未命中", pass: "放行", fail: "失败" };
    for (var ri = current.runs.length - 1; ri >= 0; ri -= 1) {
      var run = current.runs[ri];
      var line = kinds[run.k] + " " + sizeText(run.a || 0);
      if (run.k === "hit") line += " · " + run.ms + " ms";
      else if (run.k === "miss" || run.k === "part") line += " → 取回 " + sizeText(run.f || 0) + " · App 部分 " + run.m + " ms · 全部 " + run.ms + " ms · " + run.p + " 块 / " + run.n + " 条 · 容量 " + sizeText(run.c || 0) + (run.sh ? " · 分块答复" : "");
      else line += " · " + run.ms + " ms · " + (run.r || "");
      runLines.push(escapeHtml(line));
    }
    var hist = "≤256K " + (stats.h256 || 0) + " · ≤1M " + (stats.h1m || 0) + " · ≤2M " + (stats.h2m || 0) + " · ≤4M " + (stats.h4m || 0) + " · >4M " + (stats.hbig || 0);
    var queue = tqLoad();
    var telemetryText = !config.token ? "没开：插件参数里填上“遥测令牌”后，运行情况会实时写进 " + config.repo
      : "设备 " + queue.dev + " → " + config.repo + " · 已送达 " + (queue.files || 0) + " 个文件 / " + (queue.sent || 0) + " 条记录" +
        (queue.okAt ? " · 最近送达 " + new Date(queue.okAt).toLocaleTimeString() : " · 还没送达过") + " · 待发 " + queue.ev.length + " 条" +
        (queue.err ? " · 最近错误：" + queue.err + "（" + new Date(queue.errAt).toLocaleTimeString() + "）" : "") +
        (queue.liveUntil > now ? " · 实时诊断进行中（还剩 " + Math.ceil((queue.liveUntil - now) / 60000) + " 分钟）" : "");
    var appCounts = [];
    for (var statName in stats) if (/^app_/.test(statName)) appCounts.push(appName(statName.slice(4).replace(/x/g, "?")) + " " + stats[statName]);
    var paceText = "加速时 " + (stats.arAcc ? kbps(stats.arAcc) + " KB/s" : "—") + " · 只观察（对照）时 " + (stats.arObs ? kbps(stats.arObs) + " KB/s" : "—") +
      " · 原地址单连接抽样 " + (stats.ctlBps ? kbps(stats.ctlBps) + " KB/s" : "—") + " · 多线程每批 " + (stats.bps ? kbps(stats.bps) + " KB/s" : "—");
    var sniffLines = [];
    var sniffs = current.sniffs || [];
    for (var sn = sniffs.length - 1; sn >= 0; sn -= 1) {
      var sniffItem = sniffs[sn];
      var hostBits = [];
      for (var sniffHost in sniffItem.hosts || {}) hostBits.push(sniffHost.replace(/\.bilivideo\.com$/, "") + "×" + sniffItem.hosts[sniffHost]);
      sniffLines.push(escapeHtml(new Date(sniffItem.t).toLocaleTimeString() + " " + appName(sniffItem.a) + " " + sniffItem.ep + "：" + sniffItem.n + " 个地址" + (sniffItem.relay ? "（PCDN " + sniffItem.relay + "）" : "") + (hostBits.length ? " · " + hostBits.slice(0, 6).join(" ") : "")));
    }
    var rows = [
      ["版本", escapeHtml(BTRA_VERSION + " · " + (config.observe ? "只观察（对照）模式：不加速" : "加速模式"))],
      ["实时遥测", escapeHtml(telemetryText)],
      ["App 类型", escapeHtml(appCounts.length ? appCounts.join(" · ") : "还没看到 App 的取流请求")],
      ["App 实际取数速度", escapeHtml(paceText)],
      ["播放地址侦察", sniffLines.length ? sniffLines.join("<br>") : (config.sniff ? "还没看到播放地址接口（App 里打开一个视频就会有）" : "已关闭")],
      ["网页请求（未处理）", escapeHtml(String(stats.webSkips || 0))],
      ["设置", escapeHtml((config.auto ? "自动连接数" : config.conns + " 条连接") + " · 预读 " + (config.aheadBytes ? sizeText(config.aheadBytes) : "关") + " · 缓存上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN") + " · 大范围请求：" + (config.chunkReplies ? "分块答复" : "原样放行"))],
      ["统计起点", escapeHtml(new Date(current.since).toLocaleString())],
      ["连接数", escapeHtml(connsText).replace(/\n/g, "<br>")],
      ["来源节点", originText || "还没有记录"],
      ["看到的取流请求", escapeHtml((stats.seen || 0) + " 个（小段 " + (stats.bounded || 0) + " · 开放式 " + (stats.open || 0) + " · 无 Range " + (stats.none || 0) + " · 其他 " + (stats.other || 0) + "）")],
      ["请求大小分布", escapeHtml(hist + " · 最大 " + sizeText(stats.maxAsked || 0))],
      ["重复位置", escapeHtml((stats.dups || 0) + " 次：上一次答复还没完成 " + (stats.dupPending || 0) + " · 上次答得慢 " + (stats.dupSlow || 0) + " · 上次答得快 " + (stats.dupQuick || 0) + " · 上次是分块答复 " + (stats.dupShort || 0) + " · 上次放行/失败 " + (stats.dupFail || 0) + (stats.dupAfterMinMs ? "（重问之前那次答复用了 " + stats.dupAfterMinMs + "～" + stats.dupAfterMaxMs + " ms）" : ""))],
      ["其他取流方式", escapeHtml((stats.otherMedia || 0) + " 个 MCDN/PCDN 请求（未加速，原样放行）" + (stats.otherHost ? " · 最近：" + stats.otherHost : ""))],
      ["缓存命中", escapeHtml(hits + " 次（平均 " + average(stats.hitMs, hits) + " ms）· 部分命中 " + (stats.partial || 0) + " 次 · 未命中 " + misses + " 次")],
      ["未命中耗时", escapeHtml("平均：准备 " + average(stats.prepMs, stats.batches) + " ms · App 要的部分到手 " + average(stats.mustMs, stats.batches) + " ms · 整批到手 " + average(stats.allMs, stats.batches) + " ms · 超过 4 秒的答复 " + (stats.slowRuns || 0) + " 次")],
      ["多线程取回", escapeHtml((stats.batches || 0) + " 批 · " + sizeText(stats.fetched || 0) + " · " + (stats.pieces || 0) + " 个子块 · 平均 " + (stats.bps ? Math.round(stats.bps * 1000 / 1024) : 0) + " KB/s（每批）· 上一批容量 " + sizeText(stats.lastCapacity || 0) + " / " + (BTRA_SLICE_MS / 1000) + " 秒")],
      ["交给 App", escapeHtml(sizeText(stats.served || 0) + "，其中来自缓存 " + sizeText(stats.servedCached || 0) + " · 分块答复 " + (stats.shortReplies || 0) + " 次")],
      ["缓存", escapeHtml(current.cache.length + " 条 · " + sizeText(cached) + " / 上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + (current.flags.cacheOff ? " · 已停用：" + current.flags.cacheOff : ""))],
      ["存储自检", escapeHtml(testText)],
      ["原样放行", escapeHtml((stats.passed || 0) + " 次" + (stats.lastPass ? "（最近一次原因：" + stats.lastPass + "）" : ""))],
      ["失败后放行", escapeHtml((stats.failed || 0) + " 次" + (stats.lastError ? "（最近一次：" + stats.lastError + "）" : ""))],
      ["保险丝", breakers.length ? breakers.join("<br>") : "没有跳闸"],
      ["限流（412/429）", escapeHtml((stats.limited || 0) + " 次" + (stats.limited ? (config.auto ? "（被拒时开着多条连接的话，自动连接数退一档；那个节点 3 分钟内少给连接）" : "（连接数调小一些，或改成“自动”）") : ""))],
      ["节点", hosts.length ? hostSummary + "<br>" + hosts.join("<br>") : "还没有记录"],
      ["答复之后才到的块", escapeHtml((stats.late || 0) + " 块补存进了缓存（Loon 通常在答复后立刻结束脚本，所以这个数一般是 0）")],
      ["最近 12 次", runLines.length ? runLines.join("<br>") : "还没有记录"],
      ["App 标识", escapeHtml(stats.agent || "还没有记录")]
    ];
    var html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>BiliAccel</title><style>body{margin:0;padding:16px;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;background:#0e1014;color:#e9ecf2}" +
      "h1{font-size:18px}table{border-collapse:collapse;width:100%}td{padding:8px 6px;border-top:1px solid #2a2f3a;vertical-align:top;word-break:break-word}td:first-child{color:#97a0b0;white-space:nowrap}" +
      "a{color:#4cc2ff}p{color:#97a0b0;font-size:13px}</style></head><body><h1>⚡ BiliAccel · B 站双端加速</h1><table>";
    for (var row = 0; row < rows.length; row += 1) html += "<tr><td>" + rows[row][0] + "</td><td>" + rows[row][1] + "</td></tr>";
    var diag = JSON.stringify({ ver: BTRA_VERSION, dev: queue.dev, cfg: configSummary(), tq: { okAt: queue.okAt, err: queue.err, pending: queue.ev.length, sent: queue.sent }, agg: aggregate(), sniffs: sniffs, runs: current.runs, recent: queue.ev.slice(-30) });
    html += "</table><p><a href=\"/__bla__/live\">▶ 开始实时诊断</a>（30 分钟内每分钟上报）<br><a href=\"/__bla__/speed\">▶ 网速体检</a>（约 1 分钟，页面会一直转圈，等它出结果；先在 App 里播放一会儿视频，用的是那个视频的地址）</p>" +
      "<p>先在 B 站 App 里看一会儿视频，再回来刷新这个页面。<br><a href=\"?reset=1\">清零统计、缓存和保险丝</a></p>" +
      "<p>没开实时遥测时，把下面这段诊断复制下来发给 Claude：</p><textarea id=\"d\" readonly style=\"width:100%;height:120px;background:#161a22;color:#c9d1dc;border:1px solid #2a2f3a;font:11px ui-monospace,monospace\">" + escapeHtml(diag) + "</textarea>" +
      "<p><button onclick=\"var t=document.getElementById('d');t.select();document.execCommand('copy');this.textContent='已复制'\" style=\"font-size:15px;padding:8px 14px\">复制诊断</button></p></body></html>";
    finished = true;
    $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html } });
  }

  /* ------------------------------------------------------------ playurl sniff (read-only)
   * The App asks the API for a video's addresses before it fetches a single byte. What it is told —
   * which CDN hosts, DASH or MP4, PCDN relays or not — says where its requests will go, and so
   * whether this plugin can see and speed them up. The response is always passed on unchanged.
   */

  var MEDIA_URL_RE = /https?:(?:\\?\/){2}([A-Za-z0-9][A-Za-z0-9.-]{2,80}[A-Za-z0-9])(?::(\d{2,5}))?(?:\\?\/)((?:[^"'\s?#\\\x00-\x1f\x7f-\xff]|\\\/){0,240})/g;

  function sniffResponse() {
    finished = true;
    if (!config.sniff) { $done({}); return; }
    var started = Date.now();
    var event = { ty: "api", t: started };
    try {
      var parts = /^(https?):\/\/([^/:?#]+)(?::\d+)?(\/[^?#]*)(\?[^#]*)?/i.exec(url) || [];
      var path = parts[3] || "";
      var reqHeaders = request.headers || {};
      var resHeaders = $response.headers || {};
      var agent = header(reqHeaders, "User-Agent");
      var who = appOf(agent, parts[4] || "");
      var meta = header(reqHeaders, "x-bili-metadata-bin");
      if (!who.platform && !who.mobi && meta) {
        // gRPC metadata (base64 protobuf) carries mobi_app as plain text
        var decoded = latin1(b64decode(meta.replace(/[^A-Za-z0-9+/=]/g, "")));
        var mobi = /(iphone_i|iphone_b|iphone|ipad|android_i|android_hd|android|bstar_[a-z]+)/.exec(decoded);
        if (mobi) who = appOf("mobi_app/" + mobi[1], "");
      }
      event.a = who.code;
      event.pl = who.platform || who.mobi || undefined;
      event.ua = agentShort(agent);
      event.host = (parts[2] || "").toLowerCase();
      event.ep = path.replace(/^\/bilibili\./, "").slice(0, 70);
      event.qp = safeQuery(parts[4] || "");
      var status = Number($response.status || $response.statusCode || 0);
      if (status) event.http = status;
      var grpcStatus = header(resHeaders, "grpc-status");
      if (grpcStatus) event.gs = grpcStatus;
      var bytes = toBytes($response.body);
      event.len = bytes.length;
      var contentType = header(resHeaders, "Content-Type");
      var texts = [];
      if (/grpc/i.test(contentType) || /^\/bilibili\./.test(path)) {
        event.via = "grpc";
        var encoding = header(resHeaders, "grpc-encoding");
        for (var offset = 0; offset + 5 <= bytes.length;) {
          var flag = bytes[offset];
          var size = ((bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4]) >>> 0;
          var message = bytes.subarray(offset + 5, Math.min(bytes.length, offset + 5 + size));
          if (flag & 1) {
            event.gz = encoding || "?";
            try { message = ungzip(message); } catch (error) { event.err = "解压失败：" + String(error && error.message || error).slice(0, 40); }
          }
          texts.push(latin1(message, 4194304));
          offset += 5 + size;
        }
        if (!texts.length) texts.push(latin1(bytes, 4194304));
      } else {
        event.via = "rest";
        if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) { try { bytes = ungzip(bytes); } catch (error) { event.err = "解压失败"; } }
        texts.push(latin1(bytes, 4194304));
      }
      var hosts = {};
      var exts = {};
      var relays = 0;
      var count = 0;
      for (var index = 0; index < texts.length; index += 1) {
        var match;
        MEDIA_URL_RE.lastIndex = 0;
        while ((match = MEDIA_URL_RE.exec(texts[index])) && count < 400) {
          var host = match[1].toLowerCase();
          var urlPath = "/" + match[3].replace(/\\\//g, "/");
          var ext = ((/\.([a-z0-9]{2,4})$/i.exec(urlPath) || [])[1] || "").toLowerCase();
          if (!/^(?:m4s|mp4|flv|m3u8)$/.test(ext)) continue;
          count += 1;
          var key = host + (match[2] ? ":" + match[2] : "");
          hosts[key] = (hosts[key] || 0) + 1;
          exts[ext] = (exts[ext] || 0) + 1;
          if (BLA_RELAY_HOST_RE.test(host) || /^\/v1\/resource\//i.test(urlPath)) relays += 1;
        }
      }
      event.n = count;
      event.hosts = hosts;
      event.ext = exts;
      if (relays) event.relay = relays;
      event.dash = /"dash"|dash_audio|\bdash\b/i.test(texts.join("").slice(0, 200000)) ? 1 : 0;
      event.ms = Date.now() - started;
      // The status page shows the last few.
      state = loadState();
      change("sniff", { t: started, a: event.a, ep: event.ep, n: count, hosts: hosts, relay: relays });
      commit();
    } catch (error) {
      event.err = "侦察出错：" + String(error && error.message || error).slice(0, 60);
    }
    tqPush(event);
    // Not waiting for GitHub here: the App is waiting for this response.
    telemetryFlush("api", false);
    $done({});
  }

  /* ------------------------------------------------------------ self-test page
   * https://upos-sz-mirrorali.bilivideo.com/__bla_selftest__.m4s (and the http:// one) never reach the
   * CDN: if Loon hands them to this script, the media rule, the MITM certificate (for https) and the
   * script download all work. Each visit is reported live as well.
   */

  function selfTestPage(scheme) {
    state = loadState();
    ev = { ty: "rule", sc: scheme, ua: agentShort(header(request.headers, "User-Agent")) };
    var queue = tqLoad();
    var telemetryLine = !config.token ? "没有填遥测令牌：实时遥测不会上报（插件参数 → 遥测令牌）"
      : queue.err ? "遥测上次出错：" + queue.err : queue.okAt ? "遥测最近一次送达：" + new Date(queue.okAt).toLocaleTimeString() : "遥测还没送达过（播放视频或运行“开始实时诊断”后会上报）";
    var html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>BiliAccel 自检</title>" +
      "<style>body{margin:0;padding:20px;font:16px/1.6 -apple-system,'PingFang SC',sans-serif;background:#0e1014;color:#e9ecf2}b{color:#5ee08f}p{color:#97a0b0}</style></head><body>" +
      "<h2>✅ BiliAccel " + escapeHtml(BTRA_VERSION) + "：" + (scheme === "https" ? "HTTPS（MITM）" : "HTTP") + " 媒体规则已触发</h2>" +
      "<p>说明这个插件的脚本能下载、规则能匹配" + (scheme === "https" ? "、MITM 证书已被信任" : "") + "。这不等于 App 已经加速——接着去 App 里播放视频，统计页和实时遥测会显示 App 的请求。</p>" +
      "<p>" + escapeHtml(telemetryLine) + "</p><p><a style=\"color:#4cc2ff\" href=\"" + BTRA_STATUS_URL + "\">打开统计页</a></p></body></html>";
    var reply = { response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html } };
    // A good moment to send it too; wait a little for GitHub, the page can take a second.
    var sent = false;
    var send = function () { if (sent) return; sent = true; finish(reply); };
    tqPush(ev);
    ev = null;
    if (!telemetryFlush("rule", true, send)) send();
    else if (typeof setTimeout === "function") setTimeout(send, 4000);
  }

  /* ------------------------------------------------------------ scheduled / manual runs */

  function scriptName() {
    try { return String(typeof $script !== "undefined" && $script && $script.name || ""); } catch (_error) { return ""; }
  }

  function job() {
    var name = scriptName();
    state = loadState();
    if (/体检|speed/i.test(name)) { speedTest(); return; }
    if (/诊断|diag|live/i.test(name)) { startLive(); return; }
    // cron: write whatever is waiting (or a heartbeat while a live session is on)
    finished = true;
    var closed = false;
    var close = function () { if (closed) return; closed = true; $done({}); };
    // After a delivered batch, the next one goes out in the same run (a backlog clears within a minute).
    var rounds = 0;
    var next = function (ok) {
      rounds += 1;
      if (!ok || rounds >= 4 || !tqLoad().ev.length) { close(); return; }
      if (!telemetryFlush("cron", true, next)) close();
    };
    if (!telemetryFlush("cron", false, next)) { close(); return; }
    if (typeof setTimeout === "function") setTimeout(close, 25000);
  }

  function pageReply(title, lines, ok) {
    return { response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body:
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + escapeHtml(title) + "</title>" +
      "<style>body{margin:0;padding:20px;font:16px/1.7 -apple-system,'PingFang SC',sans-serif;background:#0e1014;color:#e9ecf2}p{color:#c9d1dc}a{color:#4cc2ff}</style></head><body>" +
      "<h2>" + (ok ? "✅ " : "⚠️ ") + escapeHtml(title) + "</h2><p>" + escapeHtml(lines).replace(/ · /g, "<br>") + "</p><p><a href=\"" + BTRA_STATUS_URL + "\">回到统计页</a></p></body></html>" } };
  }

  function startLive(asPage) {
    finished = true;
    var queue = tqLoad();
    queue.liveUntil = Date.now() + 30 * 60000;
    tqSave(queue);
    var stored = loadState();
    tqPush({ ty: "hi", loon: typeof $loon !== "undefined" ? String($loon).slice(0, 80) : "", cfg: configSummary(), store: stored.flags.storeTest ? (stored.flags.storeTest.ok ? 1 : 0) : -1,
      seen: stored.stats.seen || 0, ungzip: typeof $utils !== "undefined" && $utils && typeof $utils.ungzip === "function" ? 1 : 0 });
    var replied = false;
    var reply = function (ok, note) {
      if (replied) return;
      replied = true;
      var lines = ok ? "设备 " + queue.dev + " 已连上遥测仓库 " + config.repo + "。接下来 30 分钟每分钟上报一次；现在去 B 站 App 播放视频（国际版、国内版各看一会儿）。"
        : (note || "没送达") + "。" + (config.token ? "检查遥测令牌和仓库名。" : "在插件参数里填上遥测令牌。") + " 统计页：" + BTRA_STATUS_URL;
      try { $notification.post("BiliAccel 实时诊断" + (ok ? "已开始" : "没能开始"), ok ? "设备 " + queue.dev : "", lines); } catch (_error) {}
      $done(asPage ? pageReply("BiliAccel 实时诊断" + (ok ? "已开始" : "没能开始"), lines, ok) : { title: "BiliAccel 实时诊断", content: lines });
    };
    if (!telemetryFlush("diag", true, reply)) return;
    if (typeof setTimeout === "function") setTimeout(function () { reply(false, "GitHub 没有及时回应"); }, 15000);
  }

  /* ------------------------------------------------------------ speed test ("网速体检")
   * The question that decides everything: on this phone's network, do several connections to several
   * mirrors really beat the App's single connection? Measured directly, with the address the App
   * used last (if it is still fresh) or a public video's address.
   *   A  one connection to the App's own address, 2 MB          (what the App gets)
   *   B  8 connections, one each to 8 mainland mirrors, 512 KB each
   *   C  16 connections over mainland + overseas mirrors, 512 KB each
   */

  function speedTest(asPage) {
    finished = true;
    var outcome = { ty: "spd", via: asPage ? "page" : "generic" };
    var closed = false;
    var close = function (title, content) {
      if (closed) return;
      closed = true;
      tqPush(outcome);
      try { $notification.post(title, "", content); } catch (_error) {}
      var after = function () { $done(asPage ? pageReply(title, content, !outcome.err) : { title: title, content: content }); };
      if (!telemetryFlush("speed", true, after)) after();
      else if (typeof setTimeout === "function") setTimeout(after, 10000);
    };
    if (typeof setTimeout === "function") setTimeout(function () { outcome.err = "超时"; close("BiliAccel 网速体检没做完", "超过 80 秒，已上报已有结果。"); }, 80000);
    var last = null;
    try { last = JSON.parse($persistentStore.read(BLA_LAST_MEDIA_KEY) || "null"); } catch (_error) { last = null; }
    var usable = last && last.url && Date.now() - last.t < 100 * 60000 && /\/upgcxcode\//.test(last.url) && !BLA_RELAY_HOST_RE.test((/^https?:\/\/([^/:?#]+)/.exec(last.url) || [])[1] || "");
    if (usable) { outcome.src = "app:" + (last.app || "?"); run(last.url, last.ua || "Bilibili Freedoooooom/MarkII"); return; }
    outcome.src = "public";
    publicAddress(function (address, problem) {
      if (!address) { outcome.err = problem; close("BiliAccel 网速体检没做成", problem + "。先在 B 站 App 里播放任意视频 10 秒，再运行一次。"); return; }
      run(address, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    });

    function run(address, agent) {
      var parts = /^(https?):\/\/([^/:?#]+)(?::\d+)?(\/[^?#]*)(\?[^#]*)?/i.exec(address);
      var scheme = parts[1].toLowerCase();
      var origin = parts[2].toLowerCase();
      var path = parts[3];
      var query = (parts[4] || "").replace(/([?&])hdnts=[^&]*(&|$)/, function (_all, lead, tail) { return tail ? lead : ""; });
      outcome.host = origin;
      outcome.sc = scheme;
      var headers = { "User-Agent": agent, Referer: "https://www.bilibili.com/", "X-BLA-Sub": "1", "Accept-Encoding": "identity" };
      var MB = 1048576;
      var mirror = function (host, useScheme) { return (useScheme || scheme) + "://" + host + path + query; };
      // A: the App's own address, one connection, 1 MB a little way into the file.
      fetchRange(address, MB, 2 * MB - 1, headers, 12000, function (single) {
        outcome.A = single;
        var total = single.total || 0;
        if (!total) outcome.err = "原地址取不到：" + (single.err || "?");
        var room = total ? Math.max(0, total - 12 * MB) : 4 * MB;
        var base = total ? Math.min(Math.floor(total * 0.3), room) : 4 * MB;
        // O: the same address over 4 connections at once (1 MB each) — more connections on the App's own route.
        parallel([0, 1, 2, 3].map(function (index) { return { label: "origin", url: address, start: base + index * MB, bytes: MB }; }), function (four) {
          outcome.O = four;
          // H: overseas mirrors, the App's scheme
          var overseas = BTRA_OVERSEAS.filter(function (host) { return host !== origin; });
          var baseH = base + 4 * MB;
          parallel(overseas.map(function (host, index) { return { label: host, url: mirror(host), start: baseH + index * 524288, bytes: 524288 }; }), function (overseasResult) {
            outcome.H = overseasResult;
            // M: mainland mirrors over the App's scheme; S: four of them over HTTPS (is TLS the slow part?)
            var mainland = BTRA_MAINLAND.slice(0, 8);
            var baseM = baseH + overseas.length * 524288;
            parallel(mainland.map(function (host, index) { return { label: host, url: mirror(host), start: baseM + index * 262144, bytes: 262144 }; }), function (mainlandResult) {
              outcome.M = mainlandResult;
              var baseS = baseM + 8 * 262144;
              parallel(["upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com"].map(function (host, index) {
                return { label: host + "/https", url: mirror(host, "https"), start: baseS + index * 262144, bytes: 262144 };
              }), function (tlsResult) {
                outcome.S = tlsResult;
                var a = single.kb || 0;
                var times = function (value) { return a && value ? "（×" + (value / a).toFixed(1) + "）" : ""; };
                var line = "原地址 1 连接 " + (a ? a + " KB/s" : single.kbMax ? "< " + single.kbMax + " KB/s" : "失败") +
                  " · 原地址 4 连接 " + (four.kb || 0) + " KB/s" + times(four.kb) +
                  " · 海外镜像 " + overseasResult.ok + "/" + overseasResult.n + " 个通 " + (overseasResult.kb || 0) + " KB/s" +
                  " · 大陆镜像（" + scheme.toUpperCase() + "）" + mainlandResult.ok + "/" + mainlandResult.n + " 个通 " + (mainlandResult.kb || 0) + " KB/s" +
                  " · HTTPS 4 路 " + (tlsResult.kb || 0) + " KB/s";
                outcome.line = line;
                close("BiliAccel 网速体检", line + "。结果已上报。");
              });
            });
          });
        });
      });

      function parallel(list, callback) {
        var left = list.length;
        var startedAtLocal = Date.now();
        var bytes = 0;
        var per = [];
        var lastAt = startedAtLocal;
        if (!left) { callback({ n: 0, ok: 0, b: 0, ms: 0, kb: 0, per: [] }); return; }
        list.forEach(function (item) {
          fetchRange(item.url, item.start, item.start + item.bytes - 1, headers, 12000, function (result) {
            if (result.b) { bytes += result.b; lastAt = Date.now(); }
            per.push([shortHost(item.label), result.kb || 0, result.err ? result.err.slice(0, 16) : ""]);
            left -= 1;
            if (!left) {
              per.sort(function (x, y) { return y[1] - x[1]; });
              var ms = Math.max(1, lastAt - startedAtLocal);
              callback({ n: list.length, ok: per.filter(function (row) { return !row[2]; }).length, b: bytes, ms: ms, kb: Math.round(bytes / ms * 1000 / 1024), per: per });
            }
          });
        });
      }
    }

    function fetchRange(target, from, to, headers, timeout, callback) {
      var copy = {};
      for (var name in headers) copy[name] = headers[name];
      copy.Range = "bytes=" + from + "-" + to;
      var sent = Date.now();
      try {
        $httpClient.get({ url: target, headers: copy, timeout: timeout, "binary-mode": true, "auto-cookie": false }, function (error, response, data) {
          var ms = Math.max(1, Date.now() - sent);
          var length = data && typeof data.length === "number" ? data.length : 0;
          var status = response ? Number(response.status) : 0;
          var range = response ? parseContentRange(header(response.headers, "Content-Range")) : null;
          // A timeout still says something: slower than what was asked for in that time.
          if (error || status !== 206) callback({ err: error ? String(error).slice(0, 40) : "HTTP " + status, ms: ms, kbMax: error ? Math.round((to - from + 1) / ms * 1000 / 1024) : undefined });
          else callback({ b: length, ms: ms, kb: Math.round(length / ms * 1000 / 1024), total: range ? range.total : 0 });
        });
      } catch (error) { callback({ err: String(error && error.message || error).slice(0, 40), ms: 0 }); }
    }

    function publicAddress(callback) {
      var bvid = "BV1GJ411x7h7";
      var headers = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", Referer: "https://www.bilibili.com/" };
      $httpClient.get({ url: "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, headers: headers, timeout: 8000 }, function (error, response, data) {
        var cid = 0;
        try { cid = JSON.parse(data).data.cid; } catch (_error) { cid = 0; }
        if (!cid) { callback(null, "公开视频信息取不到（" + (error || (response && response.status) || "?") + "）"); return; }
        $httpClient.get({ url: "https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=64&fnval=16&fourk=0", headers: headers, timeout: 8000 }, function (error2, response2, data2) {
          var address = "";
          try { address = JSON.parse(data2).data.dash.video[0].baseUrl || JSON.parse(data2).data.dash.video[0].base_url; } catch (_error) { address = ""; }
          if (!address || !/\/upgcxcode\//.test(address)) { callback(null, "公开视频的播放地址取不到（" + (error2 || (response2 && response2.status) || "?") + "）"); return; }
          callback(address, "");
        });
      });
    }
  }

  /* ------------------------------------------------------------ main */

  function main() {
    // Which entry point: a response (API sniff), a request (status page, self-test, media), or a
    // scheduled / manual run without any request (told apart by the tag Loon gives the script).
    if (typeof $response !== "undefined" && $response && typeof $request !== "undefined" && $request) { sniffResponse(); return; }
    if (!url) { job(); return; }
    // Safari entry points for the manual runs (Loon's generic scripts are hard to find on the phone).
    if (/^https?:\/\/(?:www|m)\.bilibili\.com\/__bla__\/speed/i.test(url)) { state = loadState(); speedTest(true); return; }
    if (/^https?:\/\/(?:www|m)\.bilibili\.com\/__bla__\/live/i.test(url)) { state = loadState(); startLive(true); return; }
    if (/^https?:\/\/(?:www|m)\.bilibili\.com\/(?:__bla__|__btr_app__)(?:[/?#]|$)/i.test(url)) { statusPage(); return; }
    media();
  }

  function media() {
    var method = String(request.method || "GET").toUpperCase();
    var parts = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)(\?[^#]*)?/i.exec(url);
    // Requests this script makes itself are never taken apart again.
    if (!parts || header(request.headers, "X-BLA-Sub")) { finished = true; $done({}); return; }
    var scheme = parts[1].toLowerCase();
    var originHost = parts[2].toLowerCase();
    var port = parts[3] ? Number(parts[3]) : 0;
    var path = parts[4];
    var query = parts[5] || "";
    if (/^\/__bla_selftest__\.m4s$/i.test(path)) { selfTestPage(scheme); return; }
    var bilibiliHost = BLA_MEDIA_HOST_RE.test(originHost) || /^\/(?:upgcxcode|v1\/resource)\//i.test(path);
    // (The plugin's rule is narrower than this already; anything else is none of our business.)
    if (!bilibiliHost || !/\.(?:m4s|mp4|flv)$/i.test(path)) { finished = true; $done({}); return; }

    var agentFull = header(request.headers, "User-Agent");
    var who = appOf(agentFull, query);
    var shape = mediaShape(path);
    var pathKey = pathKeyOf(path);
    var rangeText = header(request.headers, "Range");
    ev = {
      ty: "m", k: "", a: who.code, pl: who.platform || who.mobi, ua: agentShort(agentFull), sc: scheme, h: originHost, pt: port || undefined,
      pf: shape.family, x: shape.ext, q: shape.q || undefined, fk: pathKey.split(":")[0].slice(0, 7),
      rg: /^bytes=\d+-\d+$/i.test(rangeText) ? "b" : /^bytes=\d+-$/i.test(rangeText) ? "o" : rangeText ? "x" : "n", qp: safeQuery(query)
    };
    state = loadState();
    change("bump", "seen", 1);
    var agentStat = agentShort(agentFull) + " · " + who.code + (who.platform ? "/" + who.platform : "");
    if (agentStat !== state.stats.agent) change("set", "agent", agentStat);
    var appKey = "app_" + who.code.replace(/\?/g, "x");
    change("bump", appKey, 1);
    // Requests from a web page (Origin / Sec-Fetch-*): a browser needs the CDN's own CORS headers.
    // Left alone — but reported, in case one of the apps plays through a web view.
    if (method !== "GET" || header(request.headers, "Origin") || header(request.headers, "Sec-Fetch-Mode")) {
      change("bump", "webSkips", 1);
      passThrough(method !== "GET" ? "不是 GET（" + method + "）" : "网页发出的请求（带 Origin）", "skip");
      return;
    }
    // Remember the address for the speed test (on this device only — it carries a signature).
    try { $persistentStore.write(JSON.stringify({ url: url, ua: agentFull, t: Date.now(), app: who.code }), BLA_LAST_MEDIA_KEY); } catch (_error) {}
    if (BLA_RELAY_HOST_RE.test(originHost) || /^\/v1\/resource\//i.test(path)) {
      // A P2P / edge relay (MCDN, PCDN boxes): its address is signed for the relay alone, no mirror
      // takes it. Counted, so that we see how much of the traffic goes this way.
      change("bump", "otherMedia", 1);
      change("set", "otherHost", originHost + (port ? ":" + port : ""));
      cadenceNote(pathKey, rangeText);
      passThrough("PCDN/中转地址，镜像节点不认", "relay");
      return;
    }
    if (!/^\/upgcxcode\//i.test(path) || !/\.(?:m4s|mp4)$/i.test(path)) {
      cadenceNote(pathKey, rangeText);
      passThrough("还不认识的路径 /" + shape.family + "/…" + shape.ext, "unknown");
      return;
    }
    if (config.observe) {
      change("bump", "observed", 1);
      change("origin", originHost, Date.now());
      cadenceNote(pathKey, rangeText);
      passThrough("只观察（对照）模式", "obs");
      return;
    }
    accelerate(scheme, originHost, port, path, query, pathKey, rangeText);
  }

  // The App's own pace on one stream: the time from one request to the next contiguous one is (an upper
  // bound of) the time it took to get the previous piece. Bytes over that time is the speed the App
  // actually got — the same yardstick whether a request was accelerated or passed through untouched.
  function cadenceNote(pathKey, rangeText) {
    var range = /^bytes=(\d+)-(\d*)$/i.exec(rangeText || "");
    if (!range) return;
    var start = Number(range[1]);
    var end = range[2] ? Number(range[2]) : -1;
    var now = Date.now();
    var best = null;
    for (var index = state.recent.length - 1; index >= 0; index -= 1) {
      var entry = state.recent[index];
      if (entry.p !== pathKey || now - entry.t > 90000) continue;
      var lastEnd = entry.x >= 0 ? entry.x : entry.e;
      if (lastEnd >= 0 && lastEnd + 1 === start) { best = entry; break; }
    }
    if (best) {
      var gap = Math.max(1, startedAt - best.t);
      var bytes = (best.x >= 0 ? best.x : best.e) - best.s + 1;
      ev.dt = gap;
      ev.ar = Math.round(bytes / gap * 1000 / 1024);
      if (bytes >= 131072 && gap < 60000) change("ewma", config.observe ? "arObs" : "arAcc", bytes / gap);
    }
    if (ev) { ev.st = Math.round(start / 1024); if (end >= 0) ev.as = end - start + 1; }
    change("recent", { p: pathKey, s: start, e: end, t: startedAt });
  }

  function accelerate(scheme, originHost, port, path, query, pathKey, rangeText) {
    // Refusals are remembered per address: the file plus its signature. A freshly signed address for
    // the same file (after a long pause the old one expires and every mirror refuses it) starts clean.
    var signature = /[?&]upsig=([0-9A-Za-z]{1,12})/.exec(query);
    var addressKey = pathKey + (signature ? "#" + signature[1] : "");
    var now = Date.now();
    change("rr");
    change("origin", originHost, now);
    var rangeHeader = rangeText;
    var bounded = /^bytes=(\d+)-(\d+)$/i.exec(rangeHeader);
    var open = /^bytes=(\d+)-$/i.exec(rangeHeader);
    change("bump", bounded ? "bounded" : open ? "open" : rangeHeader ? "other" : "none", 1);
    // Without a Range the App expects "200 + the whole file"; a partial answer would be wrong.
    if (!bounded && !open) { passThrough(rangeHeader ? "Range 写法不认识" : "请求没有 Range"); return; }

    var start = Number((bounded || open)[1]);
    var wantedEnd = bounded ? Number(bounded[2]) : Infinity;
    if (!(start >= 0) || wantedEnd < start) { passThrough("Range 不合法"); return; }
    if (bounded) {
      var asked = wantedEnd - start + 1;
      change("bump", asked <= 262144 ? "h256" : asked <= 1048576 ? "h1m" : asked <= 2097152 ? "h2m" : asked <= 4194304 ? "h4m" : "hbig", 1);
    }

    var known = state.totals[pathKey];
    var total = known ? known.size : 0;
    var contentType = known ? known.type : "";
    if (total && start >= total) { passThrough("起点超出文件"); return; }
    if (total && wantedEnd > total - 1) wantedEnd = total - 1;

    // The same position asked for again within a minute: a retry after a timeout on the App's side,
    // or a player that does not carry on after a short answer.
    var repeats = 0;
    var previous = null;
    for (var index = 0; index < state.recent.length; index += 1) {
      var entry = state.recent[index];
      if (now - entry.t <= 60000 && entry.p === pathKey && entry.s === start) { repeats += 1; previous = entry; }
    }
    cadenceNote(pathKey, rangeHeader);
    if (repeats) ev.dup = repeats;
    currentKey = pathKey;
    currentStart = start;
    currentAsked = bounded ? wantedEnd - start + 1 : 0;
    if (repeats) {
      change("bump", "dups", 1);
      // What did the App get the last time it asked for this very position? That tells whether the
      // repeats are retries after a slow answer, after a partial one, or after a failure.
      change("bump", !previous.o ? "dupPending" : previous.o === "short" ? "dupShort" : previous.o === "fail" || previous.o === "pass" ? "dupFail" : previous.ms > 2500 ? "dupSlow" : "dupQuick", 1);
      // How long had the previous answer taken when the App asked again? The smallest such value
      // is a hint of how long the App is prepared to wait.
      if (previous.o === "ok" && previous.ms) { change("min", "dupAfterMinMs", previous.ms); change("max", "dupAfterMaxMs", previous.ms); }
    }
    // Automatic connection count: judge a step that has had its time; the App asking again because
    // the last answer was slow (or never came) is a stall.
    autoJudge(now);
    if (repeats && previous && (!previous.o || ((previous.o === "ok" || previous.o === "short") && previous.ms > BTRA_AUTO_WAIT_MS))) {
      autoUp(now, "App 又要了一次同一段（上次答得慢）", true);
    }
    if (config.auto) config.conns = BTRA_AUTO_LADDER[autoLevel()];
    var runLevel = autoLevel();
    if (bounded && wantedEnd - start + 1 > (state.stats.maxAsked || 0)) change("set", "maxAsked", wantedEnd - start + 1);
    change("head", pathKey, start, now);

    var caching = config.cacheBytes > 0 && !state.flags.cacheOff;
    if (caching) storeSelfTest();
    caching = caching && !state.flags.cacheOff;

    /* ---- mirrors: who gets how much ----
     * Mirrors differ twentyfold in what one connection delivers (a phone in Los Angeles measured
     * 12 KB/s on one, 269 KB/s on another). Sharing pieces out evenly would make every batch wait
     * for the slowest. Instead every connection ("slot") gets as many bytes as its mirror is
     * expected to deliver in BTRA_BATCH_TARGET_MS, so the whole batch lands at about the same
     * moment, and the fast mirrors carry most of it. Mirrors nobody has measured get one small
     * read-ahead piece now and then, which is how they become known.
     */
    // Both sets are always candidates — from overseas the mainland mirrors and the Hong Kong /
    // Akamai nodes travel different routes, and using them together is what adds up to real
    // bandwidth. The CDN setting only decides which set is tried first; measured speed then sorts
    // out who actually carries the load. A mirror resting after repeated hard failures is skipped.
    // 2.0.1: the App's own host comes first — the same route it would use, only with several
    // connections — then the overseas mirrors, then the mainland ones (left to prove themselves).
    // Sub-requests use the App's scheme: on the phone that reported, plain HTTP was some 50 times
    // faster than HTTPS to the very same host. Akamai hosts take their own token only, so another
    // Akamai host is never asked for a file it was not given.
    var preferred = config.overseas ? BTRA_OVERSEAS : BTRA_MAINLAND;
    var everyMirror = [originHost].concat(preferred, BTRA_MAINLAND, BTRA_OVERSEAS).filter(function (host, index, all) {
      return all.indexOf(host) === index && (host === originHost || !/\.akamaized\.net$/i.test(host));
    });
    // Left out for this file: a mirror that serves other files but has refused this one (twice,
    // lately — upstream: "只停用这一个组合，不会把整个节点停掉"); within one run a single refusal will do.
    var refusedHere = {};
    function leftOut(host) {
      if (refusedHere[host]) return true;
      var pair = state.pairs[host + " " + addressKey];
      return !!pair && pair.n >= BTRA_PAIR_LIMIT && now - pair.t < BTRA_PAIR_TTL;
    }
    // How many connections a mirror takes at once: BTRA_PER_HOST, or fewer while it is known to turn
    // more away (412 / 429 with some of ours open: it keeps what it had, for BTRA_AUTO_PUSHBACK_MS).
    var capHere = {};
    function hasRoom(host) {
      var cap = capOf(host);
      return (hostInflight[host] || 0) + (cap < BTRA_PER_HOST ? busyCount(host) : 0) < cap;
    }
    function capOf(host) {
      if (capHere[host]) return capHere[host];
      var record = state.hosts[host];
      return record && record.cap > 0 && now - (record.capAt || 0) < BTRA_AUTO_PUSHBACK_MS ? Math.min(BTRA_PER_HOST, record.cap) : BTRA_PER_HOST;
    }
    var allowed = everyMirror.filter(function (host) { return !leftOut(host); });
    // Every mirror has refused this very address lately (an expired signature, content the mirrors do
    // not carry): nothing to try, let the App fetch it itself at once.
    if (!allowed.length) { passThrough("所有镜像都拒绝了这个地址"); return; }
    var pool = allowed.filter(function (host) { return !(state.hosts[host] && state.hosts[host].until > now); });
    if (pool.length < 2) pool = allowed.slice();
    var speedOf = function (host) { var record = state.hosts[host]; return record && record.bps > 0 ? record.bps : 0; };
    var triesOf = function (host) { var record = state.hosts[host]; return record ? (record.ok || 0) + (record.bad || 0) + (record.late || 0) : 0; };
    var measuredAt = function (host) { var record = state.hosts[host]; return record && record.at || 0; };
    var knownHosts = pool.filter(function (host) { return speedOf(host) > 0; }).sort(function (a, b) { return speedOf(b) - speedOf(a); });
    var unknownHosts = pool.filter(function (host) { return speedOf(host) <= 0; }).sort(function (a, b) {
      return (a === originHost ? -1 : 0) - (b === originHost ? -1 : 0) || triesOf(a) - triesOf(b);
    });
    var assumedBps = knownHosts.length ? speedOf(knownHosts[Math.floor(knownHosts.length / 2)]) : BTRA_ASSUMED_BPS;
    // Nothing much known yet: even shares, the App's bytes asked of two hosts at once. 2.0.1: once the
    // App's own host has a measured speed, that is enough to plan on — mirrors that never deliver stay
    // unmeasured for good on some networks, and must not keep every batch in this cautious mode.
    var fresh = knownHosts.length < (knownHosts.indexOf(originHost) >= 0 ? 1 : 3);
    // Upstream 0.9.3.0: a mirror measured at under a twelfth of the fastest sits out — whatever it
    // starts has to be rescued anyway, and its connection is better spent on a quick mirror. Once its
    // measurement is BTRA_MEASURE_TTL old it counts as unmeasured again and gets a probe. (Only
    // relative to the fastest: when every mirror crawls, all of them stay in and are summed.)
    var slowHosts = [];
    if (!fresh) {
      var floorBps = speedOf(knownHosts[0]) / BTRA_SLOW_SHARE;
      var quick = [];
      var retry = [];
      for (var kh = 0; kh < knownHosts.length; kh += 1) {
        if (speedOf(knownHosts[kh]) >= floorBps) quick.push(knownHosts[kh]);
        else if (now - measuredAt(knownHosts[kh]) >= BTRA_MEASURE_TTL) retry.push(knownHosts[kh]);
        else slowHosts.push(knownHosts[kh]);
      }
      // Mirrors that did work before are more promising probes than ones that never answered.
      if (quick.length >= 2) { knownHosts = quick; unknownHosts = retry.concat(unknownHosts); }
      else slowHosts = [];
    }
    // Connections that another run (the other stream) is using right now still occupy the mirror:
    // every run notes its connections under a shared key while it works and takes them out at the end.
    var busy = {};
    try { busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {}; } catch (_error) { busy = {}; }
    function busyCount(host) {
      var stamps = busy[host] || [];
      var count = 0;
      for (var b = 0; b < stamps.length; b += 1) if (stamps[b].r !== runId && now - stamps[b].t < BTRA_BUSY_MS) count += 1;
      return count;
    }
    var slots = [];
    if (fresh) {
      // Nothing much is known yet: everybody gets an even share, and the App's own pieces are asked
      // of two mirrors at once (see duplicateMust) so that a dead one costs nothing but bandwidth.
      // Half the connections, then, so that the doubled requests still fit into one round.
      var order = knownHosts.concat(unknownHosts);
      // 2.0.1: the App's own host gets several connections and is assumed to be at least middling: the
      // App's bytes go there first, so a batch is never worse than the App's own route. The others
      // get one connection each and prove themselves on read-ahead.
      var originSlots = order.indexOf(originHost) >= 0 ? Math.min(4, BTRA_PER_HOST) : 0;
      for (var os = 0; os < originSlots; os += 1) slots.push({ host: originHost, bps: Math.max(speedOf(originHost), 200), explore: false });
      for (var s = 0; slots.length < Math.max(2, Math.floor(config.conns / 2)) && order.length; s += 1) {
        var candidate = order[s % order.length];
        if (candidate === originHost) { if (s >= order.length) break; continue; }
        slots.push({ host: candidate, bps: speedOf(candidate) || assumedBps, explore: false });
        if (s >= order.length * 2) break;
      }
    } else {
      // Bandwidth is the sum over mirrors, so first give one connection to EVERY mirror we trust
      // (fastest first) rather than piling several onto the top few. Then probe a handful of
      // unmeasured mirrors so a wide pool is learned. Only then are spare connections handed back to
      // the fastest mirrors, up to BTRA_PER_HOST each, counting whatever the other stream is using.
      var perHostCount = {};
      var roomFor = function (host) { return capOf(host) - busyCount(host) - (perHostCount[host] || 0); };
      var pushSlot = function (host, explore) {
        perHostCount[host] = (perHostCount[host] || 0) + 1;
        var bps = speedOf(host) || Math.min(assumedBps, BTRA_ASSUMED_BPS);
        // A mirror re-tried after sitting out is probed with an ordinary piece, as if it were a
        // middling mirror: a tiny one would measure mostly round trip and could never show that it
        // has recovered. Every probe is at least the smallest piece.
        if (explore && speedOf(host) > 0) bps = Math.max(bps, assumedBps);
        if (explore) bps = Math.max(bps, BTRA_MIN_SLOT / BTRA_SLICE_MS);
        slots.push({ host: host, bps: bps, explore: !!explore });
      };
      for (var k = 0; k < knownHosts.length && slots.length < config.conns; k += 1) {
        if (roomFor(knownHosts[k]) > 0) pushSlot(knownHosts[k], false);
      }
      // Probe unmeasured mirrors hard while the roster is thin (a wide pool must be learned fast),
      // then ease off to a single probe once enough are known, so read-ahead is not crowded out.
      var exploreN = knownHosts.length >= 6 ? 1 : BTRA_EXPLORE;
      for (var u = 0; u < unknownHosts.length && u < exploreN && slots.length < config.conns; u += 1) {
        if (roomFor(unknownHosts[u]) > 0) pushSlot(unknownHosts[u], true);
      }
      var progress = true;
      while (slots.length < config.conns && progress) {
        progress = false;
        for (var f = 0; f < knownHosts.length && slots.length < config.conns; f += 1) {
          if (roomFor(knownHosts[f]) > 0) { pushSlot(knownHosts[f], false); progress = true; break; }
        }
      }
    }
    // Fastest connections first, probes last: the piece loop below hands out the App's own (blocking)
    // bytes from the front of this list and the read-ahead from what remains, so both prefer the
    // quick mirrors and the slow ones only ever pick up the furthest, most disposable read-ahead.
    slots.sort(function (a, b) {
      if (a.explore !== b.explore) return a.explore ? 1 : -1;
      return b.bps - a.bps;
    });
    var duplicateMust = fresh;
    busyNote(slots.map(function (slot) { return slot.host; }));
    // A connection's slice: what its mirror should deliver in BTRA_SLICE_MS. Too slow for even the
    // smallest piece → 0, the connection sits this batch out.
    function slotBytes(slot) {
      var bytes = Math.min(BTRA_MAX_PIECE, Math.round(slot.bps * BTRA_SLICE_MS));
      return bytes >= BTRA_MIN_SLOT ? bytes : 0;
    }
    // What one batch can carry (used to size answers to open-ended requests).
    var capacity = 0;
    for (var cs = 0; cs < slots.length; cs += 1) if (!slots[cs].explore) capacity += slotBytes(slots[cs]);
    if (duplicateMust) capacity = Math.round(capacity / 2);

    // How much goes into this one answer. A range the App spelled out is answered exactly as long as
    // it fits in memory comfortably. "From here to the end" (or a huge range) gets what one batch can
    // carry — more when the cache already holds the continuation, so the player needs fewer
    // reconnects.
    var end = wantedEnd;
    var plannedShort = false;
    if (!bounded || wantedEnd - start + 1 > BTRA_EXACT_LIMIT) {
      var replyBytes = Math.max(start === 0 ? 1048576 : BTRA_OPEN_REPLY, Math.min(BTRA_MAX_REPLY, capacity));
      if (caching) replyBytes = Math.max(replyBytes, Math.min(BTRA_MAX_REPLY, contiguousCachedEnd(pathKey, start) - start + 1));
      end = Math.min(wantedEnd, start + replyBytes - 1);
      plannedShort = end < wantedEnd;
    }
    if (plannedShort) {
      if (!config.chunkReplies) { passThrough("大范围请求按设置原样放行"); return; }
      var trip = state.breaker.shortReply;
      if (trip && trip.until > now) { passThrough("保险丝：" + trip.reason); return; }
      // (A healthy player may well open a file two or three times from the start.)
      if (repeats >= (start === 0 ? 4 : 3)) {
        change("breaker", "shortReply", { until: now + 10 * 60000, reason: "App 播放器不接受分块答复" });
        notifyOnce("breaker-short", 60000, "BiliAccel 已自动让路", "这个 App 的播放器不接受分块答复", "接下来 10 分钟大范围取流请求会原样放行（不加速，但不影响观看）。请把 " + BTRA_STATUS_URL + " 这一页截图发出来（开了实时遥测的话已经自动上报）。");
        passThrough("保险丝刚刚跳闸");
        return;
      }
    }
    var originTrip = state.breaker["origin:" + originHost];
    if (originTrip && originTrip.until > now) { passThrough("保险丝：" + originTrip.reason); return; }

    /* ---- what is needed, what is already here, what to read ahead ---- */
    var must = caching && total ? coverage(pathKey, start, end, true) : [{ s: start, e: end, entry: null }];
    var missing = [];
    var cachedBytes = 0;
    for (var m = 0; m < must.length; m += 1) {
      if (must[m].entry) cachedBytes += must[m].e - must[m].s + 1; else missing.push(must[m]);
    }

    function assemble() {
      var length = end - start + 1;
      var body = new Uint8Array(length);
      for (var index = 0; index < must.length; index += 1) {
        var segment = must[index];
        if (!segment.bytes || segment.bytes.length !== segment.e - segment.s + 1) return null;
        body.set(segment.bytes, segment.s - start);
      }
      return body;
    }

    function respond(body, fromCacheBytes, pieceCount, elapsed, detail) {
      var isShort = end < wantedEnd;
      change("bump", "served", body.length);
      change("bump", "servedCached", fromCacheBytes);
      if (isShort) change("bump", "shortReplies", 1);
      if (elapsed > 4000) change("bump", "slowRuns", 1);
      change("rdone", pathKey, start, startedAt, isShort ? "short" : "ok", elapsed, end);
      var record = { k: pieceCount ? (fromCacheBytes ? "part" : "miss") : "hit", a: currentAsked, s: body.length, ms: elapsed, sh: isShort ? 1 : 0 };
      if (detail) { record.f = detail.fetched; record.m = detail.mustMs; record.p = pieceCount; record.c = detail.capacity; record.n = detail.slots; }
      change("run", record);
      ev.k = record.k;
      ev.sv = body.length;
      ev.ms = elapsed;
      if (fromCacheBytes) ev.ca = fromCacheBytes;
      if (isShort) ev.sh = 1;
      ev.sz = total || undefined;
      ev.c = config.conns;
      if (detail) {
        ev.f = detail.fetched; ev.mw = detail.mustMs; ev.p = pieceCount; ev.n = detail.slots; ev.bms = detail.batchMs;
        if (detail.batchMs > 0) ev.bk = Math.round(detail.fetched / detail.batchMs * 1000 / 1024);
        if (detail.hosts) ev.hs = detail.hosts;
        if (detail.control) ev.ctl = detail.control;
      }
      var headers = {
        "Content-Type": contentType || "video/mp4",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BiliAccel": BTRA_VERSION + "; pieces=" + pieceCount + "; cached=" + fromCacheBytes + "; ms=" + elapsed + "; capacity=" + capacity
      };
      // After a short answer the player has to come back for the rest. On a kept-alive HTTP/1.1
      // connection some players would wait for more bytes instead; closing makes the end explicit.
      if (isShort) headers.Connection = "close";
      finish({ response: { status: 206, headers: headers, body: body } });
    }

    if (!missing.length) {
      // Everything the App wants is in the cache: hand it over at once. (No read-ahead on a hit —
      // it would only hold the answer up; the next miss reads ahead again.)
      var cachedBody = assemble();
      if (cachedBody) {
        change("bump", "hits", 1);
        change("bump", "hitMs", Date.now() - startedAt);
        respond(cachedBody, cachedBody.length, 0, Date.now() - startedAt);
        return;
      }
      missing = must.slice();
      for (var reset = 0; reset < must.length; reset += 1) { must[reset].entry = null; must[reset].bytes = null; }
      cachedBytes = 0;
    }
    change("bump", cachedBytes ? "partial" : "misses", 1);

    var mustBytes = 0;
    for (var mb = 0; mb < missing.length; mb += 1) mustBytes += missing[mb].e - missing[mb].s + 1;
    // A small request (the player probing a file header, or a small gap in the cache) is answered
    // quickly on its own; the read-ahead comes with the next real block.
    var extras = [];
    if (caching && config.aheadBytes && mustBytes >= 262144) {
      // Never more than half the cache in one go: the other stream (sound) needs room too.
      var ahead = Math.max(0, Math.min(config.aheadBytes, Math.round(config.cacheBytes / 2) - mustBytes));
      if (total) ahead = Math.min(ahead, Math.max(1048576, Math.round(total / 8)));
      if (!total) ahead = Math.min(ahead, 1048576);
      var aheadEnd = total ? Math.min(total - 1, end + ahead) : end + ahead;
      if (aheadEnd > end) {
        var region = coverage(pathKey, end + 1, aheadEnd, false);
        for (var r = 0; r < region.length; r += 1) if (!region[r].entry) extras.push({ s: region[r].s, e: region[r].e });
      }
    }
    // Akamai's own token means nothing to the ordinary mirrors.
    var mirrorQuery = query.replace(/([?&])hdnts=[^&]*(&|$)/, function (_all, lead, tail) { return tail ? lead : ""; });

    var forwardHeaders = {};
    for (var name in request.headers) {
      if (!Object.prototype.hasOwnProperty.call(request.headers, name)) continue;
      if (/^(?::|host$|range$|connection$|proxy-connection$|keep-alive$|content-length$|transfer-encoding$|upgrade$|te$|if-range$|if-none-match$|if-modified-since$|accept-encoding$)/i.test(name)) continue;
      forwardHeaders[name] = request.headers[name];
    }
    forwardHeaders["X-BLA-Sub"] = "1";
    forwardHeaders["Accept-Encoding"] = "identity";

    /* ---- pieces ----
     * One round: every connection gets one piece, its slice, so the whole batch lands at about the
     * same moment (BTRA_SLICE_MS plus connection set-up). The App's bytes are handed to the fastest
     * connections first, the read-ahead to the rest. A batch without read-ahead (a probe, a small
     * gap, the App's bytes on their own) is cut finer instead: every measured connection takes a
     * share in proportion to its speed, which is the quickest way to get those bytes here.
     */
    var pieces = [];
    var batchBytes = 0;
    var mustQueue = missing.map(function (segment) { return { s: segment.s, e: segment.e }; });
    var extraQueue = extras;
    function take(queue, bytes) {
      if (!queue.length) return null;
      var segment = queue[0];
      var pieceEnd = Math.min(segment.e, segment.s + bytes - 1);
      var range = { start: segment.s, end: pieceEnd };
      if (pieceEnd === segment.e) queue.shift(); else segment.s = pieceEnd + 1;
      return range;
    }
    function addPiece(range, extra, slot) {
      pieces.push({ index: pieces.length, start: range.start, end: range.end, extra: extra, slot: slot });
      batchBytes += range.end - range.start + 1;
    }
    var usable = slots.filter(function (slot) { return !slot.explore && slotBytes(slot) > 0; });
    if (!usable.length) usable = slots.filter(function (slot) { return !slot.explore; });
    // The App's bytes go to the App's own host and to measured hosts; unproven ones get read-ahead only.
    var trusted = function (slot) { return slot.host === originHost || speedOf(slot.host) > 0; };
    var mustSlots = usable.filter(trusted);
    if (!mustSlots.length) mustSlots = usable;
    // The baseline: now and then the furthest read-ahead piece goes to the App's own address over a
    // single connection — what the App would get on its own. Its bytes are as good as any (same file).
    var controlPiece = null;
    if (caching && extraQueue.length && now - (state.stats.ctlAt || 0) >= BLA_CONTROL_EVERY_MS) {
      var tail = extraQueue[extraQueue.length - 1];
      var controlStart = Math.max(tail.s, tail.e - BLA_CONTROL_BYTES + 1);
      if (tail.e - controlStart + 1 >= 131072) {
        var controlRange = { start: controlStart, end: tail.e };
        if (controlStart === tail.s) extraQueue.pop(); else tail.e = controlStart - 1;
        addPiece(controlRange, true, { host: originHost, bps: BLA_CONTROL_BYTES / BTRA_SLICE_MS, explore: false, control: true });
        controlPiece = pieces[pieces.length - 1];
        change("set", "ctlAt", now);
      }
    }
    if (extraQueue.length) {
      for (var si = 0; si < slots.length; si += 1) {
        var slice = slotBytes(slots[si]);
        if (!slice) continue;
        var range = slots[si].explore || mustSlots.indexOf(slots[si]) < 0 ? null : take(mustQueue, slice);
        if (range) { addPiece(range, false, slots[si]); continue; }
        if (batchBytes >= BTRA_MAX_BATCH) break;
        range = take(extraQueue, Math.max(BTRA_MIN_SLOT, Math.min(Math.round(slice * BTRA_EXTRA_SHARE), BTRA_MAX_BATCH - batchBytes)));
        if (range) addPiece(range, true, slots[si]);
      }
    } else {
      var sumBps = 0;
      for (var ub = 0; ub < mustSlots.length; ub += 1) sumBps += mustSlots[ub].bps;
      for (var ws = 0; ws < mustSlots.length && mustQueue.length; ws += 1) {
        var share = Math.max(BTRA_MIN_SLOT, Math.min(BTRA_MAX_PIECE, Math.round(mustBytes * mustSlots[ws].bps / sumBps)));
        var part = take(mustQueue, share);
        if (part) addPiece(part, false, mustSlots[ws]);
      }
    }
    // Whatever is left of the App's bytes (a big request, a slow network): more rounds over the
    // fastest connections; those pieces queue up behind the first ones.
    for (var cycle = 0; mustQueue.length && cycle < 256; cycle += 1) {
      var again = mustSlots[cycle % Math.max(1, Math.min(mustSlots.length, 8))];
      if (!again) break;
      var more = take(mustQueue, Math.max(BTRA_MIN_SLOT, slotBytes(again)));
      if (more) addPiece(more, false, again);
    }
    var mustCount = 0;
    for (var pc = 0; pc < pieces.length; pc += 1) if (!pieces[pc].extra) mustCount += 1;

    var failed = false;
    var delivered = false;
    var mustLeft = mustCount;
    var extraLeft = pieces.length - mustCount;
    var launchedAt = 0;
    var mustDoneAt = 0;
    var inflight = 0;
    var hostInflight = {};
    var queue = pieces.slice();
    var tasks = [];
    var goodHosts = [];
    var results = new Array(pieces.length);
    var fetchedBytes = 0;
    var runHostBytes = {};
    var controlInfo = null;
    var originalUrl = scheme + "://" + originHost + (port ? ":" + port : "") + path + query;
    var subScheme = scheme === "http" ? "http" : "https";
    function hostSummaryOfRun() {
      var list = [];
      for (var name in runHostBytes) list.push([shortHost(name), Math.round(runHostBytes[name] / 1024)]);
      list.sort(function (a, b) { return b[1] - a[1]; });
      return list.length ? [list.length].concat(list.slice(0, 5)) : undefined;
    }
    function controlSummary() {
      if (!controlPiece) return undefined;
      if (controlInfo) return controlInfo;
      var bytes = controlPiece.end - controlPiece.start + 1;
      var task = null;
      for (var index = 0; index < tasks.length; index += 1) if (tasks[index].piece === controlPiece) task = tasks[index];
      if (!task || !task.launchedAt) return { b: bytes, done: 0, ms: 0 };
      var waited = Math.max(1, Date.now() - task.launchedAt);
      // not finished: the App's own route is slower than this
      return { b: bytes, done: 0, ms: waited, kbMax: Math.round(bytes / waited * 1000 / 1024) };
    }
    var hedges = 0;
    var pushedBack = false;

    function strikePending(reason) {
      // Mirrors whose pieces are still outstanding well after their slice time get a "late" mark —
      // counted only (see the "late" op): it neither lowers their speed nor benches them.
      var lateLine = Date.now() - (BTRA_SLICE_MS + 300);
      var marked = {};
      for (var index = 0; index < tasks.length; index += 1) {
        var task = tasks[index];
        if (task.done || task.inflight <= 0 || !task.launchedAt) continue;
        var lateHost = task.used[task.used.length - 1];
        if (task.piece.slot.control && lateHost === originHost) continue;
        if (marked[lateHost]) continue;
        // A probe that has not delivered by the end of the batch always gets its mark: that is how a
        // mirror that swallows requests stops being the first one probed every time (its probes are
        // abandoned with the run, so it would never be found out otherwise). One mark per mirror per batch.
        if (task.piece.slot.explore) {
          marked[lateHost] = true;
          change("late", lateHost, Date.now(), reason);
          change("probe", lateHost, Date.now());
        } else if (task.launchedAt < lateLine) { marked[lateHost] = true; change("late", lateHost, Date.now(), reason); }
      }
    }

    function giveUp(reason) {
      if (failed || finished) return;
      failed = true;
      change("bump", "failed", 1);
      change("set", "lastError", reason);
      change("rdone", pathKey, start, startedAt, "fail", Date.now() - startedAt);
      change("run", { k: "fail", a: currentAsked, ms: Date.now() - startedAt, r: reason, f: fetchedBytes, p: pieces.length });
      ev.k = "fail"; ev.r = String(reason || "").slice(0, 60); ev.f = fetchedBytes; ev.p = pieces.length; ev.c = config.conns;
      ev.hs = hostSummaryOfRun();
      var key = "origin:" + originHost;
      change("streak", key, 1);
      if ((state.streaks[key] || 0) >= 3) {
        change("breaker", key, { until: Date.now() + 5 * 60000, reason: "这类地址在镜像节点上取不到（" + reason + "）" });
        change("streak", key, null);
        notifyOnce("breaker-origin", 5 * 60000, "BiliAccel 暂时让路", originHost, "连续几次没能从镜像节点拿到数据（" + reason + "），先原样放行 5 分钟。");
      }
      strikePending(reason);
      storeFetched();
      finish({});
    }

    function requestPiece(host, piece, callback) {
      var headers = {};
      for (var key in forwardHeaders) headers[key] = forwardHeaders[key];
      headers.Range = "bytes=" + piece.start + "-" + piece.end;
      var sentAt = Date.now();
      $httpClient.get({
        url: host === originHost ? originalUrl : subScheme + "://" + host + path + mirrorQuery,
        headers: headers,
        timeout: BTRA_PIECE_TIMEOUT,
        "binary-mode": true,
        "auto-cookie": false
      }, function (error, response, data) {
        // Whatever goes wrong in here must end in "let the request through", never in a script that
        // hangs until Loon's timeout while the player waits.
        try {
          var problem = "";
          var range = null;
          if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") data = new Uint8Array(data);
          if (error || !response) problem = "网络错误 " + String(error || "");
          else if (Number(response.status) === 416) {
            // Beyond the end of the file (its length was not known yet): not this mirror's fault.
            var tail = /^bytes\s+\*\/(\d+)$/i.exec(String(header(response.headers, "Content-Range") || "").replace(/^\s+|\s+$/g, ""));
            callback("", null, tail ? Number(tail[1]) : 0, response, Date.now() - sentAt, true);
            return;
          }
          else if (Number(response.status) !== 206) problem = "HTTP " + response.status;
          else if (!data || typeof data.subarray !== "function") problem = "拿到的不是二进制数据";
          else {
            range = parseContentRange(header(response.headers, "Content-Range"));
            if (!range || range.start !== piece.start || range.end > piece.end) problem = "Content-Range 不对";
            else if (range.end < piece.end && range.end !== range.total - 1) problem = "少给了数据";
            else if (data.length !== range.end - range.start + 1) problem = "长度不符";
            else if (total && range.total !== total) problem = "文件总长度不一致";
          }
          callback(problem, data, range, response, Date.now() - sentAt, false);
        } catch (failure) {
          giveUp("脚本内部错误：" + String(failure && failure.message || failure));
        }
      });
    }

    // Retries and hedges go to the fastest mirror that still has a free connection and has not
    // been asked for this piece; mirrors that answered in this very run come first. A hedge copy
    // (upstream 0.9.4.1) only goes to a mirror measured BTRA_HEDGE_FASTER times faster than the one
    // it backs up — a copy on an equally slow mirror only takes a connection from the next piece.
    // Once the App has waited long (copy.late) any mirror will do.
    function pickHost(piece, attempt, used, copy) {
      if (attempt === 0 && used.indexOf(piece.slot.host) < 0 && !leftOut(piece.slot.host) && hasRoom(piece.slot.host)) return piece.slot.host;
      var proven = goodHosts.slice().sort(function (a, b) { return speedOf(b) - speedOf(a); });
      var candidates = proven.concat(knownHosts, unknownHosts, pool);
      var floor = copy && !copy.late && used.length ? speedOf(used[used.length - 1]) * BTRA_HEDGE_FASTER : 0;
      var seen = {};
      for (var index = 0; index < candidates.length; index += 1) {
        var host = candidates[index];
        if (seen[host] || used.indexOf(host) >= 0 || leftOut(host)) continue;
        seen[host] = true;
        // (Upstream also allows a mirror not measured yet. Here an unmeasured mirror may well be one
        // that swallows requests — its probes are abandoned when a run ends, so it is never found
        // out — and a copy sent there helps nobody. It gets copies only once the App has waited long.)
        if (floor > 0 && speedOf(host) < floor) continue;
        if (hasRoom(host)) return host;
      }
      return "";
    }

    function learnTotal(size, response) {
      if (!(size > 0) || total) return;
      total = size;
      contentType = contentType || header(response.headers, "Content-Type");
      change("total", pathKey, total, Date.now(), contentType);
      if (start > total - 1) { passThrough("起点超出文件"); return; }
      if (wantedEnd > total - 1) wantedEnd = total - 1;
      if (end > total - 1) end = total - 1;
      // Pieces beyond the end of the file are pointless: drop them from the queue, trim the one
      // that straddles the end.
      queue = queue.filter(function (piece) {
        if (piece.start > total - 1) { if (piece.extra) extraLeft -= 1; else mustLeft -= 1; return false; }
        if (piece.end > total - 1) piece.end = total - 1;
        return true;
      });
      for (var index = 0; index < must.length; index += 1) if (must[index].e > total - 1) must[index].e = total - 1;
    }

    var waiting = [];
    var hedgeWanted = [];
    function pump() {
      for (var h = 0; h < hedgeWanted.length && !failed && !finished;) {
        var wanted = hedgeWanted[h];
        if (wanted.done || wanted.launched > 2 || wanted.launch({ late: true })) { hedgeWanted.splice(h, 1); continue; }
        h += 1;
      }
      for (var w = 0; w < waiting.length && !failed && !finished;) {
        var parked = waiting[w];
        if (parked.done || parked.inflight > 0) { waiting.splice(w, 1); continue; }
        if (parked.launch()) { waiting.splice(w, 1); continue; }
        if (inflight === 0 || parked.launched >= 4) { giveUp("没有能用的镜像"); return; }
        w += 1;
      }
      while (queue.length && inflight < config.conns && !failed && !finished) {
        var piece = queue[0];
        if (!launchedAt) launchedAt = Date.now();
        var task = createTask(piece);
        if (!task.launch()) {
          // No mirror can take it right now. While connections are open one of them will free up
          // (pump runs again then); with none open there is nowhere to send it at all.
          tasks.pop();
          if (inflight > 0) break;
          queue.shift();
          if (piece.extra) { extraLeft -= 1; continue; }
          giveUp("没有能用的镜像");
          return;
        }
        queue.shift();
        if (duplicateMust && !piece.extra) task.launch();
      }
    }

    function createTask(piece) {
      var task = { piece: piece, done: false, launched: 0, inflight: 0, used: [] };
      task.launch = function (copy) {
        if (task.done || failed || finished || task.launched >= (piece.extra ? 2 : 4)) return false;
        var host = pickHost(piece, task.launched, task.used, copy || null);
        if (!host) return false;
        if (!task.launched) task.launchedAt = Date.now();
        task.launched += 1;
        task.inflight += 1;
        inflight += 1;
        hostInflight[host] = (hostInflight[host] || 0) + 1;
        task.used.push(host);
        requestPiece(host, piece, function (problem, data, range, response, ms, eof) {
          task.inflight -= 1;
          inflight -= 1;
          hostInflight[host] -= 1;
          if (finished || failed) {
            if (delivered && !failed && !problem && !eof && !task.done) { task.done = true; lateStore(piece, data); }
            return;
          }
          if (eof) {
            // The file ended before this piece: nothing to store, nobody to blame.
            learnTotal(range, response);
            if (finished) return;
            if (!task.done) { task.done = true; if (piece.extra) extraLeft -= 1; else mustLeft -= 1; }
            if (!mustLeft && !mustDoneAt) mustDoneAt = Date.now();
            pump();
            settle();
            return;
          }
          if (problem) {
            var status = response ? Number(response.status) : 0;
            // (The other stream's connections to that mirror count too: it sees them all.)
            var carrying = (hostInflight[host] || 0) + busyCount(host);
            if ((status === 412 || status === 429) && carrying > 0) {
              // Too many connections for this mirror's taste (others to it were still open) — not a
              // broken mirror (upstream 0.9.4.0): one level down on the automatic count; the mirror
              // keeps its place but gets no more connections at once than it was carrying.
              capHere[host] = carrying;
              change("limited", host, Date.now(), carrying);
              change("bump", "limited", 1);
              if (!pushedBack) { pushedBack = true; autoPushback(Date.now(), status); }
              // A refusal like this costs the piece none of its tries, and the mirror stays open to it
              // once it has room again (its cap is now what it carries, and only goes down from here).
              task.launched -= 1;
              var usedAt = task.used.lastIndexOf(host);
              if (usedAt >= 0) task.used.splice(usedAt, 1);
            } else if (status === 412 || status === 429) {
              // Refused although we had no other connection to it: it wants even fewer (other clients,
              // or it has not noticed our last one close), or it refuses us for another reason. One
              // connection at most for a while, and it counts as a failure; this piece looks elsewhere
              // (it keeps the mirror in its list of tried ones), without that costing it a try.
              capHere[host] = 1;
              change("limited", host, Date.now(), 1);
              change("bump", "limited", 1);
              change("host", host, false, Date.now());
              task.launched -= 1;
            } else if (status >= 400 && status < 500 && state.hosts[host] && state.hosts[host].ok > 0) {
              // A mirror that has served before refuses this file: count it against the pair only.
              // One that refuses several different files lately is failing as a whole after all.
              refusedHere[host] = true;
              change("refused", host, addressKey, Date.now());
              var refusedFiles = 0;
              for (var pairName in state.pairs) if (pairName.indexOf(host + " ") === 0 && Date.now() - state.pairs[pairName].t < BTRA_PAIR_TTL) refusedFiles += 1;
              if (refusedFiles >= 3) change("host", host, false, Date.now());
            } else if (piece.slot.control && host === originHost) {
              controlInfo = { b: piece.end - piece.start + 1, done: 0, err: problem.slice(0, 40), ms: ms };
            } else change("host", host, false, Date.now());
            if (!task.done) {
              if (!task.launch() && task.inflight === 0) {
                if (piece.extra) { task.done = true; extraLeft -= 1; settle(); }
                // No mirror has room right now, but connections are still open: it waits for one
                // (pump tries it first); with none open, or its tries used up, the run gives up.
                else if (inflight > 0 && task.launched < 4) waiting.push(task);
                else giveUp(shortHost(host) + "：" + problem);
              }
            }
            pump();
            settle();
            return;
          }
          runHostBytes[host] = (runHostBytes[host] || 0) + data.length;
          if (piece.slot.control && host === originHost) {
            controlInfo = { b: data.length, done: 1, ms: ms, kb: Math.round(data.length / Math.max(1, ms) * 1000 / 1024) };
            change("ewma", "ctlBps", data.length / Math.max(1, ms));
          }
          change("host", host, true, Date.now(), ms > 0 ? data.length / ms : 0, data.length);
          if (goodHosts.indexOf(host) < 0) goodHosts.push(host);
          learnTotal(range ? range.total : 0, response);
          if (finished) return;
          if (task.done) { pump(); return; }
          task.done = true;
          results[piece.index] = { start: piece.start, data: data, extra: piece.extra };
          fetchedBytes += data.length;
          change("bump", "pieces", 1);
          if (piece.extra) extraLeft -= 1;
          else {
            mustLeft -= 1;
            var segment = null;
            for (var index = 0; index < must.length && !segment; index += 1) if (!must[index].entry && must[index].s <= piece.start && must[index].e >= piece.start) segment = must[index];
            if (segment) {
              if (!segment.bytes) segment.bytes = new Uint8Array(segment.e - segment.s + 1);
              segment.bytes.set(data.subarray(0, Math.min(data.length, segment.bytes.length - (piece.start - segment.s))), piece.start - segment.s);
            }
            if (!mustLeft) mustDoneAt = Date.now();
          }
          pump();
          settle();
          hedge(false, false);
        });
        return true;
      };
      tasks.push(task);
      return task;
    }

    // A mirror that swallows a request without answering would hold the whole reply up until its
    // timeout. When only stragglers are left (or the expected time has long passed), ask a mirror
    // that has just proved itself for the same bytes as well. Only the App's own bytes are worth it.
    // `late`: the App has been waiting long enough that any mirror is worth a copy.
    function hedge(byTimer, late) {
      if (failed || finished || !mustLeft) return;
      var open = 0;
      for (var index = 0; index < tasks.length; index += 1) if (!tasks[index].done && !tasks[index].piece.extra) open += 1;
      if (!open) return;
      if (!byTimer && (open > 2 || open === mustCount)) return;
      // Once the App has waited long every stuck piece of its own gets a copy, however many there
      // are (a mirror that went silent may hold several of them).
      var budget = (late ? Math.max(BTRA_HEDGE_BUDGET * 2, hedges + open) : BTRA_HEDGE_BUDGET) - hedges;
      for (var pick = 0; pick < tasks.length && budget > 0; pick += 1) {
        var task = tasks[pick];
        if (inflight >= config.conns + BTRA_HEDGE_BUDGET) break;
        if (task.done || task.piece.extra || task.inflight < 1 || task.launched > 2) continue;
        if (task.launch({ late: !!late })) { budget -= 1; hedges += 1; }
        // Late, and every mirror is at its limit (read-ahead holds the connections): the copy goes
        // out on the next connection that frees up, before any new read-ahead.
        else if (late && hedgeWanted.indexOf(task) < 0) { hedgeWanted.push(task); budget -= 1; hedges += 1; }
      }
    }

    function storeFetched() {
      if (!caching) return;
      // Everything fetched (the App's bytes too, for a retry or a step back) merged into contiguous
      // runs; each run becomes one cache entry.
      var list = [];
      for (var index = 0; index < results.length; index += 1) if (results[index]) list.push(results[index]);
      list.sort(function (a, b) { return a.start - b.start; });
      var run = [];
      var runBytes = 0;
      function flush() {
        if (!run.length) return;
        var bytes = new Uint8Array(runBytes);
        var offset = 0;
        for (var r = 0; r < run.length; r += 1) { bytes.set(run[r].data, offset); offset += run[r].data.length; }
        try { if (!storeEntry(pathKey, run[0].start, bytes)) change("flag", "cacheOff", "写入存储失败"); } catch (_error) { change("flag", "cacheOff", "写入存储出错"); }
        run = [];
        runBytes = 0;
      }
      for (var l = 0; l < list.length; l += 1) {
        if (run.length && (run[run.length - 1].start + run[run.length - 1].data.length !== list[l].start || runBytes + list[l].data.length > 1048576)) flush();
        run.push(list[l]);
        runBytes += list[l].data.length;
      }
      flush();
    }

    // Should Loon keep this run alive after $done (it does not, as far as is known), pieces that
    // arrive late still go into the cache (bookkeeping straight in the store; the run's own ops are
    // long committed).
    function lateStore(piece, data) {
      if (!caching || data.length !== piece.end - piece.start + 1) return;
      try {
        var key = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
        if ($persistentStore.write(b64encode(data), BTRA_CACHE_PREFIX + key) === false) return;
        var fresh = loadState();
        if (fresh.flags.cacheOff) { $persistentStore.write("", BTRA_CACHE_PREFIX + key); return; }
        fresh.cache.push({ k: key, p: pathKey, s: piece.start, e: piece.end, b: data.length, t: Date.now() });
        fresh.stats.late = (fresh.stats.late || 0) + 1;
        var dropped = evict(fresh, Date.now());
        $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
        for (var d = 0; d < dropped.length; d += 1) $persistentStore.write("", BTRA_CACHE_PREFIX + dropped[d].k);
      } catch (_error) {}
    }

    var graceTimer = null;

    function settle() {
      if (failed || finished || delivered || mustLeft) return;
      // Pieces sent to unmeasured mirrors are not waited for: they arrive or they do not.
      var pendingCore = 0;
      for (var pending = 0; pending < tasks.length; pending += 1) if (!tasks[pending].done && tasks[pending].piece.extra && !tasks[pending].piece.slot.explore) pendingCore += 1;
      if (extraLeft > 0 && !pendingCore) extraLeft = 0;
      if (extraLeft > 0) {
        if (typeof setTimeout !== "function") extraLeft = 0;
        else {
          // The read-ahead pieces were cut shorter than the App's, so the healthy ones are already
          // here; a short wait for the rest, then the answer goes out.
          if (graceTimer === null) {
            var grace = Math.max(150, Math.min(400, launchedAt + BTRA_SLICE_MS + 400 - Date.now()));
            graceTimer = setTimeout(function () { extraLeft = 0; settle(); }, grace);
          }
          return;
        }
      }
      delivered = true;
      strikePending("late");
      var body = assemble();
      if (!body) { giveUp("拼装后的长度不符"); return; }
      var elapsed = Math.max(1, Date.now() - startedAt);
      var batchMs = Math.max(1, Date.now() - launchedAt);
      change("bump", "batches", 1);
      change("bump", "fetched", fetchedBytes);
      change("bump", "prepMs", launchedAt - startedAt);
      change("bump", "mustMs", mustDoneAt - startedAt);
      change("bump", "allMs", elapsed);
      change("set", "lastCapacity", capacity);
      // Only batches that keep the connections busy say something about the speed; a small gap
      // filled with a few pieces is bound by latency, not throughput.
      var full = pieces.length >= slots.length / 2;
      if (full) change("ewma", "bps", fetchedBytes / batchMs);
      if (full && config.auto) change("asample", { l: runLevel, b: fetchedBytes, ms: batchMs, t: Date.now() });
      // The App waiting for its own bytes is the sign that the connections are too few (a long wait
      // counts as a stall). The level only climbs on it; whether that helped is judged later.
      var waited = mustDoneAt - startedAt;
      // The App asking for its next block as soon as it has the last one, and spending most of the
      // last seconds waiting for this script, says the same as the browser's low, not growing buffer:
      // the downloads are what holds playback back, even when each single answer is quick. (A player
      // with a full buffer pauses between requests, or its requests hit the cache.)
      var busyMs = elapsed;
      var spanFrom = startedAt;
      for (var rc = 0; rc < state.recent.length; rc += 1) {
        var seenRun = state.recent[rc];
        if (seenRun.p !== pathKey || seenRun.t === startedAt || !(seenRun.ms >= 0) || startedAt - seenRun.t > 12000) continue;
        busyMs += seenRun.ms;
        if (seenRun.t < spanFrom) spanFrom = seenRun.t;
      }
      var demand = Date.now() - spanFrom >= 3000 ? busyMs / (Date.now() - spanFrom) : 0;
      if (waited > BTRA_AUTO_STALL_MS) autoUp(Date.now(), "App 等了 " + (waited / 1000).toFixed(1) + " 秒", true);
      else if (waited > BTRA_AUTO_WAIT_MS && full) autoUp(Date.now(), "App 等了 " + (waited / 1000).toFixed(1) + " 秒", false);
      else if (demand > 0.6 && full) autoUp(Date.now(), "App 一直在等数据（最近 " + Math.round(demand * 100) + "% 的时间）", false);
      if (state.streaks["origin:" + originHost]) change("streak", "origin:" + originHost, null);
      notifyOnce("working-" + ev.a, 6 * 3600000, "BiliAccel 正在加速（" + appName(ev.a) + "）", (config.auto ? "自动连接数（现在 " + config.conns + "）" : config.conns + " 连接") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN"), "刚才这一批 " + sizeText(fetchedBytes) + " 用了 " + (batchMs / 1000).toFixed(1) + " 秒（" + pieces.length + " 个子块）。统计页：" + BTRA_STATUS_URL);
      storeFetched();
      respond(body, cachedBytes, pieces.length, elapsed, { fetched: fetchedBytes, mustMs: mustDoneAt - startedAt, capacity: capacity, slots: slots.length, batchMs: batchMs, hosts: hostSummaryOfRun(), control: controlSummary() });
    }

    if (typeof setTimeout === "function") {
      // Never longer than the App's own route would take for the same bytes (when that is known): on a
      // network where the App's own host is fast, a slow batch goes back to it quickly.
      var ownBps = speedOf(originHost);
      var ownRouteMs = ownBps > 0 ? mustBytes / ownBps + 400 : 5000;
      var deadlineMs = Math.max(BTRA_DEADLINE, Math.min(8000, Math.round(ownRouteMs * 1.2)));
      ev.dl = deadlineMs;
      setTimeout(function () { giveUp("超过 " + (deadlineMs / 1000).toFixed(1) + " 秒还没拼齐"); }, deadlineMs);
      setTimeout(function () { hedge(true, false); }, Math.round(BTRA_SLICE_MS * 1.4));
      setTimeout(function () { hedge(true, true); }, Math.round(BTRA_SLICE_MS * 2.2));
      setTimeout(function () { hedge(true, true); }, Math.round(BTRA_SLICE_MS * 3.2));
    }
    // A good moment to send the live record: this run will take a while anyway, and GitHub's answer
    // usually comes back before ours goes out.
    telemetryFlush("run", false);
    pump();
    if (!mustLeft) settle();
  }

  try {
    main();
  } catch (error) {
    try { console.log("BTR App: " + String(error && error.stack || error)); } catch (_error) {}
    if (!finished) { finished = true; $done({}); }
  }
})();
