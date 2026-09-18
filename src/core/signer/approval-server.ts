// The approval server: a node:http server on 127.0.0.1 that the agent's own process runs, so
// the owner has nothing to start. It serves one page per pending payment, hands the browser
// wallet the exact typed data to sign, checks the signature that comes back, and gives the
// payment core a SignResult — or a refusal.
//
// Four properties shape every line below.
//
//  1. The server derives everything it shows and everything it asks to be signed from the
//     seller's requirement. The agent's own account of the payment is stored apart, as
//     `reported`, and the page labels it unverified. An agent that lies can only lie about
//     the label.
//  2. The approval id is the capability. It is 128 bits of randomness that exists in exactly
//     two places — the agent's tool result and this process — so the page needs no login, and
//     a page opened under one id can only ever sign that one payment.
//  3. A signature is checked before it is believed: the recovered signer must be the account
//     the typed data was built for. A signature from any other key is rejected and the request
//     stays pending, so the person can simply try again with the right account.
//  4. Nothing waits for ever. Requests expire on their own, an expiry is a refusal with a
//     reason, and every state change is appended to an audit log that never holds a signature.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { getAddress, toHex, verifyTypedData } from "viem";
import { DEFAULT_NETWORK, isAddress, networkFor } from "../chain.js";
import { DEFAULT_APPROVE_PORT, approvalsPath, ensureDir, recordsDir } from "../home.js";
import type { PaymentContext, VerifiedTerms } from "../types.js";
import { approvalNotFoundPage, approvalPage, type ApprovalPageFacts } from "./approval-page.js";
import type { SignResult } from "./types.js";

/** An approval is small; anything larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024;
/** How often expiry is swept. The page also polls, so a second's granularity is plenty. */
const SWEEP_MS = 1_000;

export type ApprovalStatus = "pending" | "signed" | "denied" | "expired";

/** The EIP-712 payload, in the JSON-safe shape a browser wallet's signTypedData_v4 expects. */
export interface ApprovalTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "TransferWithAuthorization";
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

export interface ApprovalRequestInput {
  /** Derived from the requirement by the caller, with termsFor(). Never agent-supplied. */
  verified: VerifiedTerms;
  /** What the agent says this is for. Shown as unverified; used for nothing else. */
  reported?: PaymentContext;
  /** The seller's requirement verbatim: what the typed data is built from. */
  requirement: PaymentRequirements;
  x402Version: 1 | 2;
  /** How long the person has to decide. */
  timeoutMs: number;
}

/** How an approval ended. `signed` carries the credential; everything else carries a reason. */
export type ApprovalOutcome =
  | { status: "signed"; result: SignResult }
  | { status: "denied" | "expired"; reason: string };

export interface ApprovalHandle {
  id: string;
  /** The link the owner opens. The agent shows this to the person verbatim. */
  url: string;
  /** Resolves once the person has signed, rejected, or run out of time. */
  settled: Promise<ApprovalOutcome>;
}

interface ApprovalRecord extends ApprovalRequestInput {
  id: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  reason?: string;
  /** The account the typed data was built for, once the page has reported one. */
  account?: string;
  typedData?: ApprovalTypedData;
  finish: (outcome: ApprovalOutcome) => void;
}

export interface ApprovalServerOptions {
  /** 0 picks a free port (tests). Defaults to DEFAULT_APPROVE_PORT. */
  port?: number;
  /** Where the audit log lives. Defaults to the records directory under SUPERSTABLES_HOME. */
  recordsDirPath?: string;
  /** Remember the connected account here, so `status` can name a payer later. */
  onAccount?: (address: string) => void;
}

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/**
 * Builds exactly the authorization the x402 exact scheme signs, for the account the page
 * reported. The values match what the SDK's own client produces field for field, because the
 * facilitator that settles this credential checks all of them: a v1 requirement backdates
 * validAfter by ten minutes and carries its amount as maxAmountRequired, a v2 one does not.
 */
function buildTypedData(record: ApprovalRecord, payer: string): ApprovalTypedData {
  const requirement = record.requirement as PaymentRequirements & { maxAmountRequired?: string };
  const network = networkFor(String(requirement.network ?? "")) ?? DEFAULT_NETWORK;
  const extra = (requirement.extra ?? {}) as { name?: string; version?: string };
  const now = Math.floor(Date.now() / 1000);
  const timeout = Number(requirement.maxTimeoutSeconds ?? 300);
  return {
    domain: {
      name: extra.name ?? network.usdc.eip712.name,
      version: extra.version ?? network.usdc.eip712.version,
      chainId: network.chainId,
      verifyingContract: getAddress(String(requirement.asset)),
    },
    // Copied rather than referenced: this object is serialised to the page as JSON, and the
    // SDK's own table is frozen and read-only.
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(payer),
      to: getAddress(String(requirement.payTo)),
      value: String(requirement.amount ?? requirement.maxAmountRequired ?? "0"),
      validAfter: record.x402Version === 1 ? String(now - 600) : "0",
      validBefore: String(now + timeout),
      nonce: toHex(randomBytes(32)),
    },
  };
}

export class ApprovalServer {
  private readonly options: ApprovalServerOptions;
  private readonly records = new Map<string, ApprovalRecord>();
  private server?: Server;
  private starting?: Promise<void>;
  private sweeper?: NodeJS.Timeout;
  private boundPort = 0;

  constructor(options: ApprovalServerOptions = {}) {
    this.options = options;
  }

  /** Where the pages live. Only meaningful once start() has resolved. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  get port(): number {
    return this.boundPort;
  }

  get pending(): number {
    this.sweep();
    return [...this.records.values()].filter((record) => record.status === "pending").length;
  }

  /** Binds once. Safe to call twice: the second caller waits for the first one's listen(). */
  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: Error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        this.sendJson(res, 500, { error: `the approval page could not handle that: ${err.message}` });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // 127.0.0.1 only: an approval page is never reachable from another machine.
      server.listen(this.options.port ?? DEFAULT_APPROVE_PORT, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    // The agent's own process must never be held open by this timer.
    this.sweeper.unref();
  }

  /** Register one payment for approval and hand back the link and the promise to wait on. */
  request(input: ApprovalRequestInput): ApprovalHandle {
    const id = randomBytes(16).toString("hex");
    const now = Date.now();
    let finish!: (outcome: ApprovalOutcome) => void;
    const settled = new Promise<ApprovalOutcome>((resolve) => {
      let answered = false;
      finish = (outcome) => {
        if (answered) return;
        answered = true;
        resolve(outcome);
      };
    });
    const record: ApprovalRecord = {
      ...input,
      id,
      status: "pending",
      createdAt: now,
      expiresAt: now + input.timeoutMs,
      finish,
    };
    this.records.set(id, record);
    this.audit(record);
    return { id, url: `${this.url}/approve/${id}`, settled };
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      record.status = "denied";
      record.reason = "the agent stopped before this payment was approved";
      record.finish({ status: "denied", reason: record.reason });
    }
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────

  /** Expiry is this process's decision, not the page's: nothing stays signable for ever. */
  private sweep(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status !== "pending" || record.expiresAt > now) continue;
      record.status = "expired";
      record.reason = `nobody approved this payment within ${Math.round(record.timeoutMs / 1000)} s`;
      this.audit(record);
      record.finish({ status: "expired", reason: record.reason });
    }
  }

  /** One line per state change. Never a signature, never a key: this file is for reading. */
  private audit(record: ApprovalRecord): void {
    const dir = this.options.recordsDirPath ?? recordsDir();
    const line = {
      at: new Date().toISOString(),
      id: record.id,
      status: record.status,
      reason: record.reason,
      verified: record.verified,
      reported: record.reported,
      address: record.account,
    };
    try {
      ensureDir(dir);
      appendFileSync(approvalsPath(dir), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // An unwritable audit file must never stop a person from deciding about their own money.
    }
  }

  private facts(record: ApprovalRecord): ApprovalPageFacts {
    const network = networkFor(record.verified.network) ?? DEFAULT_NETWORK;
    return {
      id: record.id,
      amountDecimal: record.verified.amountDecimal,
      asset: record.verified.asset,
      amountAtomic: record.verified.amountAtomic,
      recipient: record.verified.recipient,
      network: record.verified.network,
      networkLabel: record.verified.networkLabel,
      assetAddress: record.verified.assetAddress,
      expiresAt: record.expiresAt,
      chainIdHex: `0x${network.chainId.toString(16)}`,
      chainName: network.label.replace(/\s*\(testnet\)\s*/i, "").trim(),
      rpcUrl: network.rpc,
      explorer: network.explorer,
      reported: record.reported,
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("the request body is too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    this.sweep();

    const match = /^\/approve\/([^/]+)(\/state|\/account|\/signature|\/reject)?$/.exec(path);
    if (!match) {
      this.sendJson(res, 404, { error: "no such route" });
      return;
    }
    const record = this.records.get(decodeURIComponent(match[1]));
    const leaf = match[2];

    if (!record) {
      // An id nobody holds is the same to this server as an id that never existed.
      if (!leaf && method === "GET") {
        this.sendHtml(res, 404, approvalNotFoundPage());
        return;
      }
      this.sendJson(res, 404, { error: "there is no payment waiting under this link" });
      return;
    }

    if (!leaf && method === "GET") {
      this.sendHtml(res, 200, approvalPage(this.facts(record)));
      return;
    }
    if (leaf === "/state" && method === "GET") {
      this.sendJson(res, 200, {
        id: record.id,
        status: record.status,
        verified: record.verified,
        reported: record.reported,
        reason: record.reason,
        expiresAt: record.expiresAt,
        address: record.account,
      });
      return;
    }
    if (method !== "POST") {
      this.sendJson(res, 405, { error: "that route takes a POST" });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await this.readBody(req)) || "{}") as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "the request body is not JSON" });
      return;
    }

    if (leaf === "/reject") {
      if (record.status !== "pending") {
        this.sendJson(res, 409, { error: `this payment is already ${record.status}`, status: record.status });
        return;
      }
      record.status = "denied";
      record.reason = "rejected by the owner on the approval page";
      this.audit(record);
      record.finish({ status: "denied", reason: record.reason });
      this.sendJson(res, 200, { status: record.status, reason: record.reason });
      return;
    }

    if (record.status !== "pending") {
      this.sendJson(res, 409, { error: `this payment is already ${record.status}`, status: record.status });
      return;
    }

    if (leaf === "/account") {
      const address = typeof body.address === "string" ? body.address : "";
      if (!isAddress(address)) {
        this.sendJson(res, 400, { error: "that is not an account address" });
        return;
      }
      // A person may switch accounts before signing, so this rebuilds rather than refusing.
      record.account = getAddress(address);
      record.typedData = buildTypedData(record, record.account);
      record.verified = { ...record.verified, payer: record.account };
      this.sendJson(res, 200, {
        typedData: record.typedData,
        summary: `${record.verified.amountDecimal} ${record.verified.asset} to ${record.verified.recipient} on ${record.verified.networkLabel}`,
      });
      return;
    }

    if (leaf === "/signature") {
      const address = typeof body.address === "string" ? body.address : "";
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!record.typedData || !record.account) {
        this.sendJson(res, 409, { error: "connect an account first: there is nothing prepared to sign" });
        return;
      }
      if (!isAddress(address) || getAddress(address) !== record.account) {
        this.sendJson(res, 400, {
          error: `this payment was prepared for ${record.account}; connect that account again, or reconnect to prepare a new one`,
        });
        return;
      }
      if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
        this.sendJson(res, 400, { error: "that is not a signature" });
        return;
      }
      let valid = false;
      try {
        // viem's typed-data types are built from literal type tables; ours is the JSON shape
        // the page signs, so the argument is checked here by construction rather than by TS.
        valid = await verifyTypedData({
          address: record.account as `0x${string}`,
          signature: signature as `0x${string}`,
          ...record.typedData,
        } as unknown as Parameters<typeof verifyTypedData>[0]);
      } catch {
        valid = false;
      }
      if (!valid) {
        // The request stays pending on purpose: a wrong account is a mistake, not a decision.
        this.sendJson(res, 400, {
          error: `that signature was not made by ${record.account}; nothing was accepted, and you can sign again`,
        });
        return;
      }
      const result: SignResult = {
        kind: "eip3009",
        payload: { signature, authorization: { ...record.typedData.message } },
        signer: record.account,
      };
      record.status = "signed";
      record.reason = undefined;
      this.audit(record);
      this.options.onAccount?.(record.account);
      record.finish({ status: "signed", result });
      this.sendJson(res, 200, { status: "signed" });
      return;
    }

    this.sendJson(res, 404, { error: "no such route" });
  }
}