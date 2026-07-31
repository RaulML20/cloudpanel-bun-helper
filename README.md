# CloudPanel Bun Helper

Manage [Bun](https://bun.sh) applications from the [CloudPanel](https://www.cloudpanel.io) UI, the way the
[plesk-ext-bun](https://github.com/RaulML20/plesk-ext-bun) extension does it for Plesk, but adapted to the
simpler surface CloudPanel offers. It follows the same install pattern (and the same security model) as
[cloudpanel-terminal-helper](https://github.com/RaulML20/cloudpanel-terminal-helper).

> Unofficial project: not affiliated with, endorsed by or supported by CloudPanel or MGT-COMMERCE GmbH.

## What you get

- **Admin Area > Instance > Services**: a **Bun Versions** card listing the Bun releases published on GitHub
  (cached for 24h). Installed versions are always shown in full; available (not installed) ones show only the
  5 most recent, with a **View More** link for the rest — Bun cuts releases often and the full catalogue can
  run to hundreds of rows. Install or uninstall any version with one click. A version in use by a running
  site cannot be uninstalled — the card shows which domains use it.
- **Sites > Add Site**: a **Create a Bun Site** card. It opens the Reverse Proxy form with `?option=bun`:
  the title becomes *New Bun Site*, the Reverse Proxy URL field is replaced by an **App Port** field
  (pre-filled with a free port from the 30000–30999 range), and Create calls the helper, which runs
  `clpctl site:add:reverse-proxy` pointing at `http://127.0.0.1:<port>` and records the domain as a Bun site.
  Creating a site fails up front — before touching CloudPanel — if no Bun version is installed yet. On
  success it redirects straight to the new site's own Settings page (`/site/<domain>/settings`), ready to
  pick a version and enable it.
- **Sites list**: Bun domains show `BUN` in the **APP** column.
- **Site > Settings**: for Bun sites, CloudPanel's own *Reverse Proxy Settings* card is hidden (Bun owns the
  proxy target once enabled) and replaced by a **Bun Settings** card (like the Node.js one) with an *Enable
  Bun* switch, the Bun version (from the installed ones), the start script (default `index.ts`), the app port
  (rejected if already in use), an **Install Dependencies** button, a **Restart Application** button and a
  small terminal with the last log lines. Saving a new port here also updates nginx's target automatically —
  see [How the reverse proxy port stays in sync](#how-the-reverse-proxy-port-stays-in-sync) below.
- Enabling Bun starts a PM2 process (`bun-site-<domain>`) running the site's project with the selected Bun
  binary, as the site's own system user. Disabling it deletes the PM2 process. Enabling never installs the
  project's dependencies on its own — use **Install Dependencies** first (runs `bun install` as the site's
  own user), or the application crashes on its first start against a project deployed without
  `node_modules`.

Node.js and PM2 must already be installed on the server (they are if you installed
cloudpanel-terminal-helper). The installer aborts telling you so if either is missing, and creating a Bun
site fails with the same message.

## How the CloudPanel UI is patched

This is the part that makes the helper safe to combine with CloudPanel updates and with other extensions.

The installer **never replaces a CloudPanel template**. It appends one self-contained block, delimited by
Twig comments, just before the template's last `{% endblock %}`:

```twig
{# BEGIN cloudpanel-bun-helper #}
<script> ... </script>
{# END cloudpanel-bun-helper #}
```

Everything the extension adds to the UI is built client side by that script. Consequences:

- **CloudPanel updates never get downgraded.** The installer does not ship copies of CloudPanel templates,
  so it cannot overwrite a newer one with an older one. If an update replaces a template, our block is gone
  and the Bun UI disappears from that page — re-run `install.sh` and it is injected into the *new* template.
- **Re-running the installer is safe.** The block is stripped and re-added, never stacked.
- **Other extensions are not disturbed.** Nothing CloudPanel or another extension renders is moved or
  rewritten in the template. In particular
  [cloudpanel-sites-helper](https://github.com/RaulML20/cloudpanel-sites-helper) patches the same sites
  listing template (`Frontend/Site/index.html.twig`), and the two coexist:

  | | |
  |---|---|
  | Different markers | Ours is `cloudpanel-bun-helper`, its is `Frontend/Site/SitesHelper`, so neither installer sees the other as "already installed" |
  | Different backup names | `*.cloudpanel-bun-helper.bak` vs `*.cloudpanel-sites-helper.bak`, so its "backups already exist" guard does not trip |
  | No structural edits | The `BUN` column is filled in on rows already rendered, found by reading the header, so it works with the stock table *and* with the grouped/filtered table sites-helper produces (a `MutationObserver` re-applies it when rows are re-rendered) |

  One ordering note: uninstalling sites-helper restores its own backup of the listing template. If it was
  installed *after* this helper, that backup contains our block and it survives; if it was installed
  *before*, our block is dropped and you just re-run `install.sh`. Nothing breaks either way.

Uninstalling removes our block from the live templates rather than restoring a backup — so a template that
CloudPanel updated in the meantime is cleaned correctly instead of being reverted to an old version. The
`.cloudpanel-bun-helper.bak` files are kept only as insurance and deleted on uninstall.

## What survives an uninstall, a reinstall or a wiped state file

| | Where it lives | Survives reinstall | Survives `uninstall.sh` | Survives `uninstall.sh --purge` |
|---|---|---|---|---|
| Installed Bun versions | `/opt/bun/<version>/bin/bun` | yes | yes | no |
| Which domains are Bun sites | `/var/lib/cloudpanel-bun-helper/sites.json` | yes | yes | no |
| Running applications | PM2 (`bun-site-<domain>`) | yes | yes | no |
| Helper code, `.env`, certificate | `/opt/cloudpanel-bun-helper` | code replaced, certificate kept | no | no |

Two independent mechanisms make this work:

1. **Installed versions are read off the filesystem**, never from a database — `/opt/bun` is scanned on every
   request, so a fresh install sees whatever is already there.
2. **Running applications are adopted.** On startup and on every reconcile, the helper walks the PM2 process
   list and rebuilds a `sites.json` entry for any `bun-site-*` process it does not know about, recovering the
   domain, system user, application root, Bun version, start script and port from the process itself. Only
   processes launched from `/opt/bun/<version>/bin/bun` are adopted, so unrelated PM2 apps are ignored.

   This is the same stance the Plesk extension takes with `Modules_Bun_Reconcile`: the server, not the state
   file, is the source of truth. So even if `/var/lib/cloudpanel-bun-helper` is deleted, reinstalling finds
   every running Bun site again.

The same reconcile drops sites whose system user no longer exists (the site was deleted from CloudPanel) and
kills their leftover process.

## Architecture

| Piece | Role |
|---|---|
| `server.js` | Root HTTPS JSON API on port `7880` (PM2 process `cloudpanel-bun-helper`). Runs `clpctl`, PM2 and the Bun runtime installs. |
| `blocks/*.html` | The five injected UI blocks (new site card, Bun mode for the reverse proxy form, site settings card, versions card, sites-list column). |
| `tools/patch-template.js` | Injects and removes those blocks. |
| `/opt/bun/<version>/bin/bun` | Installed Bun runtimes (root-owned, world-executable). |
| `/var/lib/cloudpanel-bun-helper/sites.json` | Which domains are Bun sites, and their version/port/start script. |

### Security (same model as cloudpanel-terminal-helper)

Every API request must pass all of:

1. **Client IP allowlist** (`BUN_HELPER_ALLOWED_CLIENT_IPS`).
2. **Exact `Origin` check** against your CloudPanel URL (`BUN_HELPER_ALLOWED_ORIGIN`).
3. **CloudPanel session cookie**: the session file must exist, be fresh, be authenticated and carry
   `ROLE_ADMIN`.

The API is HTTPS-only with a self-signed certificate generated at install time. Applications are never run
as root: PM2 drops to the site's own system user.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/RaulML20/cloudpanel-bun-helper/main/install.sh -o install.sh
BUN_HELPER_ALLOWED_CLIENT_IPS="YOUR_PUBLIC_IP" bash install.sh
```

Then open `https://YOUR_VPS_IP:7880` once in your browser and accept the self-signed certificate, so the
CloudPanel pages can call the API.

The installer verifies CloudPanel/Node/PM2, downloads the repository to `/opt/cloudpanel-bun-helper`
(keeping the previous certificate and migrating any old `data/` directory), writes `.env`, generates the
certificate, creates `/opt/bun`, locates the five templates by content signature and injects the blocks,
adds a UFW rule for your IP, starts the helper under PM2 with `pm2 resurrect` on reboot, and clears the
CloudPanel cache.

### Useful environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BUN_HELPER_ALLOWED_CLIENT_IPS` | *(required)* | Comma-separated public IPs allowed to call the API |
| `BUN_HELPER_PORT` | `7880` | HTTPS port of the helper |
| `BUN_HELPER_ALLOWED_ORIGIN` | `https://<detected-ip>:8443` | Your CloudPanel origin |
| `BUN_HELPER_PUBLIC_HOST` | *(auto-detected)* | Host used for the certificate and printed URLs |
| `BUN_HELPER_DATA_DIR` | `/var/lib/cloudpanel-bun-helper` | Where `sites.json` lives |
| `BUN_ROOT` | `/opt/bun` | Where Bun runtimes are installed |
| `CLOUDPANEL_TPL_NEW_SITE` / `..._REVERSE_PROXY` / `..._SETTINGS` / `..._SERVICES` / `..._SITES_LIST` | *(auto-located)* | Explicit template paths if auto-location fails |

## API

All endpoints require the checks above. JSON in, JSON out (`{ok: true, ...}` / `{ok: false, error}`).

| Method & path | Purpose |
|---|---|
| `GET /api/versions[?refresh=1]` | Catalogue + installed + in-use-by domains |
| `POST /api/versions/install` `{version}` | Download and install a Bun release |
| `POST /api/versions/remove` `{version}` | Remove a version (refused while in use) |
| `GET /api/ports/suggest` | First free port in 30000–30999 |
| `GET /api/sites` | Every managed Bun domain (used by the sites listing) |
| `POST /api/sites` `{domainName, port, siteUser, siteUserPassword}` | Create the reverse-proxy site via `clpctl` and mark it as Bun |
| `GET /api/sites/<domain>` | Config + PM2 status + installed versions (404 if not a Bun site) |
| `POST /api/sites/<domain>/settings` `{enabled, version, startScript, port}` | Save settings; start/stop the PM2 process |
| `POST /api/sites/<domain>/install` | Run `bun install` over the project, as the site's own user |
| `POST /api/sites/<domain>/restart` | Restart the application |
| `GET /api/sites/<domain>/logs?lines=100` | Last log lines of the process |

## Uninstall

```bash
bash /opt/cloudpanel-bun-helper/uninstall.sh          # removes the helper and its template blocks
bash /opt/cloudpanel-bun-helper/uninstall.sh --purge  # also removes /opt/bun, sites.json and every bun-site-* process
```

## How the reverse proxy port stays in sync

nginx proxies a Bun domain to `127.0.0.1:<port>`, and that target lives in CloudPanel's own *Reverse Proxy
Settings* card — this extension has no `clpctl` command to change it directly. Since that card is hidden for
Bun sites (its "Reverse Proxy Url" field does not apply once Bun owns the port), the Bun Settings card fills
in that hidden field and submits CloudPanel's own form for it whenever the port changes — the same full
POST + page reload that clicking the card's own Save button would have caused, just triggered
programmatically. This runs both when you save a new port and, as a safety net, the moment the page loads if
it ever finds the two out of sync. If CloudPanel's markup ever changes enough that the field cannot be
found, you get an explicit error telling you the exact `http://127.0.0.1:<port>` to set by hand instead of a
silent 502.

## Notes

- Port checks look at both the ports reserved by other Bun sites and the ports something is actually
  listening on (`ss -ltn`).
- On x64 CPUs without AVX2 the `baseline` Bun build is installed automatically; ARM64 gets `aarch64`.
- Deleting a Bun site from CloudPanel is picked up automatically on the next reconcile.