# Contributing

Thanks for looking.

## Bug reports: welcome

Open an issue with:

- what you did, what you expected, and what happened;
- the server version or commit, and how you run it (docker compose, a reverse proxy, the vault on a local disk or a network share);
- the server's log around the problem (`docker compose logs server`), with anything private removed.

Never paste a device token, pairing link, `.env` or `secrets/devices.json` into an issue. Security problems go to security@mdvju.app, not an issue: see [SECURITY.md](SECURITY.md).

Questions and ideas are welcome as issues too.

## Code: not yet

I'm not taking code contributions yet. A contributor agreement is coming first, so that contributions can be accepted without blocking a hosted mdvju service later. Until then, please don't open pull requests with code; they'll be closed unmerged. A bug report with a clear reproduction helps just as much.

You're free to fork the server under the AGPL-3.0 (see [LICENSE](LICENSE)); a fork needs its own name (see [NOTICE](NOTICE)).
