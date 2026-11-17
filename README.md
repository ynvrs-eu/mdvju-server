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
- An **HTTPS** address for it that your phone can reach. mdvju connects only over HTTPS, also on your home network or Tailscale. Put the server behind a reverse proxy (Caddy, nginx or Traefik), or use Tailscale's HTTPS certificates.
- mdvju on your iPhone, during the free trial or bought. The server itself costs nothing.

## Install

[docs/install.md](docs/install.md) goes through it step by step: the vault's permissions, HTTPS with Tailscale or with Caddy and your own domain, pairing, backups and troubleshooting. In short:

```bash
git clone https://github.com/ynvrs-eu/mdvju-server.git
cd mdvju-server
cp .env.example .env        # set VAULT_HOST_PATH and PUBLIC_URL (https://...)
sudo install -d -m 700 -o 1001 -g 1001 secrets
scripts/pair-device.sh "My iPhone"   # prints a pairing link and its QR code
docker compose up -d
```

`docker compose` runs the published image, `ghcr.io/ynvrs-eu/mdvju-server` (amd64 and arm64), on `127.0.0.1:3099`, for a reverse proxy in front of it.

Updating: [docs/upgrade.md](docs/upgrade.md). What changed: [CHANGELOG.md](CHANGELOG.md).

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

## How it's made

mdvju is written with AI assistance: much of the code is drafted by AI coding agents. Nothing goes in unread. Every change is checked by the test suite, reviewed, and read by a human (the maintainer) before it is merged or released, and the maintainer is responsible for all of it. Security fixes get the same review plus tests for each case they cover.

## Links

- [mdvju](https://mdvju.app): the app
- [Self-hosted server](https://mdvju.app/self-hosted): the same in short, on the website
- [Security](SECURITY.md): reporting a vulnerability
- [Contributing](CONTRIBUTING.md): bug reports welcome

## License

Copyright (C) 2026 Michał Wojtera.

The mdvju server is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3 ([LICENSE](LICENSE)). If you offer a changed version to other people as a network service, the licence asks you to share your changes too.

The name mdvju is not covered by the licence: see [NOTICE](NOTICE).
