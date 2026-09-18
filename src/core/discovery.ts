// Finding something to pay for. Two sources, deliberately kept apart:
//
//   the built-in catalogue   two services on the testnet with their request parameters
//                            written down: one run by us, one run by a third party. These
//                            are the listings this release can call end to end without a
//                            human reading docs.
//   the Superstables index   the public directory of x402 services. It records what a
//                            service costs and where it lives, but not yet the request
//                            parameters it needs, so those listings are shown and not
//                            acted on. Saying why is the point: an agent that cannot
//                            pay something should be able to explain the reason.
//
// The index is a nice-to-have: if it is slow or down, discovery still works and the
// caller gets a warning rather than an error.

import { describeNetwork, toCaip2 } from "./chain.js";
import type { ResolvedRequest, ServiceListing, ServiceParam } from "./types.js";

export const DEMO_SERVICE_ID = "superstables-demo-market-data";
export const EXTERNAL_COIN_PRICE_ID = "x402-coin-api.vercel.app";

/**
 * Where the demo service answers. Superstables runs it on the testnet, so a user does not have
 * to run anything to have something to buy; `SUPERSTABLES_DEMO_SERVICE_URL` points at another
 * instance, which is what `superstables demo-service` on this machine needs.
 */
export const HOSTED_DEMO_SERVICE_URL = "https://www.superstables.com/api/demo/market";

/** Where the public index lives. Overridable so a self-hosted index can be pointed at. */
export const INDEX_URL = process.env.SUPERSTABLES_INDEX_URL ?? "https://www.superstables.com/api/v1/services";

const INDEX_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_LIMIT = 20;

/** Words that should surface the demo service even though its text does not contain them. */
const DEMO_KEYWORDS = [
  "btc", "bitcoin", "eth", "ether", "ethereum", "crypto", "market", "market data", "data",
  "price", "prices", "quote", "demo", "example", "test", "testnet", "usdc", "superstables", "x402",
];

export interface FindServicesOptions {
  /** Free text. Empty or missing means "show me what there is". */
  query?: string;
  /** Most services to return, across both sources. */
  limit?: number;
  /** Ask the Superstables index too. On by default. */
  includeIndex?: boolean;
  /** Check that the demo service is actually answering. Costs one HTTP request. */
  probe?: boolean;
}

/** Discovery never fails because a remote source did: what went wrong comes back as a warning. */
export interface DiscoveryResult {
  services: ServiceListing[];
  warnings: string[];
}

/** The one service this release can discover, quote and pay without any further setup. */
export function demoService(): ServiceListing {
  const endpoint = process.env.SUPERSTABLES_DEMO_SERVICE_URL ?? HOSTED_DEMO_SERVICE_URL;
  const params: ServiceParam[] = [
    {
      name: "asset",
      in: "query",
      required: true,
      description: "Which asset to return market data for",
      example: "BTC",
      enum: ["BTC", "ETH"],
    },
  ];
  return {
    id: DEMO_SERVICE_ID,
    name: "Superstables demo market data",
    description:
      "Market data for BTC and ETH, priced per request and paid with test USDC on Base Sepolia. " +
      "A controlled service that exists so a payment can be demonstrated end to end without spending real money.",
    endpoint,
    method: "GET",
    params,
    payment: {
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
    },
    operator: "Superstables (demo service on the testnet)",
    source: "demo-catalogue",
    testnet: true,
    actionable: true,
  };
}

/**
 * A paid endpoint on Base Sepolia that somebody else runs. It is listed here, and not only
 * in the index, because the index does not yet record the one query parameter it needs.
 * Paying a seller nobody on our side controls is the point of listing it.
 */
export function externalCoinPriceService(): ServiceListing {
  return {
    id: EXTERNAL_COIN_PRICE_ID,
    name: "Coin price API (third party)",
    description:
      "Current price in USD for a coin symbol, paid per request with test USDC on Base Sepolia. " +
      "Run by an independent developer, not by Superstables; listed because it is live on the testnet.",
    endpoint: "https://x402-coin-api.vercel.app/api/price",
    method: "GET",
    params: [
      {
        name: "symbol",
        in: "query",
        required: true,
        description: "Coin symbol. BTC is the one this service has answered reliably; in our tests it returned bitcoin for other symbols too",
        enum: ["BTC"],
        example: "BTC",
      },
    ],
    payment: {
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.001, asset: "USDC", display: "0.001 USDC per request" },
    },
    operator: "Third party (not operated by Superstables)",
    source: "demo-catalogue",
    testnet: true,
    actionable: true,
  };
}

/** Every listing this release can call as-is: ours first, then the third-party one. */
export function catalogue(): ServiceListing[] {
  return [demoService(), externalCoinPriceService()];
}

/**
 * Search both sources. The catalogue comes first when the query plausibly asks for it,
 * because those are the listings that can be paid; index results follow.
 */
export async function findServices(options: FindServicesOptions = {}): Promise<DiscoveryResult> {
  const { query = "", limit = DEFAULT_LIMIT, includeIndex = true, probe = false } = options;
  const warnings: string[] = [];
  const services: ServiceListing[] = [];

  for (const listing of catalogue()) {
    if (matchesCatalogue(query, listing)) services.push(probe ? await probeDemo(listing) : listing);
  }

  if (includeIndex) {
    try {
      services.push(...(await fetchIndex(query, limit)));
    } catch (err) {
      warnings.push(
        `The Superstables index could not be read (${message(err)}); showing the built-in catalogue only.`,
      );
    }
  }

  return { services: services.slice(0, Math.max(0, limit)), warnings };
}

/** One listing by id, from either source. Undefined when nothing has that id. */
export async function getService(
  id: string,
  options: { includeIndex?: boolean; probe?: boolean } = {},
): Promise<ServiceListing | undefined> {
  const { includeIndex = true, probe = false } = options;
  const listed = catalogue().find((s) => s.id === id);
  if (listed) return probe ? await probeDemo(listed) : listed;
  if (!includeIndex) return undefined;
  try {
    const found = await fetchIndex(id, DEFAULT_LIMIT);
    return found.find((s) => s.id === id);
  } catch {
    return undefined; // an unreachable index is not an answer, and not a crash either
  }
}

/**
 * Turn a listing plus the caller's parameters into the exact URL that will be quoted and
 * paid. Refuses before any money is involved, with one sentence naming what is wrong and
 * what would be right.
 */
export function resolveRequest(service: ServiceListing, params: Record<string, string>): ResolvedRequest {
  const problems: string[] = [];
  const given: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") given[key] = String(value);
  }

  for (const param of service.params) {
    const value = given[param.name];
    if (value === undefined) {
      if (param.required) problems.push(`${param.name} is required${allowed(param)}`);
      continue;
    }
    if (param.enum && param.enum.length > 0 && !param.enum.some((v) => v.toLowerCase() === value.toLowerCase())) {
      problems.push(`${param.name}="${value}" is not one of ${param.enum.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Cannot call ${service.name}: ${problems.join("; ")}.`);
  }

  const url = new URL(service.endpoint);
  // Declared parameters first, in the order the service documents them, so two identical
  // calls always produce the same URL; anything else the caller passed follows.
  const ordered = [
    ...service.params.map((p) => p.name).filter((name) => given[name] !== undefined),
    ...Object.keys(given).filter((name) => !service.params.some((p) => p.name === name)),
  ];
  const resolved: Record<string, string> = {};
  for (const name of ordered) {
    const param = service.params.find((p) => p.name === name);
    // Match the documented spelling of an enum value, so the seller sees what it published.
    const value = param?.enum?.find((v) => v.toLowerCase() === given[name].toLowerCase()) ?? given[name];
    url.searchParams.set(name, value);
    resolved[name] = value;
  }

  return { serviceId: service.id, method: "GET", url: url.toString(), params: resolved };
}

// ── The built-in catalogue ─────────────────────────────────────────────────────────────

/** Does this query plausibly ask for a catalogue listing? An empty query asks for everything. */
function matchesCatalogue(query: string, listing: ServiceListing): boolean {
  const tokens = query.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  const haystack = [
    listing.id,
    listing.name,
    listing.description,
    listing.operator ?? "",
    ...listing.params.flatMap((p) => [p.name, p.description ?? "", p.example ?? "", ...(p.enum ?? [])]),
    ...DEMO_KEYWORDS,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/**
 * Is a catalogue service answering? A paid endpoint proves it is alive by asking for payment:
 * a 402 is the healthy answer. Anything else, including silence, means "not right now".
 */
async function probeDemo(service: ServiceListing): Promise<ServiceListing> {
  const url = service.params.some((p) => p.required && p.example)
    ? withExamples(service)
    : service.endpoint;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue; // try GET
      const live = res.status === 402;
      return live ? { ...service, live, lastSeenLive: new Date().toISOString() } : { ...service, live };
    } catch {
      if (method === "GET") return { ...service, live: false };
    }
  }
  return { ...service, live: false };
}

function withExamples(service: ServiceListing): string {
  const url = new URL(service.endpoint);
  for (const param of service.params) {
    if (param.required && param.example) url.searchParams.set(param.name, param.example);
  }
  return url.toString();
}

// ── The Superstables index ─────────────────────────────────────────────────────────────

/** One row of the public index, as the API returns it. */
interface IndexRow {
  id?: string;
  name?: string;
  description?: string;
  endpoint?: string;
  rails?: string[];
  chains?: string[];
  assets?: string[];
  price?: { display?: string; usd?: number };
  live?: boolean;
  last_seen_live?: string;
}

async function fetchIndex(query: string, limit: number): Promise<ServiceListing[]> {
  const url = new URL(INDEX_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("live", "true");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { services?: IndexRow[] } | IndexRow[];
  const rows = Array.isArray(body) ? body : (body.services ?? []);
  return rows.filter((row) => row && row.id && row.endpoint).map(fromIndexRow);
}

function fromIndexRow(row: IndexRow): ServiceListing {
  const chains = row.chains ?? [];
  const chain = chains[0] ?? "";
  const payable = chains.some((c) => toCaip2(c) === "eip155:84532");
  const testnet = chains.some((c) => /sepolia|testnet|devnet/i.test(c));
  return {
    id: String(row.id),
    name: row.name ?? String(row.id),
    description: row.description ?? "",
    endpoint: String(row.endpoint),
    method: "GET",
    // The index does not record request parameters yet; an empty list says exactly that.
    params: [],
    payment: {
      rail: "x402",
      scheme: "exact",
      network: toCaip2(chain),
      networkLabel: describeNetwork(chain),
      asset: row.assets?.[0] ?? "USDC",
      price:
        typeof row.price?.usd === "number"
          ? {
              amountDecimal: row.price.usd,
              asset: row.assets?.[0] ?? "USDC",
              display: row.price.display ?? `${row.price.usd} ${row.assets?.[0] ?? "USDC"}`,
            }
          : undefined,
    },
    source: "superstables-index",
    live: row.live,
    lastSeenLive: row.last_seen_live,
    testnet,
    actionable: false,
    notActionableReason: payable
      ? "the index does not yet record the request parameters this service needs"
      : "mainnet network not supported in this release",
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function allowed(param: ServiceParam): string {
  if (param.enum && param.enum.length > 0) return ` (one of ${param.enum.join(", ")})`;
  if (param.example) return ` (for example ${param.example})`;
  return "";
}
