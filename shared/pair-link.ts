/**
 * The pairing link:
 *
 *   https://mdvju.app/pair#code=<code>&backend=<backend URL>[&name=<device name>]
 *
 * A universal link: mdvju.app serves the apple-app-site-association file
 * for `/pair*`, so on a phone with the app it opens the app, which asks
 * before it pairs. `backend` tells a fresh install where to pair; `name` is
 * the name the code was made for, if any. The backend builds it (POST
 * /pairing-codes, devices-cli.ts) and the app parses it, both from here, so
 * the two can't disagree on the format.
 *
 * The parameters go in the fragment: a
 * fragment never reaches a web server or a link previewer, so the one-time
 * code and the backend URL stay off their logs. The older query form
 * (`/pair?code=…`) is still accepted. Only mdvju.app links are accepted.
 *
 * shared/: plain TypeScript, no imports (URLSearchParams is a global in
 * Node and React Native).
 */

export const PAIR_LINK_BASE = "https://mdvju.app/pair";

/** The link hosts the app accepts (the ones whose AASA file covers `/pair*`). */
const PAIR_LINK_HOSTS = ["https://mdvju.app"];

export interface PairLink {
  code: string;
  backend: string;
  name: string | null;
}

export function buildPairLink(link: PairLink): string {
  const params = new URLSearchParams({ code: link.code, backend: link.backend });
  if (link.name) params.set("name", link.name);
  return `${PAIR_LINK_BASE}#${params.toString()}`;
}

/** The parameters after `<host>/pair?` or `<host>/pair#`, or null if `url` isn't a pairing link on one of our hosts. */
function pairLinkParams(url: string): string | null {
  for (const host of PAIR_LINK_HOSTS) {
    const base = `${host}/pair`;
    if (url.startsWith(base) && (url[base.length] === "?" || url[base.length] === "#")) return url.slice(base.length + 1);
  }
  return null;
}

/**
 * Whether `text` is on the pairing-link address at all, complete or not:
 * `<host>/pair`, bare or with a `?` or `#` part, on one of our hosts. An
 * incomplete one (no code or no backend) still opens the setup screen,
 * which says what's wrong, instead of being dropped.
 */
export function isPairLinkUrl(text: string): boolean {
  const url = text.trim();
  return pairLinkParams(url) !== null || PAIR_LINK_HOSTS.some((host) => url === `${host}/pair`);
}

/** The code, backend and name a pairing link carries, or null if `text` isn't one (or lacks the code or backend). */
export function parsePairLink(text: string): PairLink | null {
  const tail = pairLinkParams(text.trim());
  if (tail === null) return null;
  const params = new URLSearchParams(tail);
  const code = params.get("code");
  const backend = params.get("backend");
  if (!code || !backend) return null;
  return { code, backend, name: params.get("name") || null };
}
