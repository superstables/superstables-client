// Facilitators submit the transfer on chain and pay the gas, so an agent can pay without
// ever holding native currency. They are the one remote dependency of a payment, so this
// file holds the failover list and the rule that goes with it:
//
//   a facilitator that cannot be reached is skipped,
//   a facilitator that answers "no" is believed.
//
// The distinction matters. Retrying a refusal on the next facilitator would be shopping
// for a yes with a credential that has already been shown; retrying an outage is just
// finding a working phone line.

import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";

/** Public facilitators that settle x402 exact payments on Base Sepolia, in failover order. */
export const FACILITATORS: readonly string[] = [
  "https://facilitator.x402.rs",
  "https://facilitator.payai.network",
  "https://x402.org/facilitator",
];

/** Long enough for a testnet transaction to be submitted and confirmed, short enough to fail. */
export const FACILITATOR_TIMEOUT_MS = 20_000;

export function facilitatorClient(url: string): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({ url, timeoutMs: FACILITATOR_TIMEOUT_MS });
}

/** Which facilitator answered. Recorded on the receipt so a payment can be traced later. */
export interface Via {
  via: string;
}

/**
 * Try each candidate in order until one answers. A thrown error means "this one did not
 * answer" and moves on; a returned value, whatever it says, ends the search.
 */
export async function firstThatWorks<T>(
  candidates: readonly string[],
  attempt: (url: string) => Promise<T>,
): Promise<{ value: T; via: string }> {
  if (candidates.length === 0) throw new Error("No facilitator was configured to settle this payment");
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      return { value: await attempt(url), via: url };
    } catch (err) {
      failures.push(`${url} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  throw new Error(`No facilitator could be reached: ${failures.join("; ")}`);
}

/** Ask a facilitator whether this credential would settle. Costs nothing and moves nothing. */
export async function verifyWith(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitators: readonly string[] = FACILITATORS,
): Promise<VerifyResponse & Via> {
  const { value, via } = await firstThatWorks(facilitators, async (url) => {
    try {
      return await facilitatorClient(url).verify(payload, requirements);
    } catch (err) {
      // A refusal carried as an HTTP error is still this facilitator's own answer.
      if (err instanceof VerifyError) {
        return {
          isValid: false,
          invalidReason: err.invalidReason,
          invalidMessage: err.invalidMessage,
          payer: err.payer,
        } satisfies VerifyResponse;
      }
      throw err;
    }
  });
  return { ...value, via };
}

/** Ask a facilitator to submit the transfer. This is the step that moves money. */
export async function settleWith(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitators: readonly string[] = FACILITATORS,
): Promise<SettleResponse & Via> {
  const { value, via } = await firstThatWorks(facilitators, async (url) => {
    try {
      return await facilitatorClient(url).settle(payload, requirements);
    } catch (err) {
      if (err instanceof SettleError) {
        return {
          success: false,
          errorReason: err.errorReason,
          errorMessage: err.errorMessage,
          payer: err.payer,
          transaction: err.transaction,
          network: err.network,
        } satisfies SettleResponse;
      }
      throw err;
    }
  });
  return { ...value, via };
}
