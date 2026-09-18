// Failover with a rule attached: an outage is worth retrying elsewhere, a refusal is not.
// If a facilitator says the payment is not valid, asking the next one would be shopping for
// a different answer with a credential that has already been shown once.

import { afterEach, describe, expect, it } from "vitest";
import type { PaymentPayload } from "@x402/core/types";
import { usdcRequirement } from "../../src/core/chain.js";
import { FACILITATORS, firstThatWorks, settleWith, verifyWith } from "../../src/core/facilitator.js";
import { readBody, sendJson, startServer, type TestServer } from "../helpers/servers.js";

const open: TestServer[] = [];
const requirement = usdcRequirement(0.01, `0x${"22".repeat(20)}`);
const payload: PaymentPayload = { x402Version: 2, accepted: requirement, payload: { signature: "0x", authorization: {} } };

/** A facilitator with an opinion, and a count of how often it was asked. */
async function facilitator(answer: {
  verify?: Record<string, unknown>;
  settle?: Record<string, unknown>;
  status?: number;
}): Promise<TestServer & { calls: { verify: number; settle: number } }> {
  const calls = { verify: 0, settle: 0 };
  const server = await startServer(async (req, res) => {
    await readBody(req);
    if (req.url === "/verify") {
      calls.verify += 1;
      sendJson(res, answer.status ?? 200, answer.verify ?? { isValid: true });
      return;
    }
    calls.settle += 1;
    sendJson(res, answer.status ?? 200, answer.settle ?? { success: true, transaction: "0xfeed", network: "eip155:84532" });
  });
  open.push(server);
  return { ...server, calls };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("FACILITATORS", () => {
  it("lists the public facilitators in failover order", () => {
    expect([...FACILITATORS]).toEqual([
      "https://facilitator.x402.rs",
      "https://facilitator.payai.network",
      "https://x402.org/facilitator",
    ]);
  });
});

describe("firstThatWorks", () => {
  it("moves past a candidate that throws and says which one answered", async () => {
    const tried: string[] = [];
    const result = await firstThatWorks(["a", "b", "c"], async (url) => {
      tried.push(url);
      if (url !== "b") throw new Error(`${url} is down`);
      return "answer";
    });
    expect(result).toEqual({ value: "answer", via: "b" });
    expect(tried).toEqual(["a", "b"]);
  });

  it("collects every failure when none of them answer", async () => {
    await expect(
      firstThatWorks(["a", "b"], async (url) => {
        throw new Error(`${url} is down`);
      }),
    ).rejects.toThrow(/No facilitator could be reached: a \(a is down\); b \(b is down\)/);
  });

  it("refuses to guess when there is nowhere to ask", async () => {
    await expect(firstThatWorks([], async () => "x")).rejects.toThrow(/No facilitator was configured/);
  });
});

describe("verifyWith and settleWith", () => {
  it("falls over to the next facilitator when one cannot be reached", async () => {
    const working = await facilitator({});
    const settled = await settleWith(payload, requirement, ["http://127.0.0.1:1", working.url]);
    expect(settled.success).toBe(true);
    expect(settled.via).toBe(working.url);
    expect(working.calls.settle).toBe(1);
  });

  it("believes a facilitator that says no, and does not ask the next one", async () => {
    const refusing = await facilitator({ settle: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" } });
    const spare = await facilitator({});

    const settled = await settleWith(payload, requirement, [refusing.url, spare.url]);

    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("insufficient_funds");
    expect(settled.via).toBe(refusing.url);
    expect(spare.calls.settle).toBe(0);
  });

  it("treats a refusal carried as an HTTP error as that facilitator's answer too", async () => {
    const refusing = await facilitator({ verify: { isValid: false, invalidReason: "invalid_signature" }, status: 400 });
    const spare = await facilitator({});

    const verified = await verifyWith(payload, requirement, [refusing.url, spare.url]);

    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe("invalid_signature");
    expect(spare.calls.verify).toBe(0);
  });
});
