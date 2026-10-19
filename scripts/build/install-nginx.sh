#!/usr/bin/env bash
# install-nginx.sh — install the project's :443 edge into the system nginx
# ═══════════════════════════════════════════════════════════════════════
# Needs root: :443 is a privileged port (ip_unprivileged_port_start=1024)
# and /etc/nginx is root-owned. Everything else was already generated and
# validated by scripts/build/install-nginx-site.mjs.
#
#   sudo bash scripts/build/install-nginx.sh            # install + reload
#   sudo bash scripts/build/install-nginx.sh --uninstall # remove it again
#
# It touches ONLY:
#   /etc/nginx/sites-available/zombiecoder-ai
#   /etc/nginx/sites-enabled/zombiecoder-ai   (symlink)
#   /usr/local/share/ca-certificates/zombiecoder-ai-local-ca.crt
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# The site name follows the project, so several instances can be installed
# side by side (nginx routes them by server_name on the shared :443).
PROJECT="$(basename "$ROOT")"
SITE="$PROJECT"
CONF="/etc/nginx/sites-available/$SITE"
LINK="/etc/nginx/sites-enabled/$SITE"
CA_SRC="$ROOT/dist/certs/ca-cert.pem"
CA_DST="/usr/local/share/ca-certificates/$PROJECT-local-ca.crt"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run with sudo — :443 and /etc/nginx need root." >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$LINK" "$CONF" "$CA_DST"
  update-ca-certificates --fresh >/dev/null 2>&1 || true
  nginx -t && systemctl reload nginx || systemctl restart nginx
  echo "removed: $SITE"
  exit 0
fi

if [ ! -f "$ROOT/dist/nginx/$SITE.conf" ]; then
  echo "ERROR: run 'node scripts/build/install-nginx-site.mjs' first" >&2
  exit 1
fi

echo "▸ installing $SITE"
cp "$ROOT/dist/nginx/$SITE.conf" "$CONF"
ln -sf "$CONF" "$LINK"

if [ -f "$CA_SRC" ]; then
  echo "▸ trusting our local CA (browsers + curl + Node on this box)"
  cp "$CA_SRC" "$CA_DST"
  update-ca-certificates >/dev/null 2>&1 || echo "  (update-ca-certificates warning — continuing)"
fi

echo "▸ nginx -t"
nginx -t

echo "▸ reloading nginx"
systemctl reload nginx 2>/dev/null || systemctl restart nginx

echo
echo "✔ done. The project's TLS edge is live on :443"
echo "  test:  curl --resolve api.zombiecoder.my.id:443:127.0.0.1 https://api.zombiecoder.my.id/identity"
echo "  logs:  journalctl -u nginx -n 20 --no-pager"
