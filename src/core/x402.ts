// x402 challenge detection and parsing, protocol v1 and v2 shapes. Detection is free:
// a paid endpoint answers HTTP 402 with its requirements, and reading them costs nothing.

import type { PaymentRequirements } from "@x402/core/types";
import { describeNetwork, fromAtomic, isSameAddress, networkFor, toCaip2 } from "./chain.js";
import type { PaymentTerms } from "./types.js";

export interface RawAccept {
  scheme?: string;
  network?: string;
  amount?: string;
  /** x402 v1 field name. */
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface RawChallenge {
  x402Version?: number;
  error?: string;
  resource?: string | { url?: string; description?: string };
  accepts?: RawAccept[];
}

export interface Challenge {
  version: 1 | 2;
  /** The seller's self-declared resource URL. Never use its hostname for policy. */
  resource: string;
  description: string;
  /** The raw requirement objects, in the order offered. */
  accepts: RawAccept[];
}

export function parseChallenge(input: { paymentRequiredHeader?: string | null; body?: string }): Challenge {
  const candidates = [
    input.paymentRequiredHeader ? Buffer.from(input.paymentRequiredHeader, "base64").toString("utf8") : undefined,
    input.body,
  ];
  let raw: RawChallenge | undefined;
  for (const text of candidates) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as RawChallenge;
      if (parsed && Array.isArray(parsed.accepts)) {
        raw = parsed;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  if (!raw || !Array.isArray(raw.accepts) || raw.accepts.length === 0) {
    throw new Error("No x402 challenge found in the 402 response (header or body)");
  }
  const resource = typeof raw.resource === "string" ? raw.resource : (raw.resource?.url ?? "");
  const description = typeof raw.resource === "object" && raw.resource ? (raw.resource.description ?? "") : "";
  return { version: raw.x402Version === 1 ? 1 : 2, resource, description, accepts: raw.accepts };
}

export class NotPaidEndpointError extends Error {
  constructor(readonly url: string, readonly status: number, readonly bodyPreview: string) {
    super(`Expected HTTP 402 from ${url}, got ${status}: not a paid x402 endpoint, or the request is wrong`);
    this.name = "NotPaidEndpointError";
  }
}

/** Fetch the endpoint and read its challenge. Throws NotPaidEndpointError on anything but 402. */
export async function detect(url: string, init: RequestInit = {}): Promise<Challenge> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
  const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  return parseChallenge({ paymentRequiredHeader: header, body });
}

export type Unsupported = { supported: false; reason: string };
export type Supported = { supported: true; terms: PaymentTerms; requirement: PaymentRequirements };

/**
 * Judge one offered requirement against what this client can pay: exact scheme, a supported
 * network, that network's USDC. Returns the terms the owner will be shown, derived only from
 * the requirement itself.
 */
export function termsFor(accept: RawAccept, version: 1 | 2): Supported | Unsupported {
  const scheme = accept.scheme ?? "exact";
  if (scheme !== "exact") return { supported: false, reason: `scheme "${scheme}" is not supported (only exact)` };
  const network = networkFor(accept.network ?? "");
  if (!network) return { supported: false, reason: `network ${describeNetwork(accept.network ?? "unknown")} is not supported (only ${describeNetwork("eip155:84532")})` };
  if (!accept.asset || !isSameAddress(accept.asset, network.usdc.address)) {
    return { supported: false, reason: `asset ${accept.extra?.name ?? accept.asset ?? "unknown"} is not USDC on ${network.label}` };
  }
  const atomic = accept.amount ?? accept.maxAmountRequired;
  if (!atomic || !/^\d+$/.test(String(atomic))) return { supported: false, reason: "the offered amount is missing or malformed" };
  if (!accept.payTo || !/^0x[0-9a-fA-F]{40}$/.test(accept.payTo)) return { supported: false, reason: "the recipient (payTo) is missing or malformed" };
  const amountAtomic = String(atomic);
  const terms: PaymentTerms = {
    amountDecimal: fromAtomic(amountAtomic, network.usdc.decimals),
    amountAtomic,
    asset: "USDC",
    assetAddress: network.usdc.address,
    network: network.caip2,
    networkLabel: network.label,
    recipient: accept.payTo,
    scheme,
    x402Version: version,
  };
  const requirement: PaymentRequirements = {
    scheme,
    network: (accept.network ?? network.caip2) as PaymentRequirements["network"],
    asset: accept.asset,
    amount: amountAtomic,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 300,
    extra: (accept.extra ?? {}) as Record<string, unknown>,
  };
  // v1 requirements keep their wire shape (maxAmountRequired, vernacular network) for the signer.
  if (version === 1) Object.assign(requirement, { maxAmountRequired: amountAtomic });
  return { supported: true, terms, requirement };
}

/** Two requirements name the same payment when amount, asset, recipient and network agree. */
export function sameTerms(a: PaymentTerms, b: PaymentTerms): boolean {
  return (
    a.amountAtomic === b.amountAtomic &&
    isSameAddress(a.assetAddress, b.assetAddress) &&
    isSameAddress(a.recipient, b.recipient) &&
    toCaip2(a.network) === toCaip2(b.network)
  );
}
