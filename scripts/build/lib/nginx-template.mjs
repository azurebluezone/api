/**
 * scripts/build/lib/nginx-template.mjs — render the nginx template.
 *
 * The template (deploy/nginx.conf.template) is the single source for the
 * shape of the configuration. The renderer only substitutes values, so a
 * change to the server blocks is a change to the template, not to a
 * generator.
 *
 * Supported syntax
 *   {{KEY}}                  value
 *   {{#LIST}} ... {{/LIST}}  repeated block; inside it {{ITEM}} is the
 *                             current element and {{ITEM.KEY}} its field
 */

import fs from "node:fs";

export function renderTemplate(template, vars, list = {}) {
  let out = template;

  // repeated blocks first
  for (const [name, items] of Object.entries(list)) {
    const re = new RegExp(
      `\\{\\{#${name}\\}\\}([\\s\\S]*?)\\{\\{/${name}\\}\\}`,
      "g",
    );
    out = out.replace(re, (_, body) =>
      items
        .map((item) =>
          body
            // {{ITEM.KEY}} and {{KEY}} both resolve inside a block
            .replace(/\{\{ITEM\.([A-Z0-9_]+)\}\}/g, (_, k) => String(item[k] ?? ""))
            .replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) =>
              k in item ? String(item[k]) : m,
            ),
        )
        .join(""),
    );
  }

  // plain values
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (key in vars) return String(vars[key]);
    if (key in list) return "";
    return m; // unknown placeholder: leave it visible
  });

  return out;
}

/** Read the template from disk. */
export function loadTemplate(file) {
  return fs.readFileSync(file, "utf8");
}
