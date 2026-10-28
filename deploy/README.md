# Private Hostinger VPS deployment

These are reviewable single-operator templates, not evidence that your VPS has been configured. VPS access, domain names, DNS, certificates and the operator login are not available in this task. Do not open the app to the Internet without finishing and checking these steps. Ordinary shared website hosting cannot run the Factory backend/worker/browser stack.

The implemented code is currently on `feature/reliable-intake-and-leads`, rather than the repository's original `main`. After preparing the service user/directories, obtain the reviewed source with:

```sh
git clone --branch feature/reliable-intake-and-leads https://github.com/ritty65/Web-factory.git /opt/webfactory
cd /opt/webfactory
npm ci
```

Review the branch before deployment; the examples below do not create accounts, certificates or passwords automatically.

1. Use a supported Linux VPS. Install Node 24.13+, Python 3, system Chromium and its shared libraries, Nginx, a certificate client and `htpasswd` tooling from trusted OS/package sources. Install a supported Codex CLI and sign in as the **webfactory service user** using its own account. A ChatGPT subscription is not an OpenAI API key and its availability/usage limits still apply. Do not copy this task's credentials.
2. Create a dedicated unprivileged `webfactory` user with `/var/lib/webfactory` as its private home. Make `/var/lib/webfactory/state` private and writable by that user. Put the reviewed checkout in `/opt/webfactory`, install with `npm ci`, and keep application code read-only to the service user. It must be able to run Node, Codex and the project-local `agent-browser` binary.
3. Create `/etc/webfactory/runtime.env` from the example; set both state/database paths. Enter actual keys outside Git if using paid provider APIs. Limit file permissions to the necessary service/operator account. Initialize the DB as that service user with the same state variables. Back up any existing state before upgrades.
4. For a private first pilot, omit both public-origin variables and use an SSH tunnel to loopback ports 8780/8781. For browser access through a domain, configure **two distinct HTTPS origins** exactly, with no trailing slash: one for the console and one for previews. The app never trusts `X-Forwarded-Host` to select an origin.
5. Install the systemd unit after adjusting paths. Check it with `systemd-analyze verify`; verify the Chromium sandbox works as the unprivileged service user. Do not solve browser failures by running the app as root or disabling its sandbox. The service manager owns background workers; `KillMode=control-group` stops its children on shutdown.
6. Set up DNS/TLS for the two domains. Create a strong operator password interactively with `htpasswd`, stored outside Git. Adapt the Nginx example and run `nginx -t` before reload. Both the console **and** previews require authentication. This is a single trusted-operator setup, not a multi-tenant SaaS.
7. Verify that only HTTPS/SSH are externally reachable. Ports 8780, 8781 and 9377 remain private. Test wrong Host/Origin, missing CSRF, bad operator login, unauthenticated preview and restart behavior. Verify the production app/preview health with the configured Host headers. Never publish the operator control panel as a customer review link.
8. Run offline tests and the acceptance checklist in docs/OPERATING-GUIDE.md, then perform one explicitly approved live test. Do not enable unattended building before live model/source behavior, budgets and failure alerts have been checked.

## Backups and upgrades

Use the app's idle snapshot/restore checks; snapshots now include `intake/` photos. Store encrypted off-server backups with a retention policy appropriate to source contracts and customer permissions. Test restoration into a fresh separate directory; do not overwrite active state. Original uploaded photos, private proposals, source data and model caches are private. Source-provider storage rules also apply to backups; these templates do not establish contractual compliance.

On upgrade, preserve state, use the lockfile, stop owned work cleanly, restart the service, check health and run a bounded smoke. In-flight ambiguous model requests are held instead of silently regenerated. Never reset failed jobs or consumed source quotas as an upgrade step.

## Optional Camofox

Keep it as a separate localhost-only service with a dedicated unprivileged user and disposable profile; never import your personal browser cookies. The app currently exposes an explicit diagnostics button for localhost:9377. That does **not** enable it as the evidence reader. Before replacing `agent-browser`, verify the actual Camofox API/version, fresh-session behavior, public-only egress including redirects/subresources, bounded extraction, cleanup and source-receipt format. No login/challenge bypass, persistence assumption or stealth benefit is certified by these templates. The main workflow does not depend on Camofox being available.

## Opt-in discovery timer

After explicitly enabling a schedule in Lead workspace, install `web-factory-leads.service` and `.timer` with the same private environment file and service user. Verify them, then enable/start the timer deliberately. It ticks every five minutes; the app reserves no more than one due attempt per Chicago date and uses the shared three-attempt rolling quota. Disable the schedule in the app or stop the timer to pause future work. Inspect `journalctl -u web-factory-leads.service` for held/missing-configuration outcomes. This timer does not generate websites or send outreach.
