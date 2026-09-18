// A facilitator that answers the way the real ones do, without a chain behind it.
//
// Unit tests must not touch the network, and the interesting cases (a facilitator that is
// down, one that rejects a payment, one that settles but reports a failure) are exactly the
// ones a real facilitator will not perform on request. This server speaks the wire protocol
// @x402/core's HTTPFacilitatorClient expects — GET /supported, POST /verify, POST /settle,
// each with the body {x402Version, paymentPayload, paymentRequirements} — and nothing else.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** The reason a rejecting fake facilitator gives, in the snake_case style the real ones use. */
export const FAKE_INVALID_REASON = "insufficient_funds";
/** The reason a fake facilitator gives when the transfer itself fails. */
export const FAKE_SETTLE_ERROR_REASON = "settlement_failed";

const NETWORK = "eip155:84532";

export interface FakeFacilitatorOptions {
  /** true (default), false, or a predicate over the payment the buyer sent. */
  verifyOk?: boolean | ((payload: PaymentPayload, requirements: PaymentRequirements) => boolean);
  settleOk?: boolean;
  /** The transaction hash to report; a random one by default. */
  transaction?: string;
  /** Delay every answer, to exercise timeouts and ordering. */
  delayMs?: number;
  /** Answer this HTTP status to every route instead of playing along: a facilitator that is down. */
  failWith?: number;
}

export interface FakeFacilitatorCall {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface FakeFacilitator {
  url: string;
  /** The transaction hash this facilitator reports on a successful settle. */
  transaction: string;
  calls: { supported: number; verify: number; settle: number };
  lastVerify?: FakeFacilitatorCall;
  lastSettle?: FakeFacilitatorCall;
  close(): Promise<void>;
}

function randomTx(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The address that signed the EIP-3009 authorization, when the payload carries one. */
function payerOf(payload: PaymentPayload | undefined): string | undefined {
  const authorization = (payload?.payload as { authorization?: { from?: unknown } } | undefined)?.authorization;
  return typeof authorization?.from === "string" ? authorization.from : undefined;
}

export async function startFakeFacilitator(opts: FakeFacilitatorOptions = {}): Promise<FakeFacilitator> {
  const transaction = opts.transaction ?? randomTx();
  const calls = { supported: 0, verify: 0, settle: 0 };
  const state: { lastVerify?: FakeFacilitatorCall; lastSettle?: FakeFacilitatorCall } = {};

  const pause = async () => {
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      await pause();

      // Counted on arrival, so a test can still see that failover reached a dead facilitator.
      if (req.method === "GET" && path === "/supported") calls.supported += 1;
      if (req.method === "POST" && path === "/verify") calls.verify += 1;
      if (req.method === "POST" && path === "/settle") calls.settle += 1;

      // A facilitator that is down answers something that is not a verify or settle result,
      // which is what makes a caller's failover skip it rather than treat it as a refusal.
      if (opts.failWith) {
        sendJson(res, opts.failWith, { error: "this facilitator is unavailable" });
        return;
      }

      if (req.method === "GET" && path === "/supported") {
        sendJson(res, 200, {
          kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
          extensions: [],
          signers: {},
        });
        return;
      }

      if (req.method === "POST" && (path === "/verify" || path === "/settle")) {
        const body = await readJson(req);
        const payload = body.paymentPayload as PaymentPayload | undefined;
        const requirements = body.paymentRequirements as PaymentRequirements | undefined;
        const call: FakeFacilitatorCall = {
          payload: payload as PaymentPayload,
          requirements: requirements as PaymentRequirements,
        };
        const payer = payerOf(payload);

        if (path === "/verify") {
          state.lastVerify = call;
          const decide = opts.verifyOk ?? true;
          const isValid = typeof decide === "function" ? decide(call.payload, call.requirements) : decide;
          sendJson(res, 200, isValid ? { isValid: true, payer } : { isValid: false, payer, invalidReason: FAKE_INVALID_REASON });
          return;
        }

        state.lastSettle = call;
        const success = opts.settleOk ?? true;
        sendJson(
          res,
          200,
          success
            ? { success: true, payer, transaction, network: NETWORK }
            : { success: false, payer, transaction: "", network: NETWORK, errorReason: FAKE_SETTLE_ERROR_REASON },
        );
        return;
      }

      sendJson(res, 404, { error: `no such facilitator route: ${path}` });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "fake facilitator failed" });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    transaction,
    calls,
    get lastVerify() {
      return state.lastVerify;
    },
    get lastSettle() {
      return state.lastSettle;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
