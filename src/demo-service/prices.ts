// The demo service's data source: spot prices from Coinbase's public, keyless price API.
//
// The point of the demo is the payment, not the data, so this file stays deliberately dull:
// two HTTP reads with a short timeout, a 30 second cache so a burst of paid calls does not
// hammer the upstream, and a fallback chain that never throws. A paid call must always get an
// answer: if the upstream is down we serve the last value we had (source "cached"), and if we
// never had one we say so (source "unavailable") rather than failing a call the buyer paid for.

const SPOT_URL = "https://api.coinbase.com/v2/prices";
const UPSTREAM_TIMEOUT_MS = 5_000;
const CACHE_MS = 30_000;

export const DEMO_ASSETS = ["BTC", "ETH"] as const;
export type DemoAsset = (typeof DEMO_ASSETS)[number];

/** Where a price came from: the upstream just now, our cache, or nowhere. */
export type PriceOrigin = "live" | "cached" | "unavailable";

export interface SpotPrice {
  /** USD per unit, or null when no price could be obtained. */
  usd: number | null;
  /** When this price was read, ISO 8601. */
  at: string;
  /** Change against the same time yesterday, in percent, or null when unknown. */
  change24hPct?: number | null;
  source?: PriceOrigin;
}

/** What the service calls to get its data. Injectable so tests never touch the network. */
export type PriceLookup = () => Promise<Record<string, SpotPrice>>;

let cache: { at: number; value: Record<string, SpotPrice> } | undefined;

/** Percent change from `previous` to `current`, rounded to two decimals; null when undefined. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/** Forgets the cached prices. Tests use this; the service never needs it. */
export function clearPriceCache(): void {
  cache = undefined;
}

async function spot(pair: string, date?: string): Promise<number | null> {
  const url = date ? `${SPOT_URL}/${pair}/spot?date=${date}` : `${SPOT_URL}/${pair}/spot`;
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { data?: { amount?: string } };
  const amount = Number(body?.data?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function yesterday(now: number): string {
  return new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fetchOne(asset: DemoAsset, now: number): Promise<SpotPrice> {
  const usd = await spot(`${asset}-USD`);
  // The historical read is a bonus: if it fails, the price is still worth serving.
  const before = await spot(`${asset}-USD`, yesterday(now)).catch(() => null);
  return { usd, at: new Date(now).toISOString(), change24hPct: percentChange(usd, before), source: "live" };
}

/**
 * Spot prices for the assets the demo service sells, one entry per asset. Never throws:
 * an asset the upstream would not answer for comes back cached, or unavailable.
 */
export async function fetchSpotPrices(): Promise<Record<string, SpotPrice>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  const fresh: Record<string, SpotPrice> = {};
  let anyLive = false;
  for (const asset of DEMO_ASSETS) {
    const live = await fetchOne(asset, now).catch(() => undefined);
    if (live) {
      fresh[asset] = live;
      anyLive = true;
      continue;
    }
    const previous = cache?.value[asset];
    fresh[asset] = previous
      ? { ...previous, source: "cached" }
      : { usd: null, at: new Date(now).toISOString(), change24hPct: null, source: "unavailable" };
  }
  // A round that produced nothing new must not become the cache: the next call should try again
  // straight away, and whatever good value we still hold stays the fallback.
  if (anyLive) cache = { at: now, value: fresh };
  return fresh;
}
