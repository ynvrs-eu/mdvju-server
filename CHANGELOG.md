# Changelog

What changed in each release of the mdvju server. Upgrading: see [docs/upgrade.md](docs/upgrade.md).

## 1.0.0 (2026-11-18)

The first public release.

### Added

- The mdvju server: serves a Markdown vault to the mdvju iPhone app, with an index of notes, links and aliases, per-phone pairing and tokens, task ticks written back, and home and favourites shared between phones.
- A Docker image for `linux/amd64` and `linux/arm64`, published to `ghcr.io/ynvrs-eu/mdvju-server` on every release.
- `docker-compose.yml` uses the published image; building from the checkout is still an option.
- An install guide ([docs/install.md](docs/install.md)) and an upgrade guide ([docs/upgrade.md](docs/upgrade.md)).
