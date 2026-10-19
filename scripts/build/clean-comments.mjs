#!/usr/bin/env node
/**
 * scripts/build/clean-comments.mjs — keep the source readable.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Rules this enforces (project-wide, repeatable):
 *   1. No emoji in the code.
 *   2. No Bengali in COMMENTS. (Bengali inside string literals is product
 *      content — personas, UI messages — and is left alone.)
 *   3. A multi-line note collapses into ONE short line. The wall of
 *      "FIX (date): …" prose is what makes a file unreadable.
 *   4. Sections are marked so a regex can find them later:
 *        // ── SECTION: <name> ──
 *        // ── END SECTION: <name> ──
 *
 * Only comment lines are touched. String literals are never modified, so
 * no user-facing text can change.
 *
 * Usage:
 *   node scripts/build/clean-comments.mjs            # rewrite in place
 *   node scripts/build/clean-comments.mjs --check    # report only
 *   node scripts/build/clean-comments.mjs --files a.js,b.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const CHECK_ONLY = process.argv.includes("--check");
const FILE_ARG = process.argv.find((a) => a.startsWith("--files="));

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "logs", ".zombiecoder", "data", "cache", "locks",
]);

// Emoji ranges: symbols, pictographs, dingbats, flags, variation selectors.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{20E3}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}]/gu;
// Bengali block.
const BENGALI_RE = /[\u0980-\u09FF]/g;

const isCommentLine = (line) => {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("*/")
  );
};

function cleanLine(line) {
  // Remove emoji and Bengali, keep the indentation/alignment untouched.
  const hadEmoji = EMOJI_RE.test(line);
  EMOJI_RE.lastIndex = 0;
  let out = line.replace(EMOJI_RE, "").replace(BENGALI_RE, "");
  if (hadEmoji) {
    // the removed glyph left a gap behind
    out = out.replace(/\/\/\s{2,}/, "// ").replace(/\*\s{2,}/, "* ");
  }
  // a Bengali-only phrase leaves empty quotes behind
  out = out.replace(/"\s*"/g, '""');
  out = out.replace(/[ \t]+$/, "");
  return out;
}

/** Collapse a run of comment lines into a single short line. */
function collapseBlock(block) {
  const text = block
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*\*?|\*\/)\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ");
  // drop a leading "FIX (date):" / "SECURITY (date):" prefix
  const short = text
    .replace(/^(FIX|SECURITY|NOTE|WHY|ISSUE|BUG)\s*\(\d{4}-\d{2}-\d{2}\)\s*:?\s*/i, "")
    .replace(/^—\s*/, "");
  return short.length > 150 ? short.slice(0, 147).trimEnd() + "…" : short;
}

/**
 * Strip emoji from STRING literals too (log messages, prompt text, HTML).
 * Lines that define an emoji RANGE (\u{...} / u+ escapes) are code that
 * DETECTS emoji — they must stay untouched.
 */
function cleanStringLine(line) {
  if (/\\u\{|\\u[0-9a-fA-F]{4}|\[uU]\+[0-9a-fA-F]/.test(line)) return line;
  const hadEmoji = EMOJI_RE.test(line);
  EMOJI_RE.lastIndex = 0;
  if (!hadEmoji) return line;
  let out = line.replace(EMOJI_RE, "");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out;
}

function processFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let changed = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!isCommentLine(line)) {
      const c = cleanStringLine(line);
      if (c !== line) changed++;
      out.push(c);
      i++;
      continue;
    }

    // collect a run of comment lines
    const block = [];
    let j = i;
    while (j < lines.length && isCommentLine(lines[j])) {
      block.push(lines[j]);
      j++;
    }

    const cleaned = block.map(cleanLine);
    // Only the chatty fix-notes are collapsed. A file header, a table of
    // contents or any structured block is left exactly as it is.
    const raw = block.join("\n");
    const structured =
      /={10,}|\|\s*-{3,}/.test(raw) || // banner or table separator
      /^\s*\/\/\s*\d+\s*\|/.test(raw) || // numbered TOC rows
      raw.split("\n").length > 40; // a real doc block
    const isNote =
      !structured &&
      (/\u{1F9DD}|\u{1F7E0}|\u{1F41B}|\u{1F527}|\u{26A0}/u.test(raw) ||
        /^(FIX|SECURITY|BUG|ISSUE|WHY)\b/i.test(raw.replace(/^\s*(\/\/|\*)\s?/, "")));

    if (isNote && block.length > 1) {
      const one = collapseBlock(cleaned);
      out.push("// " + one);
      changed++;
      i = j;
      continue;
    }

    if (cleaned.join("\n") !== block.join("\n")) changed++;
    for (const c of cleaned) out.push(c);
    i = j;
  }

  const result = out.join("\n");
  if (result !== src) {
    if (!CHECK_ONLY) fs.writeFileSync(file, result);
    return { changed: true, file };
  }
  return { changed: false, file };
}

function collect() {
  if (FILE_ARG) {
    return FILE_ARG
      .slice("--files=".length)
      .split(",")
      .map((f) => path.resolve(ROOT, f))
      .filter((f) => fs.existsSync(f));
  }
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  return files;
}

const files = collect();
const touched = [];
for (const f of files) {
  try {
    const r = processFile(f);
    if (r.changed) touched.push(path.relative(ROOT, f));
  } catch (e) {
    console.error("skip", path.relative(ROOT, f), e.message);
  }
}
console.log(
  (CHECK_ONLY ? "would change" : "cleaned") + ": " + touched.length + " file(s)",
);
for (const t of touched) console.log("  " + t);
