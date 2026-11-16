The server for the mdvju iPhone app (paid, 14-day free trial)

# mdvju server

The mdvju server is a small program you run yourself. It reads your Markdown vault (an Obsidian-style folder of notes) on your own machine and serves it to [mdvju](https://mdvju.app) on your iPhone. It's free and open source, under the AGPL-3.0.

You don't need it. mdvju reads a folder in iCloud Drive or On My iPhone on its own, and for most people that's enough. The server is for when your notes live somewhere else: on a NAS or a home server, kept up to date by Syncthing or git, too big to copy to every phone, or read by several phones in the house.

## What it is

- **Your vault, served from your machine.** The phone doesn't need a copy of the vault. Note text is fetched when you open a note; images and other attachments when a note shows them.
- **An index of the vault.** The server keeps the list of notes, links and aliases, so the phone doesn't have to go through the whole folder. Wikilinks, embeds, recent notes, the folder tree and filename search come from it.
- **Ticks written back.** Ticking a task in the app changes that line in the note on disk, atomically, and refuses if the note changed in between.
- **Home and favourites shared by every phone.** They're kept in the vault, in `.mdvju/state.json`.
- **One token per phone.** Each phone pairs with a one-time link or QR code and gets its own token, which you can revoke on its own.

## What it isn't

- **Not a sync tool.** It reads the vault folder as it is on that machine. Keeping that folder up to date (Syncthing, git, Obsidian Sync on a desktop) is up to you.
- **Not an editor.** Apart from ticking tasks and the home and favourites state, it never changes your notes.
- **Not a web viewer.** Its only client is the mdvju iPhone app.
- **No notifications and no full-text search.** Search is by file name and path.
- **Not made by or affiliated with Obsidian.**

## What you need

- A machine that's always on and can read your vault folder (a NAS, a home server, or a small rented server), with **Docker** and docker compose. That's the supported way to run it.
- An **HTTPS** address for it that your phone can reach. mdvju connects only over HTTPS, also on your home network or Tailscale. Put the server behind a reverse proxy (Caddy, nginx or Traefik); Tailscale's HTTPS certificates work too.
- mdvju on your iPhone, during the free trial or bought. The server itself costs nothing.

## Quick start

```bash
git clone https://github.com/ynvrs-eu/mdvju-server.git
cd mdvju-server
cp .env.example .env        # set VAULT_HOST_PATH and PUBLIC_URL
sudo install -d -m 700 -o 1001 -g 1001 secrets   # the device registry: the container's user only
docker compose build
scripts/pair-device.sh "My iPhone"   # creates secrets/devices.json and prints a pairing link
docker compose up -d
```

- `VAULT_HOST_PATH` is your vault's folder on this machine. The container runs as uid/gid 1001 and must be able to read it, and to write it for ticks and home and favourites (for example: the vault's group is 1001 and group-writable). Without write access everything else still works; those writes fail.
- `PUBLIC_URL` is the HTTPS address your phone reaches the server at, e.g. `https://notes.example.com`. It goes into the pairing links. The server refuses to start without it.
- The server listens on `127.0.0.1:3099`. Set `BIND_ADDRESS` in `.env` if your proxy runs on another machine; never `0.0.0.0` on a host with a public address.

A reverse proxy on the same machine, with [Caddy](https://caddyserver.com) (it gets the certificate itself):

```
notes.example.com {
    reverse_proxy 127.0.0.1:3099
}
```

Then set `TRUST_PROXY=uniquelocal` in `.env`, so the rate limit on wrong pairing codes sees your phone's address, not the proxy's (the proxy's requests reach the container from Docker's private network address), and run `docker compose up -d` again. With the port bound to `127.0.0.1`, nothing else can reach it to fake that address.

Check it: `curl https://notes.example.com/health` answers 200 when the server is up and the vault has entries.

The server won't start with no way in: it needs `secrets/devices.json` (made by the first `pair-device.sh`) or an `AUTH_TOKEN` in `.env`.

## Pairing your phone

1. On the server, run `scripts/pair-device.sh "My iPhone"`. It prints a one-time pairing link, valid for 10 minutes, and its QR code.
2. On your iPhone, open Settings › **Notes Source**, choose **Server**, and tap **Set up server / pair**. (On first launch, the same screen is called **Connect to your vault**.)
3. Open the pairing link, or tap the QR-code button next to the link field and scan the code. Confirm "Pair with *your server's address*?", and you're reading.

The code in the link sits after the `#`, so it never reaches a web server or a link previewer. If `ots-cli` is on the PATH, the script also prints a one-time link to the pairing link, to send instead of the link itself.

**More phones:** on a phone that's already paired, Settings › Notes Source › **Add a device** shows a QR code and a link for the next phone. **Paired devices** lists them all, and **Revoke** cuts one off.

On the server:

```bash
scripts/devices.sh list           # id, name, paired, last seen, status
scripts/devices.sh revoke <id>    # its token stops working on the next request
scripts/devices.sh rotate <id>    # revoke, then a new pairing link for the same name
```

The scripts change `secrets/devices.json` in a one-off container of the server's image (`docker compose run`), so they work on a running server without a restart. Tokens and codes are stored only as SHA-256 hashes. Wrong pairing codes are limited to 10 per address an hour.

## Keeping it running

Docker doesn't restart a container whose healthcheck fails, only one whose process exits. `scripts/restart-if-unhealthy.sh` does, from cron:

```
*/5 * * * * /path/to/mdvju-server/scripts/restart-if-unhealthy.sh >> /tmp/mdvju-watchdog.log 2>&1
```

To update: `git pull`, then `docker compose up -d --build`.

## Configuration

All in `.env`; `.env.example` explains each one.

| Variable | |
|---|---|
| `VAULT_HOST_PATH` | Required. The vault's folder on the host, mounted as `/vault`. |
| `PUBLIC_URL` | Required. The server's address as the phone reaches it, for pairing links. |
| `BIND_ADDRESS` | The host address the port is published on. Default `127.0.0.1`. |
| `TRUST_PROXY` | Behind a reverse proxy: Express "trust proxy" (the proxy's IP or CIDR, `loopback`, `uniquelocal`, or a hop count). |
| `AUTH_TOKEN` | Optional shared token, for entering the address and a token by hand instead of pairing. Remove it to allow paired devices only. |
| `CORS_ORIGIN` | Only for a browser client. The iOS app needs none. |
| `DEMO_PAIRING_CODE`, `DEMO_PAIRING_EXPIRES`, `DEMO_MAX_DEVICES` | A public demo server only: one reusable pairing code until a date. `scripts/demo-pair-link.sh` prints its link. Never set them on your own server. |

## Privacy

mdvju talks only to the address you paired, and keeps that address and its device token in the iPhone's keychain. Your notes go between your phone and your machine; nothing is sent anywhere else, and the server has no telemetry. See the [privacy policy](https://mdvju.app/privacy).

## Development

Needs Node 22.

```bash
npm ci
npm test              # vitest: the HTTP API, the device registry, the index
npm run typecheck     # and npm run typecheck:test for the tests
npm run build         # into dist/
```

`src/` is the server; `shared/` is plain TypeScript with no dependencies that the mdvju app uses too (API types, path rules, pairing links, wikilink resolution, task lines, frontmatter), so the two can't disagree. `test/vectors/` are JSON test cases the app runs against its own code as well; see `test/vectors/README.md`. `test/fixture-vault/` is a small vault for the tests.

To run it from source: `VAULT_ROOT=/path/to/vault SECRETS_DIR=./secrets PUBLIC_URL=http://localhost:3000 npm run dev` (port 3000 unless `PORT` is set).

## Links

- [mdvju](https://mdvju.app): the app
- [Self-hosted server](https://mdvju.app/self-hosted): the same in short, on the website
- [Security](SECURITY.md): reporting a vulnerability
- [Contributing](CONTRIBUTING.md): bug reports welcome

## License

Copyright (C) 2026 Michał Wojtera.

The mdvju server is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3 ([LICENSE](LICENSE)). If you offer a changed version to other people as a network service, the licence asks you to share your changes too.

The name mdvju is not covered by the licence: see [NOTICE](NOTICE).
