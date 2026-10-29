# Private Hostinger VPS deployment

These are reviewed templates, not a completed VPS deployment. No Hostinger login, domains, certificates or provider keys were supplied. Use a VPS; ordinary shared website hosting cannot run the worker/browser stack. Read [the pilot guide](../docs/DEEPSEEK-PILOT.md) first.

## First private installation

The installer targets **Ubuntu 24.04 x86_64 with Node 24 already installed from a trusted source**. Start with at least 4 GB RAM; 8 GB gives the browsers more room. Review the branch and script before running it as root. Before an upgrade, back up state and stop the app, reader, broker and both timers. The installer rejects active services and checkout-local `.factory-state`; migrate any such existing state safely before using its `/var/lib` layout.

```sh
git clone --branch feature/reliable-intake-and-leads https://github.com/ritty65/Web-factory.git /opt/webfactory
cd /opt/webfactory
sudo bash deploy/install-vps.sh
```

The script installs locked dependencies, isolated Scrapling/DuckDB/Camofox runtimes, matching Playwright Chromium, genuine Camoufox, two unprivileged accounts, private state, an internal random reader token, services and timers. It keeps app code owned by root and read-only to the services. It does not purchase services, start a lead cohort, send messages or configure a public Nginx site. A failed browser download fails installation; inspect its actual cause before retrying.

- `web-factory.service` serves the private console and isolated previews on loopback 8780/8781 and owns worker children.
- `web-factory-reader.service` runs genuine Camoufox on loopback 9378 under a separate account with no provider keys or app-state access. Persistence, telemetry and default add-ons are disabled. Admitted HTTP resources pass through the public-network guard; direct browser traffic uses a closed local proxy and WebRTC is disabled.
- `web-factory-reader-broker.service` exposes only the authenticated narrow Factory reader operations on loopback 9377. Do not forward the upstream admin/cookie/eval API.
- `web-factory-studio.timer` checks the explicitly authorized pilot every five minutes. It only queues work; the persistent app owns execution. An unstarted/paused pilot makes no source call.
- `web-factory-backup.timer` creates an idle private snapshot and verifies a separate-root restore daily at 03:15 server time, retaining seven successful local snapshots.

Use SSH tunnels to both 8780 and 8781 for the first private session. In **Setup & API keys**, enter account keys, choose models, confirm prices/source permissions, save and test. In **Automatic drafts**, test the installed readers and explicitly start the bounded pilot only when ready. DeepSeek is the default code provider; a tested vision route is separate. ChatGPT login alone is insufficient. Keys can instead be bound through a private `/etc/webfactory/runtime.env` using the variable names in the example; do not commit that file or show its contents in diagnostics.

The installer leaves an existing runtime environment file unchanged. On upgrade, check that it includes both private state paths and a valid `FACTORY_BROWSER_EXECUTABLE`. The shared internal token lives in `/etc/webfactory/reader.env`, mode 0600, read by systemd for the appropriate services. Provider key files saved through the UI live only in the app's private credentials directory. Back them up separately in an approved secret store; app snapshots exclude them.

## Access through domains

For domain access configure **two distinct exact HTTPS origins** in `runtime.env`: `FACTORY_APP_ORIGIN` and `FACTORY_PREVIEW_ORIGIN`, with no paths or trailing slash. The app stays bound to loopback and does not trust forwarded headers as authority.

Create DNS records, obtain valid certificates and configure strong operator Basic Auth with `htpasswd`. Adapt `nginx.conf.example`, including both domains and certificate paths; test `nginx -t` before reload. Authenticate both the console and preview origin. Open only SSH/HTTPS in the firewall. Never expose 8780, 8781, 9377 or 9378 publicly, and never use the console as a public customer-review link.

Verify wrong Host/Origin, missing CSRF, bad login and unauthenticated preview all fail. Check both health routes using their exact configured Host headers. Verify the Chromium sandbox as the unprivileged service user; do not fix failures by running the app as root or disabling the sandbox. The service units use `KillMode=control-group`, and owned workers stop with the app.

## Recovery and operational acceptance

Inspect `journalctl` for app, reader, studio-tick and backup units. A pause or missing setup requires an operator action; no external email/Slack alert delivery is configured. The dashboard records source reasons, daily receipts, spending and failed jobs. An actual provider outage must pause further work, preserve charges and require explicit resume. Uncertain paid calls retain their full reservation.

Snapshots include supplied/researched media, jobs, app source and the SQLite ledger; restricted Google payloads are omitted from the copied database. These are private local backups, not encrypted off-server backups. Implement encrypted off-server storage and source-appropriate retention separately. The backup script removes only recognized old snapshot roots and its newly created verified disposable restore; it does not remove arbitrary directories.

Restore into a new root only, using its recorded DB/state paths and `FACTORY_AUTORUN=0` for inspection. Reinstall locked runtimes from the restored source. Re-enter missing keys. The restored API workspace is paused and blocks paid calls until you reconcile total lifetime account spending, including post-backup activity. Resume explicitly on a future Chicago date. Do not overwrite canonical state, reset quotas or refund unknown charges to make a restore pass.

Before calling the VPS operational, run the live 30-business/three-proposal acceptance, authenticate both origins, test browser sandboxing and run a real **72-hour** soak with source outage, service restart, pause/resume and verified restore. Simulated dates and local fixtures do not satisfy that requirement.

## Earlier workflow compatibility

The original `web-factory-leads` timer is retained for the legacy manual/CSV/Google research workspace. Do not enable it alongside the new API profile; its paid routes are held after profile adoption. Earlier Codex/OpenCode histories remain inspectable. The new automatic pilot uses `web-factory-studio`, not the earlier timer.
