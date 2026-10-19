/**
 * scripts/build/lib/hosts.mjs — the naming of a service.
 *
 * Two scripts must agree on the name a service answers to: the one that
 * issues the certificate and the one that routes the traffic. When they
 * disagree the service still works (nginx matches the first name it
 * knows) but the certificate no longer covers it, and the client gets a
 * name-mismatch error instead of an answer.
 *
 * The name is project scoped on purpose: two projects on one machine
 * must not claim the same host name.
 */

/** The host name of one service: <service>.<project>.local */
export function serviceHostName(serviceName, projectName) {
  return `${serviceName}.${projectName}.local`;
}

/** The host names of one service: its own name plus the public domains. */
export function serviceHostNames(serviceName, projectName, publicDomains = []) {
  return [serviceHostName(serviceName, projectName), ...publicDomains];
}

/** The public domains of this instance, from the environment. */
export function publicDomainsOf(env) {
  const appUrl = String(env.APP_URL || "");
  const primary = (appUrl.match(/^https?:\/\/([^/:]+)/) || [])[1] || "localhost";
  return String(env.PUBLIC_DOMAINS || primary)
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}
