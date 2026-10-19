/**
 * lib/certs.mjs — per-service TLS material + nginx configuration.
 *
 * Every service in the plan gets its OWN key pair. One shared key for every
 * endpoint is how a single leaked .pem compromises the whole deployment, and
 * it also makes it impossible to tell which service a request came from.
 *
 * Certificates are self-signed (no CA, no network, works offline) with a
 * proper SAN list, so hostname verification actually means something.
 *
 * Zero dependencies — shells out to the openssl CLI that ships with every
 * Linux box. Node >= 18.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CERT_DAYS = 825;
export const CA_DAYS = 3650;

function openssl(args, opts = {}) {
  return execFileSync("openssl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

export function opensslAvailable() {
  try {
    openssl(["version"]);
    return true;
  } catch {
    return false;
  }
}

/** SAN string: DNS entries + IP entries. */
function sanFor(hosts) {
  const parts = [];
  for (const h of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) parts.push("IP:" + h);
    else parts.push("DNS:" + h);
  }
  return parts.join(",");
}

/**
 * The project CA — ONE trust anchor for the whole instance.
 *
 * Why a CA and not self-signed leaves: a self-signed leaf carries
 * CA:FALSE, so OpenSSL refuses to accept it as its own trust anchor
 * ("self-signed certificate" / DEPTH_ZERO_SELF_SIGNED_CERT). A CA with
 * CA:TRUE can be a trust anchor, and every service then gets its OWN
 * leaf key signed by it — which is the shape you want anyway: one
 * protected CA key, per-service leaf keys, real chain verification.
 */
export function ensureCa({ dir, cn = "zombiecoder-local-ca", days = CA_DAYS, force = false }) {
  if (!opensslAvailable()) throw new Error("openssl CLI not found");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, "ca-key.pem");
  const certPath = path.join(dir, "ca-cert.pem");

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const fp = certFingerprint(certPath);
    if (fp) return { keyPath, certPath, fingerprint: fp, notAfter: certNotAfter(certPath), reused: true };
  }

  const cnf = path.join(dir, "ca-openssl.cnf");
  fs.writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_ca",
      "prompt = no",
      "[dn]",
      "C = BD", "ST = Barishal", "L = Dhaka", "O = ZombieCoder",
      "OU = Local CA", `CN = ${cn}`,
      "[v3_ca]",
      "basicConstraints = critical,CA:TRUE,pathlen:0",
      "keyUsage = critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", String(days), "-config", cnf,
  ]);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fs.unlinkSync(cnf);

  return { keyPath, certPath, fingerprint: certFingerprint(certPath), notAfter: certNotAfter(certPath), reused: false };
}

/**
 * Create (or reuse) a leaf key pair for one service, signed by the CA.
 * @returns {{name,keyPath,certPath,fingerprint,notAfter,hosts,reused}}
 */
export function ensureServiceCert({ name, dir, hosts = ["localhost", "127.0.0.1"], ca, days = CERT_DAYS, force = false }) {
  if (!opensslAvailable()) throw new Error("openssl CLI not found");
  if (!ca) throw new Error("ensureServiceCert needs the project CA (ca:{keyPath,certPath})");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, `${name}-key.pem`);
  const certPath = path.join(dir, `${name}-cert.pem`);

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const fp = certFingerprint(certPath);
    // Reuse only when the certificate still covers the wanted names. A
    // renamed public domain must produce a NEW certificate, otherwise the
    // tunnel gets "no alternative certificate subject name matches".
    const san = certSans(certPath);
    const covers = hosts.every((h) => san.includes(h));
    if (fp && covers) {
      return { name, keyPath, certPath, fingerprint: fp, notAfter: certNotAfter(certPath), hosts, reused: true };
    }
  }

  const san = sanFor(hosts);
  const extCnf = path.join(dir, `${name}-ext.cnf`);
  fs.writeFileSync(
    extCnf,
    [
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = ${san}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // leaf key + CSR
  const csr = path.join(dir, `${name}.csr`);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csr, "-subj", `/C=BD/ST=Barishal/L=Dhaka/O=ZombieCoder/OU=${name}/CN=${hosts[0]}`]);

  // sign it with the project CA
  openssl([
    "x509", "-req", "-in", csr, "-CA", ca.certPath, "-CAkey", ca.keyPath,
    "-CAcreateserial", "-out", certPath, "-days", String(days), "-sha256",
    "-extfile", extCnf,
  ]);

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fs.unlinkSync(csr);
  fs.unlinkSync(extCnf);

  return {
    name,
    keyPath,
    certPath,
    fingerprint: certFingerprint(certPath),
    notAfter: certNotAfter(certPath),
    hosts,
    reused: false,
  };
}

/** The subjectAltName entries of a certificate, as plain names. */
export function certSans(certPath) {
  try {
    const out = openssl(["x509", "-in", certPath, "-noout", "-ext", "subjectAltName"]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("DNS:") || l.startsWith("IP Address:"))
      .map((l) => l.replace(/^(DNS|IP Address):/, "").trim());
  } catch {
    return [];
  }
}

export function certFingerprint(certPath) {
  try {
    return openssl(["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"])
      .split("=")[1]
      .trim();
  } catch {
    return null;
  }
}

export function certNotAfter(certPath) {
  try {
    return openssl(["x509", "-in", certPath, "-noout", "-enddate"]).split("=")[1].trim();
  } catch {
    return null;
  }
}

export function certCheck(certPath, caPath) {
  // verify the leaf against the project CA (real chain check)
  try {
    const args = caPath
      ? ["verify", "-CAfile", caPath, certPath]
      : ["verify", "-CAfile", certPath, certPath];
    const out = openssl(args);
    return { ok: /OK$/.test(out.trim()), out: out.trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.message).trim() };
  }
}

/**
 * Emit one nginx server block per service. Each block terminates TLS with
 * THAT service's own certificate and proxies to the service's plain HTTP
 * port on loopback.
 */
export function generateNginxConf({ services, certs, outFile, projectName, upstreamHost = "127.0.0.1" }) {
  const blocks = [];
  for (const svc of services) {
    if (!svc.tlsPort) continue;
    const cert = certs[svc.name];
    if (!cert) continue;
    blocks.push(
      [
        `# ── ${svc.name} — ${svc.desc}`,
        `server {`,
        `    listen              ${upstreamHost}:${svc.tlsPort} ssl;`,
        `    server_name         ${svc.hosts ? svc.hosts.join(" ") : "localhost"};`,
        ``,
        `    ssl_certificate     ${cert.certPath};`,
        `    ssl_certificate_key ${cert.keyPath};`,
        `    ssl_protocols       TLSv1.2 TLSv1.3;`,
        `    ssl_prefer_server_ciphers off;`,
        `    ssl_session_cache   shared:${svc.name}_SSL:4m;`,
        `    ssl_session_timeout 1h;`,
        ``,
        `    add_header X-Content-Type-Options nosniff always;`,
        `    add_header X-Frame-Options SAMEORIGIN always;`,
        `    add_header Referrer-Policy strict-origin-when-cross-origin always;`,
        ``,
        `    location / {`,
        `        proxy_pass         http://${upstreamHost}:${svc.httpPort};`,
        `        proxy_http_version 1.1;`,
        `        proxy_set_header   Host $host;`,
        `        proxy_set_header   X-Real-IP $remote_addr;`,
        `        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `        proxy_set_header   X-Forwarded-Proto $scheme;`,
        `        proxy_read_timeout 300s;`,
        `    }`,
        `}`,
        ``,
      ].join("\n"),
    );
  }
  const conf = [
    `# ─────────────────────────────────────────────────────────────`,
    `# ${projectName} — generated by scripts/build/tls-verify.mjs`,
    `# per-service TLS termination · every service has its own key pair`,
    `# ─────────────────────────────────────────────────────────────`,
    blocks.join("\n"),
  ].join("\n");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, conf, { mode: 0o644 });
  return outFile;
}

/**
 * Minimal standalone nginx.conf (used with `nginx -c`) so the generated
 * server blocks can be tested without touching the system nginx config.
 */
export function writeNginxRootConf({ includeFile, prefixDir, mimeTypes = "/etc/nginx/mime.types" }) {
  // The main context ONLY. Everything inside the http{} context lives in
  // the rendered site file (deploy/nginx.conf.template), so the two never
  // declare the same directive.
  const conf = [
    `worker_processes 1;`,
    `error_log ${prefixDir}/error.log warn;`,
    `pid ${prefixDir}/nginx.pid;`,
    ``,
    `events { worker_connections 1024; }`,
    ``,
    `http {`,
    `    include       ${mimeTypes};`,
    `    default_type  application/octet-stream;`,
    `    access_log            ${prefixDir}/access.log;`,
    `    client_body_temp_path ${prefixDir}/client_temp;`,
    `    proxy_temp_path       ${prefixDir}/proxy_temp;`,
    `    fastcgi_temp_path     ${prefixDir}/fastcgi_temp;`,
    `    uwsgi_temp_path       ${prefixDir}/uwsgi_temp;`,
    `    scgi_temp_path        ${prefixDir}/scgi_temp;`,
    `    sendfile      on;`,
    `    keepalive_timeout 65;`,
    `    server_tokens off;`,
    `    include ${includeFile};`,
    `}`,
    ``,
  ].join("\n");
  const p = path.join(prefixDir, "nginx.conf");
  fs.mkdirSync(prefixDir, { recursive: true });
  fs.writeFileSync(p, conf, { mode: 0o644 });
  for (const d of ["client_temp", "proxy_temp", "fastcgi_temp", "uwsgi_temp", "scgi_temp"]) {
    fs.mkdirSync(path.join(prefixDir, d), { recursive: true });
  }
  return p;
}
