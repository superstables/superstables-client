# Superstables client

An agent finds a service that charges per request, asks it what a call costs, and pays for it —
but only after you have looked at the amount, the asset, the network and the recipient and said
yes. The key is in MetaMask, where it already was; the agent can ask for a payment and can never
approve one. This release is a testnet demonstration: it pays in test USDC on Base Sepolia over
[x402](https://x402.org), so no real money moves.

You run nothing. The agent starts the client, the client serves one approval page on your own
machine, and you sign in MetaMask.

## What the demo shows

1. **Find.** The agent lists services it could pay for, and says which ones it can actually call.
2. **Quote.** It reads the service's HTTP 402 challenge and writes down the exact terms. Free,
   and nothing is signed.
3. **Approve.** The agent hands you a link. The page shows *0.01 USDC, to `0x…`, on Base
   Sepolia* — facts it derived from the seller's own payment requirement, not from the agent —
   and MetaMask shows you the same transfer before you sign it.
4. **Pay.** You sign. A public facilitator submits the transfer and pays the gas, the service
   answers, and a receipt is written with the transaction hash.
5. **Refuse.** Ask for a second call and press **Reject** — on the page, or in MetaMask.
   Nothing is signed, nothing is submitted, the service is not called, and the agent says so.

## What this release supports

| | |
| --- | --- |
| Rail | x402, `exact` scheme |
| Network | Base Sepolia testnet (`eip155:84532`) |
| Asset | USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals) |
| Approval | MetaMask signs each payment, on an approval page the client serves on `127.0.0.1`. There is no unattended mode |
| Alternative | A local wallet process that holds a key in a file, for a browser-free machine: `--wallet local` |
| Clients | Claude Code and Claude Desktop, both tested end to end with the MetaMask flow (any MCP client that speaks stdio) |
| Also usable as | a CLI (`superstables`) and a TypeScript SDK |

Anything else — another scheme, another network, another asset, mainnet — is refused before you
are asked.

## Quick start

You need Node 20 or newer, and MetaMask in your browser.

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
npm install
npm run build
npx superstables setup
```

`setup` creates `~/.superstables`, writes a starting `policy.yaml`, and prints the steps below
with the paths already filled in. It creates no key: there is none to create.

**Connect an agent.** Claude Code:

```bash
claude mcp add superstables -- node "$(pwd)/dist/mcp/main.js"
```

Claude Desktop: `npm run bundle`, then Settings → Extensions → Advanced → Install Extension…
and choose `build/superstables-<version>.mcpb`.

**Get MetaMask ready.** Install it from <https://metamask.io/download> if you have not. Add
Base Sepolia — the approval page offers to do it for you the first time you connect — and send
test USDC to your MetaMask address from <https://faucet.circle.com>. No ETH is needed:
facilitators pay the gas.

**Talk to the agent**, in your own words:

> Find a paid service for BTC market data, quote it, tell me the price, and pay it if I say yes.

When you say yes, the agent answers with a link like `http://127.0.0.1:4412/approve/<id>`. Open
it. Press **Connect wallet**, then **Approve in MetaMask**, and check the recipient and the
amount in MetaMask's popup before you sign. The agent reports the transaction and the data it
paid for.

There is nothing else to start: the demo seller is hosted by Superstables at
`https://www.superstables.com/api/demo/market`, so the built-in catalogue already has something
to buy. Running that seller yourself is optional — see
[Run the seller yourself](#run-the-seller-yourself).

Full details, including every environment variable, are in [docs/install.md](docs/install.md).
The presenter's script is in [docs/demo.md](docs/demo.md). What changed in each release is in
[CHANGELOG.md](CHANGELOG.md).

## The CLI

Run as `npx superstables …` from the repository root, or `npm link` once and then `superstables`
anywhere. Two options go before the command: `--home <dir>` puts all state somewhere other than
`~/.superstables`, and `--wallet browser|local` chooses who signs (browser by default;
`SUPERSTABLES_WALLET` does the same).

| Command | What it does |
| --- | --- |
| `setup` | Create the home directory and the policy, and print what to do next |
| `doctor` | Check everything a payment needs and print ✓/✗ per item |
| `find [query]` | List services that can be paid for (`--limit`, `--all`) |
| `quote <url>` / `quote --service <id> --param k=v` | Ask what a call costs. Pays nothing |
| `pay <quote-id>` | Pay a quote, printing the approval link and each state as it happens (`--wait`) |
| `status <attempt-id>` | Where a payment attempt got to |
| `receipts` / `attempts` | What was paid, and what was tried (`--limit`) |
| `policy show` / `policy init` | Read or create `policy.yaml` |
| `mcp` | Run the MCP server on stdio, the same one Claude talks to |
| `demo-service` | Run the paid service yourself (`--port`, `--pay-to`, `--price`) |
| `wallet init` / `wallet serve` / `wallet status` | The local wallet, for `--wallet local` only |

## The MCP tools

| Tool | What it does |
| --- | --- |
| `find_services` | Search for payable services and say which are actionable |
| `quote` | Read a service's terms and record them. Nothing is signed |
| `pay` | Ask you to approve a quote, returning `approval_url`; then pay it and return the service's answer |
| `payment_status` | Wait for an attempt to finish and report where it got to |
| `wallet_status` | Which signer is in use; address, network, balance, policy |
| `list_receipts` | Payments that settled on this machine |

Only `pay` can move money, and it cannot approve itself: it stops at `awaiting_approval` and
hands back an `approval_url`. The agent is told to show you that link exactly as written — it is
the only way to reach the payment, and a paraphrased link does not open.

## Where state lives

```
~/.superstables/
  policy.yaml            your spend policy (see policy.example.yaml)
  records/               quotes, attempts, receipts and approvals, append-only JSONL, 0600
  browser-wallet.json    which MetaMask account last connected. A name, not a secret
  wallet/                only with --wallet local: key, agent token, owner secret, audit log
```

`SUPERSTABLES_HOME` moves all of it. Nothing outside this directory is written.

## What is enforced, and by what

**By the chain:** the amount, the asset and the recipient inside the signed authorization, and
the balance of the account. A facilitator cannot change any of them.

**By MetaMask:** that nothing is signed without you, and that what you sign is what you were
shown. The typed data in the popup carries the real `to` and `value`; MetaMask renders them
from the request itself, not from anything this software says about it. The key never exists in
this software — there is no file to steal on this machine, in browser mode.

**By the approval page:** that the payment described to you is the payment that gets signed. The
page's facts — amount, asset, network, recipient — are derived from the seller's requirement by
the same code the payment core uses. What the agent says the payment is *for* is shown
separately, under "Reported by the agent (not verified)", and changes nothing about what is
signed. The signature that comes back is verified to recover the account that connected, before
it is used.

**By software only:** `policy.yaml` — the per-payment cap, the daily cap, the allowed hosts, the
kill switch. These are checks in this code, running on your machine, counted from local files.
They are not on-chain limits, and they are not MetaMask's. They mean this software will not ask
you to sign more than that.

[docs/security.md](docs/security.md) is the long version, including what a compromised agent
can and cannot do.

## Limitations

- Testnet only. One network, one asset, one scheme. No mainnet switch exists.
- **MetaMask's popup shows the value in USDC's smallest unit**: `10000` is 0.01 USDC. The
  approval page says so next to the amount, but the popup is what it is, and reading it takes a
  moment's care.
- The approval link is the capability: anyone who has it can open that one payment. It only
  ever signs that one request, it expires in five minutes, and signing still needs your
  MetaMask. It stays on `127.0.0.1`, so nobody off this machine can open it at all.
- One approval per payment. No budgets, no unattended spending.
- With `--wallet local` the key is a file on this machine, and any process running as you can
  read it. That mode exists for a machine with no browser.
- The public index lists services whose request parameters it does not yet record, so most
  listings can be shown but not called. They say so.
- An interrupted payment can end `uncertain`; it is never retried automatically.
  [docs/records.md](docs/records.md) says what to do.

## Run the seller yourself

You do not have to: the built-in listing points at the demo seller Superstables hosts, and the
catalogue also lists a third-party x402 service that somebody else runs. But the seller is in
this repository, and running it is the way to watch the other side of a payment — the 402, the
facilitator, the one log line per paid call:

```bash
npx superstables demo-service --pay-to 0xYourSellerAddress
SUPERSTABLES_DEMO_SERVICE_URL="http://127.0.0.1:4402/v1/market" npx superstables find
```

Pay it to an address you control; test funds sent to a random address are gone.
`SUPERSTABLES_DEMO_SERVICE_URL` is what points the client — discovery, the CLI and the MCP
server — at an instance other than the hosted one.

## A local wallet instead of MetaMask

There is a second signer for machines with no browser: a small wallet process that holds a key
in `~/.superstables/wallet/key` and serves its own approval page, protected by a secret in the
URL fragment.

```bash
npx superstables --wallet local setup        # creates the key, prints the address
npx superstables --wallet local wallet serve # leave it running
```

`SUPERSTABLES_WALLET=local` does the same for the MCP server, which is how you would set it for
Claude. Everything else is identical: the agent asks, a human approves, and the same records are
written. The trade is plain — a key in a file on the machine the agent runs on, instead of a key
in MetaMask.

## Development

```bash
npm run typecheck
npm test          # no network: the tests stand up their own servers on loopback
npm run build
npm run bundle    # build/superstables-<version>.mcpb for Claude Desktop
```

Releases are tagged `v<version>` on GitHub, with the release notes taken from
[CHANGELOG.md](CHANGELOG.md) and the `.mcpb` bundle attached to the tag.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
