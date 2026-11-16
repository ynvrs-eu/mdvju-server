# Security

The mdvju server holds the keys to someone's notes, so security reports are very welcome.

## Reporting a vulnerability

Email **security@mdvju.app**. Please don't open a public issue for a vulnerability.

Include what you found, how to reproduce it (a request, a vault layout, a script), the version or commit, and what an attacker gains. You'll get a reply, and a fix goes into a release as soon as it's ready. Tell me if you'd like to be credited.

## Scope

In scope:

- The server in this repository: authentication, pairing and device tokens, path handling (reading or writing outside the vault, dot-folders, symlinks), the write path (ticks, home and favourites), denial of service from a single client.
- The Docker image and the example `docker-compose.yml`.
- The scripts in `scripts/`.

Not in scope:

- Your reverse proxy, TLS setup or host.
- A vault you've chosen to serve: the server shows paired devices everything in it except dot-folders.
- The mdvju iPhone app itself: report app issues to the same address, but they're tracked separately.

## Supported versions

Only the latest release gets security fixes. Update with `git pull` and `docker compose up -d --build`.
