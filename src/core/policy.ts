// The spend policy: a YAML file the owner writes, evaluated in a fixed order so the reason
// a caller sees is always the first rule that refused. The same engine runs in two places:
// in the agent-side client (an early, advisory refusal, before the wallet is bothered) and
// inside the wallet (the owner's copy, the one that counts). Everything here is software
// policy; nothing here is enforced by the chain, and the docs say so.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface Money {
  amount: number;
  asset: string;
}

export interface Policy {
  /** The most any single payment may be. */
  perCall?: Money;
  /** The most all payments may add up to in one UTC day, per asset, from the local records. */
  perDay?: Money;
  /** Hostname patterns; empty = any. "*.example.com" matches the domain and its subdomains. */
  allow: string[];
  deny: string[];
  stablecoins: string[];
  /** Refuse everything, before any other rule. */
  killSwitch: boolean;
  /** The only mode in this release: the owner approves every payment in the wallet. */
  approval: "ask-every-payment";
}

export const DEFAULT_POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: [],
  stablecoins: ["USDC"],
  killSwitch: false,
  approval: "ask-every-payment",
};

export const POLICY_EXAMPLE = `# Superstables spend policy (software policy: enforced by this client and by the wallet,
# not by the chain). Evaluation order, first refusal wins:
#   kill_switch → deny → allow → stablecoins → per_call → per_day
caps:
  per_call: 0.05 USDC   # the most one payment may be
  per_day: 1 USDC       # the most all payments may add up to in one UTC day
allow: []               # hostname patterns; empty = any host
deny: []                # e.g. ["*.example.net"]
stablecoins: [USDC]     # the only asset this release pays in
approval: ask-every-payment   # the wallet asks the owner before every payment
# kill_switch: true     # refuse everything
`;

export function parseMoney(value: string | number): Money {
  const [amount, asset] = String(value).trim().split(/\s+/);
  const n = Number(amount.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new Error(`not an amount: "${value}"`);
  return { amount: n, asset: (asset ?? "USDC").toUpperCase() };
}

export function formatMoney(m?: Money): string | undefined {
  return m ? `${m.amount} ${m.asset}` : undefined;
}

export function parsePolicy(yamlText: string): Policy {
  const raw = (parseYaml(yamlText) ?? {}) as Record<string, any>;
  const money = (v: unknown) => (v === undefined || v === null ? undefined : parseMoney(v as string));
  const approval = raw.approval ?? "ask-every-payment";
  if (approval !== "ask-every-payment") {
    throw new Error(`approval: "${approval}" is not supported in this release (only ask-every-payment)`);
  }
  return {
    perCall: money(raw.caps?.per_call),
    perDay: money(raw.caps?.per_day),
    allow: Array.isArray(raw.allow) ? raw.allow.map(String) : [],
    deny: Array.isArray(raw.deny) ? raw.deny.map(String) : [],
    stablecoins: Array.isArray(raw.stablecoins) ? raw.stablecoins.map((s: unknown) => String(s).toUpperCase()) : ["USDC"],
    killSwitch: raw.kill_switch === true,
    approval: "ask-every-payment",
  };
}

/** Reads a policy file; a missing file means the default policy. */
export function loadPolicy(path: string): Policy {
  try {
    return parsePolicy(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw err;
  }
}

export interface Attempt {
  /** The counterparty's hostname (the URL asked for, never the seller's self-declared resource). */
  domain: string;
  amountDecimal: number;
  asset: string;
  /** Already spent today in this asset, from the local records. Omit when unknown. */
  spentTodayDecimal?: number;
}

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

function domainMatches(pattern: string, domain: string): boolean {
  const p = pattern.toLowerCase();
  const d = domain.toLowerCase();
  if (p.startsWith("*.")) return d === p.slice(2) || d.endsWith(p.slice(1));
  return d === p;
}

export function evaluatePolicy(policy: Policy, a: Attempt): Verdict {
  if (policy.killSwitch) return { allowed: false, reason: "kill_switch is on" };
  if (a.domain) {
    if (policy.deny.some((p) => domainMatches(p, a.domain))) return { allowed: false, reason: `host ${a.domain} is on the deny list` };
    if (policy.allow.length > 0 && !policy.allow.some((p) => domainMatches(p, a.domain))) {
      return { allowed: false, reason: `host ${a.domain} is not on the allow list` };
    }
  }
  if (!policy.stablecoins.includes(a.asset.toUpperCase())) {
    return { allowed: false, reason: `${a.asset} is not in the policy's stablecoin list [${policy.stablecoins.join(", ")}]` };
  }
  if (policy.perCall && a.amountDecimal > policy.perCall.amount) {
    return { allowed: false, reason: `${a.amountDecimal} ${a.asset} exceeds caps.per_call (${formatMoney(policy.perCall)})` };
  }
  if (policy.perDay && a.spentTodayDecimal !== undefined && a.spentTodayDecimal + a.amountDecimal > policy.perDay.amount) {
    return {
      allowed: false,
      reason: `today's payments (${round6(a.spentTodayDecimal)} ${a.asset}) plus ${a.amountDecimal} exceed caps.per_day (${formatMoney(policy.perDay)})`,
    };
  }
  return { allowed: true };
}

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
