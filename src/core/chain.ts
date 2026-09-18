// The one place that knows chains. This release supports exactly one network and one asset:
// USDC on Base Sepolia. Everything else is refused before anything is signed.

import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import type { PaymentRequirements } from "@x402/core/types";

export interface NetworkInfo {
  /** CAIP-2. */
  caip2: string;
  /** The x402 v1 vernacular name some sellers still speak. */
  v1Name: string;
  chainId: number;
  label: string;
  testnet: boolean;
  explorer: string;
  rpc: string;
  usdc: { address: `0x${string}`; decimals: number; eip712: { name: string; version: string } };
}

export const BASE_SEPOLIA: NetworkInfo = {
  caip2: "eip155:84532",
  v1Name: "base-sepolia",
  chainId: 84532,
  label: "Base Sepolia (testnet)",
  testnet: true,
  explorer: "https://sepolia.basescan.org",
  rpc: process.env.SUPERSTABLES_RPC_URL ?? "https://sepolia.base.org",
  usdc: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, eip712: { name: "USDC", version: "2" } },
};

/** The networks this client will pay on. One, for now. */
export const SUPPORTED_NETWORKS: readonly NetworkInfo[] = [BASE_SEPOLIA];

export const DEFAULT_NETWORK = BASE_SEPOLIA;

/** Resolves a CAIP-2 id or a v1 vernacular name to a supported network, or undefined. */
export function networkFor(name: string): NetworkInfo | undefined {
  return SUPPORTED_NETWORKS.find((n) => n.caip2 === name || n.v1Name === name);
}

export function toCaip2(name: string): string {
  return networkFor(name)?.caip2 ?? name;
}

export function describeNetwork(name: string): string {
  const known = networkFor(name);
  if (known) return known.label;
  if (name === "eip155:8453" || name === "base") return "Base (mainnet)";
  if (name.startsWith("solana:") || name.startsWith("solana-")) return "Solana";
  return name;
}

export function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export const isAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

export function txUrl(network: string, tx: string): string {
  const known = networkFor(network);
  return known ? `${known.explorer}/tx/${tx}` : tx;
}

export function addressUrl(network: string, address: string): string {
  const known = networkFor(network);
  return known ? `${known.explorer}/address/${address}` : address;
}

export function toAtomic(amountDecimal: number, decimals = 6): string {
  return String(Math.round(amountDecimal * 10 ** decimals));
}

export function fromAtomic(amountAtomic: string, decimals = 6): number {
  return Number(amountAtomic) / 10 ** decimals;
}

const ERC20_BALANCE_OF = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** A wallet's USDC balance on Base Sepolia: a public RPC read, no key, no gas. */
export async function usdcBalance(address: string, network: NetworkInfo = DEFAULT_NETWORK): Promise<number> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(network.rpc) });
  const raw = await client.readContract({
    address: network.usdc.address,
    abi: ERC20_BALANCE_OF,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
  return Number(raw) / 10 ** network.usdc.decimals;
}

/** "This much USDC to this address" as an exact x402 v2 requirement any facilitator can settle. */
export function usdcRequirement(amountDecimal: number, payTo: string, network: NetworkInfo = DEFAULT_NETWORK): PaymentRequirements {
  return {
    scheme: "exact",
    network: network.caip2 as PaymentRequirements["network"],
    asset: network.usdc.address,
    amount: toAtomic(amountDecimal, network.usdc.decimals),
    payTo,
    maxTimeoutSeconds: 300,
    extra: { name: network.usdc.eip712.name, version: network.usdc.eip712.version },
  };
}
