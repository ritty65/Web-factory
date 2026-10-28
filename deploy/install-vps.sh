#!/usr/bin/env bash
# Run explicitly as root from /opt/webfactory on Ubuntu 24.04 x86_64.
# Installs services privately; never enables paid discovery or buys anything.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run this installer as root.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && $(uname -m) == x86_64 ]] || { echo 'This installer targets Ubuntu 24.04 x86_64.' >&2; exit 1; }
[[ $(pwd -P) == /opt/webfactory ]] || { echo 'Use a reviewed checkout at /opt/webfactory.' >&2; exit 1; }
[[ ! -e .factory-state ]] || { echo 'Preserve and migrate checkout-local private state before using this /var/lib installer.' >&2; exit 1; }
for studio_unit in web-factory.service web-factory-reader.service web-factory-reader-broker.service web-factory-studio.timer web-factory-backup.timer; do
  if systemctl is-active --quiet "$studio_unit"; then echo 'Stop Factory services/timers and back up state before upgrading.' >&2; exit 1; fi
done
node --input-type=module -e 'if(Number(process.versions.node.split(".")[0])!==24)process.exit(1)'
apt-get update
apt-get install -y python3.12 python3.12-venv build-essential nginx apache2-utils libgtk-3-0t64 libasound2t64 libdbus-glib-1-2 libxt6t64
id webfactory >/dev/null 2>&1 || useradd --system --home-dir /var/lib/webfactory --create-home --shell /usr/sbin/nologin webfactory
id webfactory-reader >/dev/null 2>&1 || useradd --system --home-dir /var/lib/webfactory-reader --create-home --shell /usr/sbin/nologin webfactory-reader
install -d -m 0700 -o webfactory -g webfactory /var/lib/webfactory /var/lib/webfactory/state
install -d -m 0700 -o webfactory-reader -g webfactory-reader /var/lib/webfactory-reader /var/lib/webfactory-reader/cache
install -d -m 0700 /etc/webfactory
npm ci
node scripts/install-studio-runtimes.mjs
export PLAYWRIGHT_BROWSERS_PATH=/opt/webfactory/.factory-tools/playwright
npx playwright install --with-deps chromium
browser_path=$(node --input-type=module -e 'import {chromium} from "playwright";process.stdout.write(chromium.executablePath())')
# Runtime packages contain code, not credentials. Both unprivileged services
# must traverse these root-installed directories; private state stays 0700.
chmod a+rx /opt/webfactory /opt/webfactory/.factory-tools
chmod -R a+rX .factory-tools/scrapling .factory-tools/overture .factory-tools/camofox .factory-tools/playwright
if [[ ! -f /etc/webfactory/runtime.env ]]; then
  umask 077
  cat > /etc/webfactory/runtime.env <<EOF
FACTORY_STATE=/var/lib/webfactory/state
FACTORY_DB=/var/lib/webfactory/state/factory.sqlite3
FACTORY_BROWSER_EXECUTABLE=$browser_path
FACTORY_SCRAPLING_PYTHON=/opt/webfactory/.factory-tools/scrapling/bin/python
EOF
fi
if [[ ! -f /etc/webfactory/reader.env ]]; then
  (umask 077; python3.12 -c 'import secrets;print("FACTORY_CAMOFOX_TOKEN="+secrets.token_hex(32))' > /etc/webfactory/reader.env)
fi
# Genuine browser download is an explicit installation step under the reader
# account. A failed download fails installation rather than faking readiness.
runuser -u webfactory-reader -- env XDG_CACHE_HOME=/var/lib/webfactory-reader/cache node .factory-tools/camofox/node_modules/@askjo/camofox-browser/lib/camoufox-download.js
chown -R root:root /opt/webfactory
chmod -R go-w /opt/webfactory
runuser -u webfactory -- env FACTORY_STATE=/var/lib/webfactory/state FACTORY_DB=/var/lib/webfactory/state/factory.sqlite3 node src/cli.mjs init
install -m 0644 deploy/web-factory*.service deploy/web-factory*.timer /etc/systemd/system/
install -d /etc/systemd/system/web-factory.service.d
cat > /etc/systemd/system/web-factory.service.d/reader.conf <<'EOF'
[Service]
EnvironmentFile=/etc/webfactory/reader.env
EOF
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/web-factory*.service /etc/systemd/system/web-factory*.timer
systemctl enable --now web-factory-reader.service web-factory-reader-broker.service web-factory.service web-factory-studio.timer web-factory-backup.timer
echo 'Private services installed. Use SSH tunnels to 8780/8781, save keys/prices in Setup, test connections/readers, then explicitly start the pilot.'
echo 'For domain access, configure BOTH authenticated HTTPS origins using deploy/nginx.conf.example before opening access.'
