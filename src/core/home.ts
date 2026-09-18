// Where the client keeps its state. One directory, SUPERSTABLES_HOME (default ~/.superstables):
//
//   policy.yaml            the owner's spend policy (optional; defaults apply)
//   records/               quotes, attempts and receipts, append-only JSONL (the agent side)
//   browser-wallet.json    which browser account last connected, when one is used
//   wallet/                the local wallet's own state: key, owner secret, agent token, audit log
//
// The agent side reads wallet/agent-token and nothing else under wallet/. The owner secret
// and the key are the wallet process's alone; no code outside src/wallet opens them.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function homeDir(): string {
  return resolve(process.env.SUPERSTABLES_HOME ?? join(homedir(), ".superstables"));
}

export function recordsDir(): string {
  return join(homeDir(), "records");
}

export function walletDir(): string {
  return join(homeDir(), "wallet");
}

export function policyPath(): string {
  return process.env.SUPERSTABLES_POLICY ?? join(homeDir(), "policy.yaml");
}

/** The wallet writes this; the agent side reads it. Bearer token for the agent-facing routes only. */
export function agentTokenPath(): string {
  return join(walletDir(), "agent-token");
}

export const DEFAULT_WALLET_PORT = 4411;
export const DEFAULT_DEMO_SERVICE_PORT = 4402;
/** Where the agent's own process serves the browser-wallet approval page. */
export const DEFAULT_APPROVE_PORT = 4412;

/**
 * Which account a browser wallet last connected with. Not a key and not a credential: only a
 * name, so `status` can say who would pay before a page has been opened.
 */
export function browserWalletPath(home: string = homeDir()): string {
  return join(home, "browser-wallet.json");
}

/** The approval server's audit log: one line per state change, never a signature. */
export function approvalsPath(dir: string = recordsDir()): string {
  return join(dir, "approvals.jsonl");
}

export function walletUrl(): string {
  return (process.env.SUPERSTABLES_WALLET_URL ?? `http://127.0.0.1:${DEFAULT_WALLET_PORT}`).replace(/\/$/, "");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
