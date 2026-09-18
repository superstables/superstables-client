// The only file in the product that touches a private key. The key lives in one file,
// walletDir()/key, 0600, a 0x-prefixed hex string, and it is read by the wallet process
// alone: no agent, no CLI command other than `wallet init`, and nothing over HTTP ever
// sees it. Keeping it in a file (rather than a keychain or an encrypted store) is a
// deliberate choice for a testnet release: it is easy to inspect, easy to delete, and it
// holds test funds only.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ensureDir, walletDir } from "../core/home.js";

/** Owner-only, like an SSH private key: anything laxer and the key is not really private. */
const SECRET_MODE = 0o600;

export function keyPath(dir: string = walletDir()): string {
  return join(dir, "key");
}

export function keyExists(dir: string = walletDir()): boolean {
  return existsSync(keyPath(dir));
}

export interface InitKeyOptions {
  /** Where the key file lives. Defaults to walletDir(). */
  dir?: string;
  /** Use this key instead of generating one. With or without the 0x prefix. */
  importKey?: string;
  /** Replace an existing key. The old key, and anything it holds, becomes unreachable. */
  force?: boolean;
}

export interface InitKeyResult {
  address: string;
  /** True when a fresh key was generated, false when an existing key was imported. */
  created: boolean;
}

function normalizePrivateKey(input: string): `0x${string}` {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("that is not a private key: expected 64 hexadecimal characters, optionally prefixed with 0x");
  }
  return `0x${hex.toLowerCase()}`;
}

/** Writes a file only the owner can read, and says so to the filesystem even if it existed. */
function writeSecretFile(path: string, contents: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, contents, { mode: SECRET_MODE });
  chmodSync(path, SECRET_MODE);
}

/**
 * Creates the wallet's key, or imports one. Refuses to overwrite a key that already exists
 * unless `force` is set: losing a key silently is the one failure this file must not have.
 */
export function initKey(options: InitKeyOptions = {}): InitKeyResult {
  const dir = options.dir ?? walletDir();
  const path = keyPath(dir);
  if (existsSync(path) && !options.force) {
    throw new Error(`a wallet key already exists at ${path}; delete it, or pass --force to replace it (the old key cannot be recovered)`);
  }
  const key = options.importKey ? normalizePrivateKey(options.importKey) : generatePrivateKey();
  writeSecretFile(path, `${key}\n`);
  return { address: privateKeyToAccount(key).address, created: !options.importKey };
}

/** The wallet's account. Throws a sentence the user can act on when there is no key yet. */
export function loadAccount(dir: string = walletDir()): PrivateKeyAccount {
  const path = keyPath(dir);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("no wallet key yet: run `superstables wallet init`");
    }
    throw err;
  }
  return privateKeyToAccount(normalizePrivateKey(contents));
}

/**
 * Reads a 32-byte secret from a file, or creates one. Used for the wallet's two bearer
 * credentials: they must survive a restart, so the agent's token and the owner's approval
 * URL keep working, and they must never be readable by another user on the machine.
 */
export function readOrCreateSecret(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) {
      // An older file may predate the 0600 convention, or have been copied with a laxer mask.
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, SECRET_MODE);
      return existing;
    }
  }
  const secret = randomBytes(32).toString("hex");
  writeSecretFile(path, `${secret}\n`);
  return secret;
}
