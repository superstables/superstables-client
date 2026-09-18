// termsFor() is the gate: it decides, from the seller's own requirement and nothing else,
// whether this client can pay at all. Everything it refuses must be refused with a reason a
// person can act on, because "unsupported" alone tells an agent nothing.

import { describe, expect, it } from "vitest";
import { parseChallenge, sameTerms, termsFor, type RawAccept } from "../../src/core/x402.js";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { usdcRequirement } from "../../src/core/chain.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = `0x${"22".repeat(20)}`;

/** A v2 requirement, the shape a current x402 seller offers. */
const v2: RawAccept = {
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

/** A v1 requirement: vernacular network name, maxAmountRequired instead of amount. */
const v1: RawAccept = {
  scheme: "exact",
  network: "base-sepolia",
  asset: USDC,
  maxAmountRequired: "5000",
  payTo: PAY_TO,
  extra: { name: "USDC", version: "2" },
};

describe("termsFor", () => {
  it("accepts a v2 requirement and derives what the owner will be shown", () => {
    const judged = termsFor(v2, 2);
    expect(judged.supported).toBe(true);
    if (!judged.supported) return;
    expect(judged.terms).toMatchObject({
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "USDC",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      recipient: PAY_TO,
      scheme: "exact",
      x402Version: 2,
    });
    expect(judged.requirement.amount).toBe("10000");
  });

  it("accepts a v1 requirement and keeps its wire shape for the signer", () => {
    const judged = termsFor(v1, 1);
    expect(judged.supported).toBe(true);
    if (!judged.supported) return;
    expect(judged.terms.amountDecimal).toBe(0.005);
    expect(judged.terms.network).toBe("eip155:84532");
    expect(judged.terms.x402Version).toBe(1);
    // The signer must see the names the v1 seller used.
    expect(judged.requirement.network).toBe("base-sepolia");
    expect((judged.requirement as Record<string, unknown>).maxAmountRequired).toBe("5000");
  });

  it("refuses a network this release does not pay on, and names it", () => {
    const judged = termsFor({ ...v2, network: "eip155:8453" }, 2);
    expect(judged.supported).toBe(false);
    if (judged.supported) return;
    expect(judged.reason).toContain("Base (mainnet)");
    expect(judged.reason).toContain("Base Sepolia (testnet)");
  });

  it("refuses an asset that is not that network's USDC", () => {
    const judged = termsFor({ ...v2, asset: `0x${"99".repeat(20)}`, extra: { name: "DAI" } }, 2);
    expect(judged.supported).toBe(false);
    if (judged.supported) return;
    expect(judged.reason).toContain("DAI");
    expect(judged.reason).toContain("not USDC");
  });

  it("refuses a scheme other than exact", () => {
    const judged = termsFor({ ...v2, scheme: "upto" }, 2);
    expect(judged.supported).toBe(false);
    if (judged.supported) return;
    expect(judged.reason).toContain("upto");
    expect(judged.reason).toContain("only exact");
  });

  it("refuses a malformed amount or recipient", () => {
    expect(termsFor({ ...v2, amount: "0.01" }, 2)).toMatchObject({ supported: false });
    expect(termsFor({ ...v2, amount: undefined }, 2)).toMatchObject({ supported: false });
    expect(termsFor({ ...v2, payTo: "not-an-address" }, 2)).toMatchObject({ supported: false });
  });
});

describe("parseChallenge", () => {
  it("reads a challenge from the header the SDK writes", () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/v1/market", description: "Market data for one asset" },
      accepts: [usdcRequirement(0.01, PAY_TO)],
    });
    const challenge = parseChallenge({ paymentRequiredHeader: header });
    expect(challenge.version).toBe(2);
    expect(challenge.description).toBe("Market data for one asset");
    expect(challenge.accepts).toHaveLength(1);
  });

  it("falls back to the body when there is no header", () => {
    const body = JSON.stringify({ x402Version: 1, resource: "http://x/y", accepts: [v1] });
    expect(parseChallenge({ paymentRequiredHeader: null, body }).version).toBe(1);
  });

  it("refuses to invent a challenge that is not there", () => {
    expect(() => parseChallenge({ body: "<html>402</html>" })).toThrow(/No x402 challenge/);
  });
});

describe("sameTerms", () => {
  const base = termsFor(v2, 2);
  it("sees through a network spelling but not through a price change", () => {
    if (!base.supported) throw new Error("fixture");
    const asV1 = termsFor({ ...v2, network: "base-sepolia" }, 1);
    if (!asV1.supported) throw new Error("fixture");
    expect(sameTerms(base.terms, asV1.terms)).toBe(true);

    const dearer = termsFor({ ...v2, amount: "20000" }, 2);
    if (!dearer.supported) throw new Error("fixture");
    expect(sameTerms(base.terms, dearer.terms)).toBe(false);
  });
});
