// Discovery has two jobs: put the one service that can actually be paid in front of the
// agent, and be honest about the rest. A listing that cannot be acted on must say why, in
// words that tell the agent whether to wait for a release or to look elsewhere.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_SERVICE_ID,
  EXTERNAL_COIN_PRICE_ID,
  HOSTED_DEMO_SERVICE_URL,
  catalogue,
  demoService,
  findServices,
  getService,
  resolveRequest,
} from "../../src/core/discovery.js";
import { startServer } from "../helpers/servers.js";

/** A response shaped like the public index: a testnet service and a mainnet one. */
const INDEX_FIXTURE = {
  services: [
    {
      id: "example-weather",
      name: "Example weather",
      description: "Hourly forecasts for one city.",
      endpoint: "https://api.example.com/weather",
      rails: ["x402"],
      chains: ["base-sepolia"],
      assets: ["USDC"],
      price: { display: "0.005 USDC per call", usd: 0.005 },
      live: true,
      last_seen_live: "2026-09-15T08:00:00.000Z",
    },
    {
      id: "example-filings",
      name: "Example filings",
      description: "Company filings, paid per document.",
      endpoint: "https://api.example.net/filings",
      rails: ["x402"],
      chains: ["base"],
      assets: ["USDC"],
      price: { display: "0.25 USDC per document", usd: 0.25 },
      live: true,
      last_seen_live: "2026-09-16T08:00:00.000Z",
    },
  ],
};

function stubIndex(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPERSTABLES_DEMO_SERVICE_URL;
});

describe("findServices", () => {
  it("puts the built-in demo service first and marks it payable", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services, warnings } = await findServices({});
    expect(warnings).toEqual([]);
    expect(services[0]).toMatchObject({
      id: DEMO_SERVICE_ID,
      source: "demo-catalogue",
      actionable: true,
      testnet: true,
      operator: "Superstables (demo service on the testnet)",
    });
    expect(services[0].payment).toMatchObject({
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
    });
    expect(services[0].params).toEqual([
      {
        name: "asset",
        in: "query",
        required: true,
        description: "Which asset to return market data for",
        example: "BTC",
        enum: ["BTC", "ETH"],
      },
    ]);
  });

  it("surfaces the demo service for the words a person would search with", async () => {
    stubIndex({ services: [] });
    for (const query of ["btc", "Bitcoin", "market data", "price", "demo", ""]) {
      const { services } = await findServices({ query });
      expect(services.map((s) => s.id), `query: ${query}`).toContain(DEMO_SERVICE_ID);
    }
  });

  it("leaves the demo service out of a search it has nothing to do with", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "shipping container tracking" });
    expect(services.map((s) => s.id)).not.toContain(DEMO_SERVICE_ID);
    expect(services[0].source).toBe("superstables-index");
  });

  it("maps index rows and says exactly why each one cannot be paid yet", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "example" });
    const weather = services.find((s) => s.id === "example-weather");
    const filings = services.find((s) => s.id === "example-filings");

    expect(weather).toMatchObject({
      name: "Example weather",
      endpoint: "https://api.example.com/weather",
      source: "superstables-index",
      params: [],
      actionable: false,
      notActionableReason: "the index does not yet record the request parameters this service needs",
      testnet: true,
      live: true,
      lastSeenLive: "2026-09-15T08:00:00.000Z",
    });
    expect(weather?.payment).toMatchObject({
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      price: { amountDecimal: 0.005, display: "0.005 USDC per call" },
    });

    expect(filings).toMatchObject({
      actionable: false,
      notActionableReason: "mainnet network not supported in this release",
      testnet: false,
    });
    expect(filings?.payment.networkLabel).toBe("Base (mainnet)");
  });

  it("asks the index with the query, live and limit it documents", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    await findServices({ query: "weather", limit: 5 });
    const asked = new URL(String(fetchMock.mock.calls[0][0]));
    expect(asked.searchParams.get("q")).toBe("weather");
    expect(asked.searchParams.get("live")).toBe("true");
    expect(asked.searchParams.get("limit")).toBe("5");
  });

  it("turns an index failure into a warning, not an error", async () => {
    stubIndex({ error: "gateway" }, { status: 502 });
    const { services, warnings } = await findServices({ query: "market" });
    expect(services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("index could not be read");
  });

  it("does not ask the index when told not to", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ includeIndex: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(services).toHaveLength(2);
  });

  it("returns at most the limit asked for", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ limit: 2 });
    expect(services).toHaveLength(2);
  });
});

describe("where the demo service is", () => {
  it("points at the service Superstables hosts, so there is nothing to run", () => {
    expect(HOSTED_DEMO_SERVICE_URL).toBe("https://www.superstables.com/api/demo/market");
    expect(demoService().endpoint).toBe(HOSTED_DEMO_SERVICE_URL);
  });

  it("lets the environment point at another instance, which is how a local seller is used", () => {
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = "http://127.0.0.1:4402/v1/market";
    expect(demoService().endpoint).toBe("http://127.0.0.1:4402/v1/market");
    expect(resolveRequest(demoService(), { asset: "BTC" }).url).toBe(
      "http://127.0.0.1:4402/v1/market?asset=BTC",
    );
  });
});

describe("getService", () => {
  it("knows the demo service without asking anyone", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    expect((await getService(DEMO_SERVICE_ID))?.name).toBe("Superstables demo market data");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds an index service by id, and nothing for an unknown one", async () => {
    stubIndex(INDEX_FIXTURE);
    expect((await getService("example-weather"))?.source).toBe("superstables-index");
    expect(await getService("no-such-service")).toBeUndefined();
  });
});

describe("probing the demo service", () => {
  it("counts a 402 as alive, because that is how a paid endpoint answers", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end("{}");
    });
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = `${server.url}/v1/market`;
    try {
      const { services } = await findServices({ includeIndex: false, probe: true });
      expect(services[0].live).toBe(true);
      expect(services[0].lastSeenLive).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("reports a service that is not there as not live", async () => {
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = "http://127.0.0.1:1/v1/market";
    const { services } = await findServices({ includeIndex: false, probe: true });
    expect(services[0].live).toBe(false);
    expect(services[0].lastSeenLive).toBeUndefined();
  });

  it("says nothing about liveness when it was not asked to look", async () => {
    const { services } = await findServices({ includeIndex: false });
    expect(services[0].live).toBeUndefined();
  });
});

describe("resolveRequest", () => {
  const service = demoService();

  it("builds the URL that will be quoted and paid", () => {
    const request = resolveRequest(service, { asset: "btc" });
    expect(request.serviceId).toBe(DEMO_SERVICE_ID);
    expect(request.method).toBe("GET");
    // The documented spelling is used, so the seller sees what it published.
    expect(request.params).toEqual({ asset: "BTC" });
    expect(new URL(request.url).searchParams.get("asset")).toBe("BTC");
  });

  it("refuses a missing required parameter and says what is allowed", () => {
    expect(() => resolveRequest(service, {})).toThrow(
      "Cannot call Superstables demo market data: asset is required (one of BTC, ETH).",
    );
  });

  it("refuses a value outside the documented set", () => {
    expect(() => resolveRequest(service, { asset: "DOGE" })).toThrow(/asset="DOGE" is not one of BTC, ETH/);
  });

  it("passes through parameters a listing does not document", () => {
    const listing = { ...service, params: [] };
    const request = resolveRequest(listing, { city: "Lisbon" });
    expect(new URL(request.url).searchParams.get("city")).toBe("Lisbon");
  });
});

describe("the third-party listing", () => {
  it("is in the catalogue after the demo service, actionable, on the testnet", async () => {
    expect(catalogue().map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    const { services } = await findServices({ query: "bitcoin price", includeIndex: false });
    expect(services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    const external = services[1];
    expect(external.actionable).toBe(true);
    expect(external.testnet).toBe(true);
    expect(external.operator).toMatch(/not operated by Superstables/);
    expect((await getService(EXTERNAL_COIN_PRICE_ID, { includeIndex: false }))?.id).toBe(EXTERNAL_COIN_PRICE_ID);
  });

  it("builds the request from its symbol parameter", () => {
    const request = resolveRequest(catalogue()[1], { symbol: "BTC" });
    expect(request.url).toBe("https://x402-coin-api.vercel.app/api/price?symbol=BTC");
    expect(() => resolveRequest(catalogue()[1], {})).toThrow(/symbol/);
  });
});
