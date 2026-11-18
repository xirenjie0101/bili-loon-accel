#!/usr/bin/env node
/*
 * Reads the live telemetry the plugin writes into the telemetry repository and prints what it means.
 *
 *   node tools/live.mjs <clone-of-telemetry-repo> [--minutes 30] [--watch 20] [--device abcd2345] [--raw]
 *
 * It runs `git pull` in the clone first (every --watch seconds, if given), then reads live/<device>/<day>/*.json.
 * Output: one line per media request / API sniff / test, then a per-app summary with the verdict
 * ("accelerated", "requests never reach the script", "only PCDN addresses", …).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg) && !/^[a-z2-9]{8}$/.test(arg)) || ".";
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const minutes = Number(option("--minutes", 30));
const watch = Number(option("--watch", 0));
const device = option("--device", "");
const raw = args.includes("--raw");

const APP = { intl: "国际版", cn: "国内版", "cn?": "国内版?", hd: "HD", bstar: "Bstar", web: "网页", "?": "未知" };
const time = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const kb = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}M` : `${Math.round((bytes || 0) / 1024)}K`;
const short = (host) => String(host || "").replace(/\.bilivideo\.(?:com|cn)$/, "").replace(/\.akamaized\.net$/, "@akam");

function pull() {
  try { execFileSync("git", ["-C", dir, "pull", "-q", "--ff-only"], { stdio: "pipe" }); }
  catch (error) { console.error(`git pull failed: ${String(error.stderr || error.message).trim()}`); }
}

function load() {
  const root = path.join(dir, "live");
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const dev of fs.readdirSync(root)) {
    if (device && dev !== device) continue;
    for (const day of fs.readdirSync(path.join(root, dev))) {
      for (const name of fs.readdirSync(path.join(root, dev, day))) {
        if (!name.endsWith(".json")) continue;
        try { files.push({ name: `${dev}/${day}/${name}`, ...JSON.parse(fs.readFileSync(path.join(root, dev, day, name), "utf8")) }); } catch (_error) {}
      }
    }
  }
  return files.sort((a, b) => a.sent - b.sent);
}

function describe(event) {
  const app = APP[event.a] || event.a || "";
  if (event.ty === "m") {
    const bits = [time(event.t), app.padEnd(4), (event.k || "?").padEnd(7), `${event.sc}${event.pt ? ":" + event.pt : ""}`, short(event.h), event.q ? `q${event.q}` : "", event.rg === "b" ? `ask ${kb(event.as)}` : event.rg === "o" ? `ask ${event.st}K-` : `rg:${event.rg}`];
    if (event.sv) bits.push(`gave ${kb(event.sv)} in ${event.ms}ms`);
    else if (event.ms) bits.push(`${event.ms}ms`);
    if (event.mw) bits.push(`app waited ${event.mw}ms`);
    if (event.f) bits.push(`fetched ${kb(event.f)}${event.bk ? ` @${event.bk}KB/s` : ""} over ${event.n} conns (${event.c})`);
    if (event.hs) bits.push(`hosts ${event.hs[0]}: ${event.hs.slice(1, 4).map((row) => `${short(row[0])} ${row[1]}K`).join(", ")}`);
    if (event.ca) bits.push(`from cache ${kb(event.ca)}`);
    if (event.ctl) bits.push(event.ctl.done ? `baseline ${event.ctl.kb}KB/s` : event.ctl.kbMax ? `baseline <${event.ctl.kbMax}KB/s` : event.ctl.err ? `baseline err ${event.ctl.err}` : "baseline pending");
    if (event.ar) bits.push(`APP PACE ${event.ar}KB/s`);
    if (event.dup) bits.push(`repeat×${event.dup}`);
    if (event.sh) bits.push("short-reply");
    if (event.r) bits.push(`「${event.r}」`);
    if (event.ua && raw) bits.push(event.ua);
    return bits.filter(Boolean).join("  ");
  }
  if (event.ty === "api") return `${time(event.t)} ${app.padEnd(4)} API     ${event.via} ${event.host} ${event.ep}  ${event.n} addrs ${event.relay ? `(PCDN ${event.relay}) ` : ""}→ ${Object.entries(event.hosts || {}).map(([host, count]) => `${short(host)}×${count}`).join(" ")}${event.err ? `  ERR ${event.err}` : ""}${event.gz ? ` gz:${event.gz}` : ""}  ua=${event.ua}`;
  if (event.ty === "spd") return `${time(event.t)} SPEED   src=${event.src} host=${short(event.host)}  ${event.line || ""}${event.err ? ` ERR ${event.err}` : ""}\n          8-way: ${(event.B?.per || []).map((row) => `${row[0]} ${row[1]}${row[2] ? "!" + row[2] : ""}`).join(", ")}\n         16-way: ${(event.C?.per || []).map((row) => `${row[0]} ${row[1]}${row[2] ? "!" + row[2] : ""}`).join(", ")}`;
  if (event.ty === "rule") return `${time(event.t)} SELFTEST ${event.sc} rule fired (${event.ua})`;
  if (event.ty === "hi") return `${time(event.t)} HELLO   loon=${event.loon} store=${event.store} ungzip=${event.ungzip} seen=${event.seen} cfg=${JSON.stringify(event.cfg)}`;
  return `${time(event.t)} ${event.ty} ${JSON.stringify(event)}`;
}

function verdict(events, files) {
  const lines = [];
  const media = events.filter((event) => event.ty === "m");
  const apis = events.filter((event) => event.ty === "api");
  const apps = [...new Set([...media, ...apis].map((event) => event.a))];
  for (const app of apps) {
    const mine = media.filter((event) => event.a === app);
    const sniffs = apis.filter((event) => event.a === app);
    const kinds = {};
    for (const event of mine) kinds[event.k] = (kinds[event.k] || 0) + 1;
    const reasons = {};
    for (const event of mine) if (event.r) reasons[event.r] = (reasons[event.r] || 0) + 1;
    const offered = {};
    for (const event of sniffs) for (const [host, count] of Object.entries(event.hosts || {})) offered[host] = (offered[host] || 0) + count;
    const seenHosts = {};
    for (const event of mine) seenHosts[event.h] = (seenHosts[event.h] || 0) + 1;
    const pace = (list) => { const values = list.filter((event) => event.ar > 0 && event.as >= 131072).map((event) => event.ar).sort((a, b) => a - b); return values.length ? values[Math.floor(values.length / 2)] : 0; };
    const accelPace = pace(mine.filter((event) => ["miss", "part", "hit"].includes(event.k)));
    const obsPace = pace(mine.filter((event) => event.k === "obs" || event.k === "pass"));
    const baselines = mine.filter((event) => event.ctl?.done).map((event) => event.ctl.kb).sort((a, b) => a - b);
    const batch = mine.filter((event) => event.bk > 0).map((event) => event.bk).sort((a, b) => a - b);
    lines.push(`\n■ ${APP[app] || app}: ${mine.length} media requests · ${JSON.stringify(kinds)} · ${sniffs.length} playurl sniffs`);
    if (Object.keys(offered).length) lines.push(`  playurl offered: ${Object.entries(offered).map(([host, count]) => `${short(host)}×${count}`).join(" ")}`);
    if (Object.keys(seenHosts).length) lines.push(`  media seen from: ${Object.entries(seenHosts).map(([host, count]) => `${short(host)}×${count}`).join(" ")}`);
    if (Object.keys(reasons).length) lines.push(`  pass reasons: ${Object.entries(reasons).map(([reason, count]) => `${reason}×${count}`).join(" · ")}`);
    lines.push(`  app pace (median): accelerated ${accelPace || "—"} KB/s · untouched ${obsPace || "—"} KB/s · baseline one-conn ${baselines.length ? baselines[Math.floor(baselines.length / 2)] : "—"} KB/s · batch ${batch.length ? batch[Math.floor(batch.length / 2)] : "—"} KB/s`);
    // verdicts
    if (!mine.length && sniffs.length) {
      const relayOnly = Object.keys(offered).length && Object.keys(offered).every((host) => /mcdn|szbdyd|xycdn|mountaintoys|nexusedge|ahdohpiechei|^\d+\./.test(host));
      lines.push(relayOnly ? "  ⇒ App only got PCDN/relay addresses: nothing to accelerate unless playurl is rewritten." : "  ⇒ App got addresses but NO media request reached the script: QUIC, a local rule ahead of the plugin, MITM not trusted, or a host/port the rule misses (compare 'playurl offered').");
    } else if (mine.length && !mine.some((event) => ["miss", "part", "hit"].includes(event.k))) {
      lines.push(`  ⇒ Requests reach the script but none were accelerated (see pass reasons).`);
    } else if (accelPace && (obsPace || baselines.length)) {
      const reference = obsPace || baselines[Math.floor(baselines.length / 2)];
      lines.push(`  ⇒ Accelerated: app pace ${accelPace} KB/s vs ${reference} KB/s untouched → ×${(accelPace / reference).toFixed(1)}`);
    }
  }
  const last = files[files.length - 1];
  if (last) {
    lines.push(`\nlast file ${time(last.sent)} (${Math.round((Date.now() - last.sent) / 1000)}s ago) src=${last.src} ver=${last.ver} cfg=${JSON.stringify(last.cfg)} pending=${last.pending} dropped=${last.dropped} tq=${JSON.stringify(last.tq)}`);
    const agg = last.agg || {};
    lines.push(`conns=${agg.conns} ${agg.autoWhy ? `(${agg.autoWhy})` : ""} cache=${JSON.stringify(agg.cache)} breakers=${JSON.stringify(agg.breakers)}`);
    lines.push(`nodes (KB/s ok bad late benched refused limited): ${(agg.nodes || []).slice(0, 12).map((row) => `${row[0]} ${row[1]}/${row[2]}/${row[3]}/${row[4]}${row[5] ? "B" : ""}`).join(" · ")}`);
  }
  return lines.join("\n");
}

function once() {
  pull();
  const since = Date.now() - minutes * 60000;
  const files = load().filter((file) => file.sent >= since);
  const events = files.flatMap((file) => (file.ev || []).map((event) => ({ ...event, dev: file.dev }))).sort((a, b) => a.t - b.t);
  console.log(`\n===== ${new Date().toLocaleString("zh-CN", { hour12: false })} · ${files.length} files · ${events.length} events in the last ${minutes} min =====`);
  for (const event of events) console.log(describe(event));
  console.log(verdict(events, files));
}

once();
if (watch > 0) setInterval(once, watch * 1000);
