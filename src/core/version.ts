// Which build is this? The one question a machine that has been reinstalled a few times cannot
// answer by looking, and the reason it matters: a desktop host that keeps an older copy of the
// extension around looks exactly like a host running the new one, until something asks.
//
// The answer is the version in package.json, and it is deliberately read from the file rather
// than baked in at compile time, because the bundle ships a package.json of its own: the copy
// staged by `npm run bundle` is what a user's machine actually holds, so stamping that copy
// (see `npm run bundle -- --dev`) is enough for every surface here to report the real build.
//
// The same file is found from source and from the build: `src/core/version.ts` and
// `dist/core/version.js` are both two directories below the package root.

import { readFileSync } from "node:fs";

/** Read once per process: this cannot change while the server runs, and it is on a hot path. */
let cached: string | undefined;

export function clientVersion(): string {
  if (cached === undefined) cached = readVersion();
  return cached;
}

function readVersion(): string {
  try {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    // A version is a diagnostic, never a reason to fail: an unreadable package.json says so.
    return "0.0.0";
  }
}
