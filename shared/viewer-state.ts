/**
 * The home page + favourites state: how a stored copy is
 * read, and the edits to it. The backend applies them in a read-modify-write
 * of its state file, the folder source under its own storage key; a
 * toggle, not a client-sent full list, so a stale client copy can't clobber
 * favourites added elsewhere.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

import type { ViewerState } from "./api-types";

/** `rel` added to the favourites, or removed if it's already one. */
export function toggleFavourite(state: ViewerState, rel: string): ViewerState {
  return {
    ...state,
    favourites: state.favourites.includes(rel) ? state.favourites.filter((f) => f !== rel) : [...state.favourites, rel],
  };
}

/**
 * A stored viewer state: `raw` is its JSON, or null if none is stored yet
 * (the empty defaults). Fields of the wrong type read as their defaults,
 * and non-string favourites are dropped. Throws if `raw` isn't JSON: a
 * read-modify-write on top of empty defaults would wipe every favourite,
 * so each caller decides what a corrupt copy means.
 */
export function parseViewerState(raw: string | null): ViewerState {
  if (raw === null) return { homePath: null, favourites: [] };
  const parsed = JSON.parse(raw);
  return {
    homePath: typeof parsed?.homePath === "string" ? parsed.homePath : null,
    favourites: Array.isArray(parsed?.favourites)
      ? parsed.favourites.filter((f: unknown): f is string => typeof f === "string")
      : [],
  };
}
