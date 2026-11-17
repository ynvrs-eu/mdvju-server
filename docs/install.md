# Installing the mdvju server

This guide takes you from an empty machine to a paired iPhone. You need:

- A machine that's always on and can read your vault folder (a NAS, a home server, a small rented server), on Linux, with **Docker** and the **docker compose** plugin. The image is built for `amd64` and `arm64` (so also a Raspberry Pi with a 64-bit OS).
- An **HTTPS** address for it that your phone can reach. **The app refuses plain `http://` addresses**, also on your home network. This guide covers two ways to get one: [Tailscale](#route-a-tailscale) (nothing exposed to the internet) and [Caddy with your own domain](#route-b-caddy-with-your-own-domain) (reachable from anywhere).
- mdvju on your iPhone.

## 1. Get the files

```bash
git clone https://github.com/ynvrs-eu/mdvju-server.git
cd mdvju-server
cp .env.example .env
```

The clone gives you `docker-compose.yml`, `.env.example` and the scripts in `scripts/` (pairing, devices, the watchdog). The server itself comes as a ready image, `ghcr.io/ynvrs-eu/mdvju-server`, which `docker compose` downloads. To build it from the checkout instead, see the comment at the top of `docker-compose.yml`.

## 2. The vault folder and its permissions

Set `VAULT_HOST_PATH` in `.env` to your vault's folder on this machine:

```
VAULT_HOST_PATH=/srv/notes
```

The server runs as **uid 1001, gid 1001** inside the container, and the folder is mounted at `/vault`.

- **Reading:** uid 1001 must be able to read every note and enter every folder. Notes that are world-readable (`644`, folders `755`) already are.
- **Writing:** ticking a task in the app rewrites that note, and home and favourites are kept in `.mdvju/state.json` in the vault. For these the server needs write access to the notes and their folders. Without it everything else still works; ticks and favourites fail with an error in the app.

The server writes a note by putting a new file in its place, so it keeps the note's permissions and its **group**, and it refuses to write when it can't keep the group. So write access goes through a group: the notes must be group-writable, and their group must be one the container is in. Two ways:

**The vault's group is 1001.** If nothing else on the machine uses gid 1001, give the vault that group:

```bash
sudo chgrp -R 1001 /srv/notes
sudo chmod -R g+rwX /srv/notes
sudo find /srv/notes -type d -exec chmod g+s {} +   # new files keep the group
```

**Or add the vault's existing group to the container.** If the vault already belongs to a group (say gid 1500, `stat -c %g /srv/notes`) and is group-writable, create `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  server:
    group_add:
      - "1500"
```

Docker compose reads that file on its own.

A ticked note ends up owned by uid 1001 (its group and permissions stay the same). Whatever else writes the vault (Syncthing, git, you) must be in the same group, and should create files group-writable (umask `002`), or the server can't tick tasks in notes it creates.

Don't want the server to write at all? Add `read_only: true` to the vault mount in `docker-compose.yml`.

## 3. Configure `.env`

| Variable | Set it to |
|---|---|
| `VAULT_HOST_PATH` | The vault's folder (step 2). |
| `PUBLIC_URL` | The HTTPS address your phone reaches the server at, from the route you pick below, e.g. `https://notes.example.com`. It goes into pairing links, so it must be exact. The server refuses to start without it. |
| `BIND_ADDRESS` | Leave it unset (`127.0.0.1`) when the proxy runs on this machine. Set it to this machine's LAN or Tailscale address only if the proxy runs on another machine. Never `0.0.0.0` on a machine with a public address. |
| `TRUST_PROXY` | See [TRUST_PROXY](#trust_proxy) below. |

`.env.example` explains the rest; you don't need them for a normal install.

## 4. HTTPS

Pick one route. Both keep the server's own port on `127.0.0.1:3099`, reachable only from this machine.

### Route A: Tailscale

Your phone reaches the server over your tailnet, and Tailscale provides a real certificate for the machine's `*.ts.net` name. Nothing is opened to the internet. The phone needs the Tailscale app, connected, whenever you use mdvju.

1. Install Tailscale on the server machine and on the iPhone, in the same tailnet.
2. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.
3. On the server machine:

   ```bash
   sudo tailscale serve --bg 3099
   tailscale serve status        # shows the address, https://<machine>.<tailnet>.ts.net
   ```

   This serves `https://<machine>.<tailnet>.ts.net` to your tailnet only and passes it to `127.0.0.1:3099`. It stays on across reboots. To stop it: `sudo tailscale serve --https=443 off`.
4. In `.env`:

   ```
   PUBLIC_URL=https://<machine>.<tailnet>.ts.net
   TRUST_PROXY=uniquelocal
   ```

The first request to the address can take a few seconds while Tailscale gets the certificate. Note that the certificate puts the machine's `ts.net` name in the public Certificate Transparency logs.

**Instead of `tailscale serve`: Caddy with a Tailscale certificate.** If you already run Caddy on the machine, it gets the certificate for a `*.ts.net` name from Tailscale by itself:

```
<machine>.<tailnet>.ts.net {
    reverse_proxy 127.0.0.1:3099
}
```

Caddy running as its own user (`caddy`, as the official packages do) must be allowed to ask Tailscale for certificates: add `TS_PERMIT_CERT_UID=caddy` to tailscaled's environment (on Debian and Ubuntu, `/etc/default/tailscaled`) and restart tailscaled. `PUBLIC_URL` and `TRUST_PROXY` are the same as above.

### Route B: Caddy with your own domain

The server gets a name like `notes.example.com` with a Let's Encrypt certificate, and your phone reaches it from anywhere, without a VPN. [Caddy](https://caddyserver.com) gets and renews the certificate itself.

You need:

- A DNS record (`A`, and `AAAA` if you have IPv6) for `notes.example.com` pointing at this machine's public address.
- Ports **80 and 443** reachable from the internet (forwarded on your router, open in the firewall). Let's Encrypt checks the name on one of them. Port 3099 stays closed.

Caddy can run on the machine itself or in Docker, next to the server. Either works; they differ in `TRUST_PROXY` only.

**Caddy on the machine** (installed from your distribution or [caddyserver.com](https://caddyserver.com/docs/install)). In `/etc/caddy/Caddyfile`:

```
notes.example.com {
    reverse_proxy 127.0.0.1:3099
}
```

Then `sudo systemctl reload caddy`.

**Caddy in Docker**, in the same compose project. Create `Caddyfile` next to `docker-compose.yml`:

```
notes.example.com {
    reverse_proxy server:3099
}
```

and `docker-compose.override.yml` (or add the `caddy` service to the one you made in step 2):

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

`caddy_data` holds the certificates: keep it, or Caddy asks Let's Encrypt again on every start and runs into its rate limits.

In `.env`, for either:

```
PUBLIC_URL=https://notes.example.com
TRUST_PROXY=uniquelocal
```

### TRUST_PROXY

Behind a proxy, every request reaches the server from the proxy. `TRUST_PROXY` tells it which address that is, so it takes the phone's real address from the proxy's `X-Forwarded-For` header. The server needs that for one thing: the limit of 10 wrong pairing codes per address an hour. Unset, every phone looks like the proxy and shares one limit; too wide, a client can fake the header and dodge the limit.

| The proxy runs | It reaches the server from | Set |
|---|---|---|
| On this machine (Caddy, `tailscale serve`, nginx), to `127.0.0.1:3099` | Docker's network gateway, e.g. `172.18.0.1`, **not** `127.0.0.1` | `uniquelocal` |
| In Docker, in the same compose project | Its container address, e.g. `172.18.0.3` | `uniquelocal` |
| On another machine, with `BIND_ADDRESS` set | That machine's address | That address, e.g. `192.168.1.20` |

`uniquelocal` trusts any private address (`10.x`, `172.16-31.x`, `192.168.x`, `fc00::/7`). That's safe while the port is bound to `127.0.0.1`, because then only this machine reaches it. `loopback` does **not** work for a proxy on the same machine: Docker hands the request on from its gateway address. For the strictest setting, use that exact gateway address instead of `uniquelocal`:

```bash
docker network inspect mdvju-server_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

(The network is named after the folder you cloned into; `docker network ls` lists them.)

### Other proxies

Not covered step by step, but any reverse proxy with a certificate the iPhone trusts works.

- **nginx:** `proxy_pass http://127.0.0.1:3099;` with `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, and a certificate from certbot or similar. `TRUST_PROXY` as in the table.
- **Traefik:** a router for the name with a `certResolver`, to a service at `http://server:3099` (Traefik in the same compose project) or `http://127.0.0.1:3099`. Traefik sets `X-Forwarded-For` itself.

## 5. Start the server and pair your phone

Create the folder for the device registry. It belongs to the container's user only: a host user who could write it could add their own device.

```bash
sudo install -d -m 700 -o 1001 -g 1001 secrets
```

Pair the first phone. This downloads the image the first time, creates `secrets/devices.json` and prints a pairing link and its QR code:

```bash
scripts/pair-device.sh "My iPhone"
```

Start the server within the 10 minutes the link is valid (or run `pair-device.sh` again later):

```bash
docker compose up -d
docker compose ps                     # the server's state turns "healthy" within a minute
curl https://notes.example.com/health # {"ok":true}
```

The server won't start without `secrets/devices.json` (or an `AUTH_TOKEN` in `.env`): it never runs open.

On the iPhone:

1. Open Settings › **Notes Source**, choose **Server**, and tap **Set up server / pair**. (On first launch, the same screen is called **Connect to your vault**.)
2. Open the pairing link, or tap the QR-code button next to the link field and scan the code from the terminal.
3. Confirm "Pair with *your server's address*?".

A pairing link works once, for 10 minutes. The code sits after the `#`, so it never reaches a web server or a link previewer. If `ots-cli` is installed, the script also prints a one-time link to send instead of the pairing link itself.

## 6. Devices

Each phone has its own token, which you can revoke on its own.

**From the app:** on a paired phone, Settings › Notes Source › **Add a device** shows a QR code and link for the next phone. **Paired devices** lists them all, and **Revoke** cuts one off.

**On the server:**

```bash
scripts/devices.sh list           # id, name, paired, last seen, status
scripts/devices.sh revoke <id>    # its token stops working on the next request
scripts/devices.sh rotate <id>    # revoke, then a new pairing link for the same name
scripts/pair-device.sh "iPad"     # another device
```

The scripts change `secrets/devices.json` in a one-off container of the server's image, so they work on a running server without a restart. Tokens and pairing codes are stored only as SHA-256 hashes.

## 7. Keep it running

`restart: unless-stopped` restarts the server when it exits, but Docker doesn't restart a container whose healthcheck fails (for example when a network share under the vault went stale). `scripts/restart-if-unhealthy.sh` does, from cron:

```
*/5 * * * * /path/to/mdvju-server/scripts/restart-if-unhealthy.sh >> /var/tmp/mdvju-watchdog.log 2>&1
```

Updating: see [upgrade.md](upgrade.md).

## 8. Backups

Back up the **`secrets/`** folder: `devices.json` (the paired devices) and the server's own secret. Lose it and every phone has to pair again. It's readable by uid 1001 only, so copy it with sudo, and keep the copy as private as the original:

```bash
sudo tar -C /path/to/mdvju-server -czf mdvju-secrets-$(date +%F).tar.gz secrets
```

To restore, unpack it into the checkout and check it's still owned by 1001 with `0700` on the folder and `0600` on the files.

Also worth keeping: `.env` (and `docker-compose.override.yml` and `Caddyfile` if you made them). Home and favourites live in the vault (`.mdvju/state.json`), so they're backed up with it.

## Troubleshooting

Start with the server's log and state:

```bash
docker compose ps
docker compose logs --tail 50 server
```

**The app says it can't reach the server.**

- Open `https://<your address>/health` in Safari on the iPhone. `{"ok":true}` means the server and proxy are fine and the problem is the address in the app; an error page means the network or the proxy.
- Tailscale: is the Tailscale app on the phone connected? Does `tailscale serve status` still show the address?
- Own domain: does the name resolve to your public address, also from mobile data? Are ports 80 and 443 forwarded? Look at Caddy's log (`journalctl -u caddy`, or `docker compose logs caddy`).
- `{"error":"vault is empty or unreadable"}` (503): the server can't see the vault: see "Permission denied" below.
- The address the app uses comes from `PUBLIC_URL` at pairing time. If it was wrong, fix `.env`, run `docker compose up -d`, and pair again.

**The pairing link expired, or "invalid or expired pairing code".** A link works once, for 10 minutes. Run `scripts/pair-device.sh "My iPhone"` again for a new one. After 10 wrong codes from one address in an hour, pairing from that address is refused for the rest of the hour; if that happens to a phone that never tried a wrong code, check `TRUST_PROXY`.

**Certificate errors.** The iPhone accepts only certificates it trusts, so a self-signed certificate, Caddy's `tls internal` or your own CA won't work. For Tailscale, check that HTTPS Certificates is on in the admin console. For your own domain, Caddy's log says why Let's Encrypt refused (usually port 80 or 443 not reachable, or DNS pointing elsewhere). The address in `PUBLIC_URL` must be exactly the name on the certificate.

**Permission denied on the vault.** Check what the container sees:

```bash
docker compose exec server ls /vault                        # reading
docker compose exec server sh -c 'test -w /vault && echo writable'
docker compose exec server id                               # uid 1001 and the groups it has
```

- The health check fails, or notes are missing: uid 1001 can't read the folder or some of its notes. See [step 2](#2-the-vault-folder-and-its-permissions).
- Ticks fail with "failed to write file", or favourites with "failed to update state": the note isn't group-writable, or its group isn't one of the container's groups (`id` above). Fix the group (step 2), or add it with `group_add`.
- A vault on NFS or SMB: the share's own permission mapping applies (for example `root_squash` or a fixed SMB owner), so check from inside the container as above.
- On a host with SELinux (Fedora, RHEL), the bind mount needs a label: add `selinux: z` under `bind:` for the vault mount.

## What's not supported

- **Plain HTTP.** The app connects only over HTTPS.
- **OIDC, SSO or user accounts.** Access is per device: a pairing link gives a device its own token.
- **Several users with different vaults.** One server serves one vault, and every paired device sees all of it (except dot-folders). For a second vault, run a second copy of the server on another port and address.
