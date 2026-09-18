// The ledger must never lose a record and never silently change one. These tests pin the
// two properties the rest of the client leans on: the newest line for an id wins, and a
// half-written line does not take the rest of the file down with it.

import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Records } from "../../src/core/records.js";
import type { PaymentTerms, Quote, Receipt } from "../../src/core/types.js";

const dirs: string[] = [];

function records(): Records {
  const dir = mkdtempSync(join(tmpdir(), "superstables-records-"));
  dirs.push(dir);
  return new Records(dir);
}

const terms = (amountDecimal = 0.01, asset = "USDC"): PaymentTerms => ({
  amountDecimal,
  amountAtomic: String(Math.round(amountDecimal * 1e6)),
  asset,
  assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  network: "eip155:84532",
  networkLabel: "Base Sepolia (testnet)",
  recipient: `0x${"22".repeat(20)}`,
  scheme: "exact",
  x402Version: 2,
});

const quote = (id: string, status: Quote["status"] = "open"): Quote => ({
  id,
  createdAt: "2026-01-01T10:00:00.000Z",
  expiresAt: "2026-01-01T10:10:00.000Z",
  status,
  url: "http://127.0.0.1:4402/v1/market?asset=BTC",
  terms: terms(),
  requirement: { scheme: "exact", network: "eip155:84532", asset: terms().assetAddress, amount: "10000", payTo: terms().recipient, maxTimeoutSeconds: 300, extra: {} },
  policy: { allowed: true },
  approval: "wallet",
});

const receipt = (id: string, at: string, amountDecimal: number, asset = "USDC"): Receipt => ({
  id,
  at,
  quoteId: `q-${id}`,
  attemptId: id,
  url: "http://127.0.0.1:4402/v1/market?asset=BTC",
  terms: terms(amountDecimal, asset),
  payer: `0x${"33".repeat(20)}`,
  transaction: `0x${"44".repeat(32)}`,
  transactionKind: "hash",
  transactionUrl: "https://sepolia.basescan.org/tx/0x",
  network: "eip155:84532",
  settlement: { success: true, transaction: `0x${"44".repeat(32)}`, network: "eip155:84532" },
  serviceOutcome: "ok",
  ms: 1200,
});

afterEach(() => {
  dirs.length = 0;
});

describe("Records", () => {
  it("round-trips quotes, attempts and receipts", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    r.saveAttempt({
      id: "a1",
      quoteId: "q1",
      createdAt: "2026-01-01T10:00:01.000Z",
      updatedAt: "2026-01-01T10:00:01.000Z",
      state: "awaiting_approval",
      url: "http://127.0.0.1/x",
      terms: terms(),
      history: [{ at: "2026-01-01T10:00:01.000Z", state: "awaiting_approval" }],
    });
    r.saveReceipt(receipt("a1", "2026-01-01T10:00:09.000Z", 0.01));

    expect(r.getQuote("q1")?.status).toBe("open");
    expect(r.getAttempt("a1")?.state).toBe("awaiting_approval");
    expect(r.getReceipt("a1")?.terms.amountDecimal).toBe(0.01);
    expect(r.listQuotes()).toHaveLength(1);
    expect(r.listAttempts()).toHaveLength(1);
    expect(r.listReceipts(1)).toHaveLength(1);
    expect(r.getQuote("nope")).toBeUndefined();
  });

  it("keeps every line but answers with the latest one for an id", () => {
    const r = records();
    r.saveQuote(quote("q1", "open"));
    r.saveQuote(quote("q1", "used"));
    r.saveQuote(quote("q2", "open"));

    expect(r.getQuote("q1")?.status).toBe("used");
    expect(r.listQuotes()).toHaveLength(2);
    // Append-only: the superseded line is still on disk.
    const lines = readFileSync(join(r.dir, "quotes.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("creates its files readable by their owner only", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    expect(statSync(join(r.dir, "quotes.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("skips a torn line instead of failing the whole read", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    appendFileSync(join(r.dir, "quotes.jsonl"), '{"id":"q2","status":"op');
    r.saveQuote(quote("q3"));

    expect(r.listQuotes().map((q) => q.id).sort()).toEqual(["q1", "q3"]);
  });

  it("sums today's payments per asset, ignoring other days and other assets", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:00.000Z", 0.01));
    r.saveReceipt(receipt("r2", "2026-03-04T09:30:00.000Z", 0.025));
    r.saveReceipt(receipt("r3", "2026-03-03T23:59:59.000Z", 5)); // yesterday
    r.saveReceipt(receipt("r4", "2026-03-04T10:00:00.000Z", 7, "EURC")); // another asset

    expect(r.spentToday("USDC", now)).toBe(0.035);
    expect(r.spentToday("usdc", now)).toBe(0.035);
    expect(r.spentToday("EURC", now)).toBe(7);
    expect(r.spentToday("USDC", new Date("2026-03-05T00:00:01.000Z"))).toBe(0);
  });

  it("counts a corrected receipt once", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:00.000Z", 0.01));
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:05.000Z", 0.02));
    expect(r.spentToday("USDC", now)).toBe(0.02);
  });

  it("gives out ids that do not repeat", () => {
    const r = records();
    expect(r.newId()).not.toBe(r.newId());
    expect(r.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
