// A signer that holds a private key in memory. Two legitimate users: the wallet process
// (the only place a key lives in the product) and tests. An agent never gets one.

import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import type { PrivateKeyAccount } from "viem/accounts";
import { networkFor } from "../chain.js";
import { SignRefused, type SignHooks, type SignRequest, type SignResult, type Signer } from "./types.js";

export class LocalKeySigner implements Signer {
  readonly kind = "local" as const;
  constructor(private readonly account: PrivateKeyAccount) {}

  get addressSync(): string {
    return this.account.address;
  }

  async address(network: string): Promise<string> {
    if (!networkFor(network)) throw new Error(`no identity on ${network}`);
    return this.account.address;
  }

  async sign(req: SignRequest, _hooks?: SignHooks): Promise<SignResult> {
    if (req.kind !== "eip3009") throw new SignRefused("invalid", `cannot sign ${(req as { kind: string }).kind}`);
    // v1 requirements carry maxAmountRequired and a vernacular network name; the SDK has a
    // separate scheme for them. Both produce the same {signature, authorization} payload.
    const scheme = req.x402Version === 1 ? new ExactEvmSchemeV1(this.account) : new ExactEvmScheme(this.account);
    const created = await scheme.createPaymentPayload(req.x402Version, req.requirements);
    return {
      kind: "eip3009",
      payload: created.payload as { signature: string; authorization: Record<string, unknown> },
      signer: this.account.address,
    };
  }
}
