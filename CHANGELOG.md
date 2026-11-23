# Changelog

What changed in each release of the mdvju server. Upgrading: see [docs/upgrade.md](docs/upgrade.md).

## 1.1.0 (2026-11-23)

### Fixed

- Opening a link to a note created after the server started opens that note, not another note with the same name. The same for an embedded image or file added since.
- A note too large for the app to show can still be opened in another app: the server now sends the whole note for the app's "Open in another app".

### Changed

- The largest note the app shows is 5 MB, down from 25 MB, the same limit the app itself now uses. A larger note shows "This note is too large to show." with the option to open it in another app.

## 1.0.0 (2026-11-18)

The first public release.

### Added

- The mdvju server: serves a Markdown vault to the mdvju iPhone app, with an index of notes, links and aliases, per-phone pairing and tokens, task ticks written back, and home and favourites shared between phones.
- A Docker image for `linux/amd64` and `linux/arm64`, published to `ghcr.io/ynvrs-eu/mdvju-server` on every release.
- `docker-compose.yml` uses the published image; building from the checkout is still an option.
- An install guide ([docs/install.md](docs/install.md)) and an upgrade guide ([docs/upgrade.md](docs/upgrade.md)).
