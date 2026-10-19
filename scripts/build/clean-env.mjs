#!/usr/bin/env node
/**
 * scripts/build/clean-env.mjs — rewrite .env with clean, short comments.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A .env is read by humans and by tools. Long prose above a single
 * setting is noise: the value is what matters, and one short line is
 * enough to say what it does.
 *
 * Rules:
 *   1. Section banners stay (they are the navigation).
 *   2. A comment directly above a setting becomes that setting's doc,
 *      collapsed to ONE line (max 90 chars, no emoji).
 *   3. Orphan comments (no setting below them) are dropped.
 *   4. Commented-out settings are dropped — they are settings, not docs.
 *   5. Values are never touched.
 *
 * Usage:
 *   node scripts/build/clean-env.mjs            # rewrite .env
 *   node scripts/build/clean-env.mjs --check    # report only
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TARGET = path.join(ROOT, ".env");
const CHECK_ONLY = process.argv.includes("--check");

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const BENGALI_RE = /[\u0980-\u09FF]/g;

const isBanner = (l) => /^#\s*[═─]{3,}/.test(l);
const isSetting = (l) => /^[A-Z0-9_]+=/.test(l);
const isCommentedSetting = (l) => /^#\s*[A-Z0-9_]+=/.test(l);

function short(text) {
  let t = text.replace(EMOJI_RE, "").replace(BENGALI_RE, "").trim();
  t = t.replace(/^[-–—]\s*/, "").replace(/\s{2,}/g, " ");
  t = t.replace(/[.;,]+$/, "");
  if (t.length > 90) t = t.slice(0, 87).trimEnd() + "...";
  return t;
}

function clean() {
  const lines = fs.readFileSync(TARGET, "utf8").split("\n");
  const out = [];
  let pending = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      pending = [];
      continue;
    }
    if (isBanner(line)) {
      pending = [];
      // a blank line before a banner keeps the file readable
      if (out.length && out[out.length - 1] !== "") out.push("");
      // never repeat the same banner twice in a row
      if (out.length && out[out.length - 1] === line) continue;
      out.push(line);
      continue;
    }
    if (isCommentedSetting(line)) {
      pending = [];
      continue; // a commented-out setting is not documentation
    }
    if (line.trim().startsWith("#")) {
      pending.push(line.trim().replace(/^#\s?/, ""));
      continue;
    }
    if (isSetting(line)) {
      // the FIRST comment line states what the setting is; the rest is
      // usually explanation or a leftover from an older layout
      const doc = pending.length ? short(pending[0]) : "";
      if (doc) out.push("# " + doc);
      pending = [];
      out.push(line);
      continue;
    }
    pending = [];
    out.push(line);
  }

  // collapse repeated blank lines
  const squeezed = [];
  for (const l of out) {
    if (l === "" && squeezed.length && squeezed[squeezed.length - 1] === "") continue;
    squeezed.push(l);
  }
  return squeezed.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const result = clean();
const current = fs.readFileSync(TARGET, "utf8");
if (result === current) {
  console.log("clean-env: already clean");
} else if (CHECK_ONLY) {
  console.log("clean-env: would rewrite " + TARGET);
} else {
  fs.writeFileSync(TARGET, result);
  const before = current.split("\n").length;
  const after = result.split("\n").length;
  console.log(`clean-env: ${before} -> ${after} lines`);
}
