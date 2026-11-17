# Upgrading the mdvju server

## Which versions you get

Each release is published as `ghcr.io/ynvrs-eu/mdvju-server` with these tags:

| Tag | Follows |
|---|---|
| `1.2.3` | Exactly that release. |
| `1.2` | The latest `1.2.x` (fixes only). |
| `1` | The latest `1.x`. This is what `docker-compose.yml` uses. |
| `latest` | The latest release, whatever its major version. |

A new major version (`2.x`) can need changes on your side, so `1` never moves to it on its own. [CHANGELOG.md](../CHANGELOG.md) says what changed in each release and what, if anything, you have to do.

## Update

In the folder you cloned:

```bash
git pull                 # the latest docker-compose.yml, scripts and docs
docker compose pull      # the latest image for the tag in use
docker compose up -d     # replaces the container; a few seconds offline
```

Then check it:

```bash
docker compose ps                     # "healthy" within a minute
curl https://notes.example.com/health # {"ok":true}
```

The version running:

```bash
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' $(docker compose ps -q server)
```

If you build the image yourself (the `build:` option in `docker-compose.yml`): `git pull`, then `docker compose up -d --build`.

## What's kept

Everything that matters lives outside the container, so an update keeps it:

- **Paired devices and the server's secret**, in `secrets/`. Phones stay paired; nobody pairs again.
- **The vault**, untouched, including home and favourites in `.mdvju/state.json`.
- **Your settings**, in `.env` and `docker-compose.override.yml`.

The container itself holds nothing: its filesystem is read-only.

## Staying on one version, and going back

To update only when you choose, pin an exact version in `docker-compose.override.yml` rather than in `docker-compose.yml` (so `git pull` never conflicts with your change):

```yaml
services:
  server:
    image: ghcr.io/ynvrs-eu/mdvju-server:1.0.0
```

and run `docker compose up -d`. Going back after an update that went wrong works the same way: pin the previous version and `docker compose up -d`.
