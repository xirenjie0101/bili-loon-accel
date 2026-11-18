#!/usr/bin/env node
"use strict";
/*
 * Builds dist/ from src/. No dependencies.
 *
 *   node build.js                                   script URLs point at this repository's dist/
 *   node build.js --base https://raw.githubusercontent.com/<you>/<repo>/main/dist
 *   node build.js --telemetry <owner>/<repo>        default telemetry repository shown in the plugin
 *
 * Outputs
 *   dist/bili-accel.js       the one Loon script (media, API sniff, status page, cron, diagnostics)
 *   dist/BiliAccel.plugin    the Loon plugin (Loon 3.5.1 build 983+ script syntax)
 *   dist/icon.png
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const DEFAULT_BASE = "https://raw.githubusercontent.com/xirenjie0101/bili-loon-accel/main/dist";
const base = option("--base", DEFAULT_BASE).replace(/\/+$/, "");
const telemetryRepo = option("--telemetry", "xirenjie0101/bili-loon-accel-telemetry");
const repoMatch = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(`${base}/`);
const homepage = repoMatch ? `https://github.com/${repoMatch[1]}/${repoMatch[2]}` : "https://github.com/MrTangLuyao/Bilibili-thread-ripper";

function fill(template, values) {
  let output = template;
  for (const [token, value] of Object.entries(values)) output = output.split(token).join(value);
  const left = /__BLA_[A-Z_]+__/.exec(output);
  if (left) throw new Error(`unfilled token ${left[0]}`);
  return output;
}

const values = {
  __BLA_VERSION__: pkg.version,
  __BLA_DATE__: pkg.releaseDate,
  __BLA_HOMEPAGE__: homepage,
  __BLA_SCRIPT_URL__: `${base}/bili-accel.js`,
  __BLA_ICON_URL__: `${base}/icon.png`,
  __BLA_TELEMETRY_REPO__: telemetryRepo
};

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "bili-accel.js"), fill(read("src/bili-accel.template.js"), values));
fs.writeFileSync(path.join(root, "dist", "BiliAccel.plugin"), fill(read("src/BiliAccel.plugin.template"), values));
fs.copyFileSync(path.join(root, "src", "icon.png"), path.join(root, "dist", "icon.png"));
console.log(`built ${pkg.version} → dist/ (scripts from ${base})`);
