#!/usr/bin/env node
/**
 * scripts/build/verify-multi-instance.mjs — can this run 50 times at once?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The claim: the same application can run many times on one computer
 * without any of them colliding. The proof has three parts:
 *
 *   1. every instance gets a DIFFERENT port block
 *   2. no block overlaps another block
 *   3. no block touches a port that is already listening, and no block
 *      touches the primary instance's own ports (the gateway, the MCP
 *      servers, the bridge)
 *
 * Usage:
 *   node scripts/build/verify-multi-instance.mjs
 *   node scripts/build/verify-multi-instance.mjs --count=50 --json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { allocatePorts, readLiveListenPorts, isPortFree } from "./lib/ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const { getMcpServers } = require(path.join(ROOT, "tools", "mcp-registry.js"));

const JSON_OUT = process.argv.includes("--json");
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const COUNT = parseInt(argOf("count", "50"), 10);

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`, head: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function main() {
  const report = { at: new Date().toISOString(), count: COUNT };
  const live = readLiveListenPorts();

  // the primary instance owns the host ports - a block must never touch them
  const hostPorts = new Set();
  for (const s of getMcpServers()) hostPorts.add(s.port);
  const env = require(path.join(ROOT, "tools", "mcp-registry.js")).readEnv();
  for (const key of ["PORT", "BRIDGE_PORT", "UDS_PORT", "ADAPTER_HTTP_PORT", "ADAPTER_HTTPS_PORT"]) {
    const v = parseInt(env[key] || "", 10);
    if (Number.isFinite(v)) hostPorts.add(v);
  }

  const blocks = [];
  const used = new Map();
  let collisions = 0;
  let overlaps = 0;

  for (let i = 0; i < COUNT; i++) {
    const projectPath = path.join(os.tmpdir(), `zc-instance-${String(i).padStart(3, "0")}`);
    fs.mkdirSync(projectPath, { recursive: true });
    const res = await allocatePorts(projectPath);
    const ports = [];
    for (const s of res.services) {
      if (s.httpPort) ports.push(s.httpPort);
      if (s.tlsPort) ports.push(s.tlsPort);
    }
    blocks.push({ i, base: res.base, ports });

    for (const p of ports) {
      if (used.has(p)) {
        overlaps++;
        log(C.bad(`   instance ${i} port ${p} collides with instance ${used.get(p)}`));
      }
      used.set(p, i);
      if (hostPorts.has(p)) {
        collisions++;
        log(C.bad(`   instance ${i} port ${p} is a host port`));
      }
      if (live.has(p)) {
        collisions++;
        log(C.bad(`   instance ${i} port ${p} is already listening`));
      }
    }
  }

  // every port must really be free right now
  let busy = 0;
  for (const b of blocks) {
    for (const p of b.ports) {
      if (!(await isPortFree(p))) {
        busy++;
        log(C.bad(`   port ${p} (instance ${b.i}) is not free`));
      }
    }
  }

  report.blocks = blocks.map((b) => ({ i: b.i, base: b.base, ports: b.ports.length }));
  report.uniquePorts = used.size;
  report.overlaps = overlaps;
  report.hostCollisions = collisions;
  report.busy = busy;
  report.ok = overlaps === 0 && collisions === 0 && busy === 0;

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(C.head(`${COUNT} instances on one computer`));
    log(`   blocks allocated   : ${blocks.length}`);
    log(`   distinct ports     : ${used.size}`);
    log(`   live listeners     : ${live.size} (all avoided)`);
    log(`   host ports avoided : ${[...hostPorts].sort((a, b) => a - b).join(", ")}`);
    log(`   block overlaps     : ${overlaps}`);
    log(`   host collisions    : ${collisions}`);
    log(`   ports not free     : ${busy}`);
    log("");
    log(
      report.ok
        ? C.ok(`   RESULT: ${COUNT} instances fit without a single collision`)
        : C.bad("   RESULT: collision detected"),
    );
  }
  process.exit(report.ok ? 0 : 1);
}

main();
