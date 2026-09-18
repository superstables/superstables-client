// The key file: created once, never overwritten by accident, readable by nobody else.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKey, keyExists, keyPath, loadAccount, readOrCreateSecret } from "../../src/wallet/keystore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "superstables-keystore-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ownerOnly = (path: string) => (statSync(path).mode & 0o777) === 0o600;

describe("initKey", () => {
  it("generates a key only the owner can read", () => {
    expect(keyExists(dir)).toBe(false);
    const created = initKey({ dir });
    expect(created.created).toBe(true);
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(keyExists(dir)).toBe(true);
    expect(ownerOnly(keyPath(dir))).toBe(true);
    expect(loadAccount(dir).address).toBe(created.address);
  });

  it("imports a key, with or without the 0x prefix", () => {
    const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const imported = initKey({ dir, importKey: key.slice(2) });
    expect(imported.created).toBe(false);
    expect(imported.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
  });

  it("refuses to overwrite an existing key unless asked twice", () => {
    const first = initKey({ dir });
    expect(() => initKey({ dir })).toThrow(/already exists/);
    expect(loadAccount(dir).address).toBe(first.address);
    const replaced = initKey({ dir, force: true });
    expect(replaced.address).not.toBe(first.address);
  });

  it("refuses something that is not a private key", () => {
    expect(() => initKey({ dir, importKey: "hunter2" })).toThrow(/not a private key/);
  });
});

describe("loadAccount", () => {
  it("says what to do when there is no key yet", () => {
    expect(() => loadAccount(dir)).toThrow("no wallet key yet: run `superstables wallet init`");
  });
});

describe("readOrCreateSecret", () => {
  it("creates a 32-byte secret once and reads the same one back", () => {
    const path = join(dir, "agent-token");
    const first = readOrCreateSecret(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerOnly(path)).toBe(true);
    expect(readOrCreateSecret(path)).toBe(first);
  });

  it("tightens the permissions of a secret that was left readable", () => {
    const path = join(dir, "owner-secret");
    writeFileSync(path, "abc123\n", { mode: 0o644 });
    expect(readOrCreateSecret(path)).toBe("abc123");
    expect(ownerOnly(path)).toBe(true);
  });
});
