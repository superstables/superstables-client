# Installing

Node 20 or newer, and MetaMask in your browser. Everything runs on your machine except the paid
service, the public facilitators, the Base Sepolia RPC and the Superstables index.

Using Claude Desktop and nothing else? Skip the checkout: every release ships an installable
bundle, and Node is not needed. Go straight to [Claude Desktop](#claude-desktop), then come back
for the MetaMask steps.

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
npm install
npm run build
npx superstables setup
```

`npx superstables …` works from the repository root because npm resolves this package's own
`bin`. To get the command on your PATH everywhere, run `npm link` once, then use
`superstables …`.

`setup` is idempotent. It creates `~/.superstables`, writes `policy.yaml` from the example if
there is none, and prints the MetaMask steps and the exact command for your agent. It creates no
key: in the default mode there is no key on this machine.

## There is no process to start

The client signs with MetaMask. The agent starts the MCP server, that server binds
`127.0.0.1:4412` the first time a payment needs approval, and it hands the agent a link of the
form `http://127.0.0.1:4412/approve/<id>`. You open the link, connect MetaMask, and sign. The
port is released when the server stops.

So the only preparation is in the browser:

1. Install MetaMask: <https://metamask.io/download>.
2. Add the Base Sepolia network. The approval page offers to add or switch to it the first time
   you connect, so you can also skip this and say yes when asked.
3. Fund your MetaMask account with test USDC on Base Sepolia at <https://faucet.circle.com>.
   Copy the address out of MetaMask; that is the account that pays. You do not need ETH:
   facilitators submit the transfer and pay the gas.

Check the machine with `npx superstables doctor`. In this mode it checks that the home
directory and policy are in place, which account last connected, and that the approval port is
free:

```
  client version           0.1.0
  home                     ~/.superstables

✓ home directory           ~/.superstables (writable)
✓ spend policy             ~/.superstables/policy.yaml: up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:4412 is free; the agent serves the page itself
```

Not having connected an account yet is fine and is not a failure.

## Claude Code

From the repository root:

```bash
claude mcp add superstables -- node "$(pwd)/dist/mcp/main.js"
```

`superstables setup` prints this line with the absolute path already filled in. Then, in Claude
Code, run `/mcp`: `superstables` should be listed as connected, with six tools. If it is not,
`claude mcp list` shows the configured command, and the server logs to stderr — start it by hand
with `node dist/mcp/main.js` to see what it says.

To keep the server's state somewhere else, or to use the local wallet, pass the environment
through:

```bash
claude mcp add superstables --env SUPERSTABLES_HOME=/path/to/home -- node "$(pwd)/dist/mcp/main.js"
```

## Claude Desktop

Download `superstables-<version>.mcpb` from the
[latest release](https://github.com/superstables/superstables-client/releases/latest). It is
the compiled server with its runtime dependencies: nothing to clone, nothing to build, and
Claude Desktop runs it with its own Node runtime.

From a checkout, `npm run bundle` produces the same file. It compiles, stages the server with its
runtime dependencies, validates the manifest and writes `build/superstables-<version>.mcpb`,
printing the path and size.

In Claude Desktop: **Settings → Extensions → Advanced → Install Extension…**, choose the file,
and install it. The bundle keeps its state in `~/.superstables`; the only setting it exposes is
the local wallet's URL, which matters only in `--wallet local` mode.

The bundle contains the MCP server and nothing else, which in this mode is everything: the
approval page is served by that same process.

Both Claude Code and Claude Desktop have been tested end to end with the MetaMask flow: find,
quote, approve, pay, receipt, and a rejected payment that signs nothing.

### Updating the extension

Claude Desktop may keep the copy of an extension it already has when the new one carries the
same version number. The old build then runs, looks installed, and behaves like the old build.
Install a new `.mcpb` like this, and the question does not arise:

1. Quit Claude Desktop completely — **Cmd+Q** on a Mac. Closing the window is not enough; the
   old server keeps running.
2. Reopen it, go to **Settings → Extensions**, and uninstall the Superstables extension that is
   there.
3. Install the new `.mcpb`: **Advanced → Install Extension…**.
4. Check that the version Claude Desktop shows for the extension is the version in the filename
   of the bundle you just installed.
5. Open a **new** chat and ask for the wallet status. The answer carries `client_version` and
   `home`: the first must be the version you installed, the second the directory you expect
   (`~/.superstables` unless you changed it). An older version there means an older build is
   still running — go back to step 1.

While developing, build with:

```bash
npm run bundle -- --dev
```

Every build then gets a version of its own, derived from the commit:
`build/superstables-0.1.0-dev.14+gabc1234.mcpb`. The host cannot mistake it for the copy it
already has, and `client_version` names the exact commit the running server was built from.
Without `--dev` the bundle carries the released version, unchanged. Neither form writes to the
repository's own `package.json` or `mcpb/manifest.json`; only the staged copies inside the
bundle are stamped.

Two other places answer the same question: `superstables --version` and `superstables doctor`,
which prints the client version and the home directory above its checks. The MCP server also
writes one line to stderr when it starts —
`superstables client 0.1.0 · home /Users/you/.superstables · wallet browser` — which is what
Claude Desktop shows in the extension's logs.

Releases are tagged `v<version>` on GitHub, with the release notes taken from
[../CHANGELOG.md](../CHANGELOG.md) and the `.mcpb` bundle attached, so a tagged release can be
installed without building it.

## Any other MCP client

The server speaks MCP over stdio. Run it as:

```bash
node dist/mcp/main.js      # or: npx superstables mcp
```

It logs to stderr only, because stdout is the protocol. Its first line says which build is
running, where its state lives and which signer it is using:

```
superstables client 0.1.0 · home /Users/you/.superstables · wallet browser
```

## The paid service

The demo buys from a small x402 service Superstables hosts at
`https://www.superstables.com/api/demo/market` (`HOSTED_DEMO_SERVICE_URL` in
`src/core/discovery.ts`), so there is something to buy without anyone running a seller. Nothing
has to be started for the quick start to work.

The seller is in this repository too, and `superstables demo-service` runs it, which is worth
doing to watch the seller's side of a payment. `SUPERSTABLES_DEMO_SERVICE_URL` then points the
client at that instance, or at any other one:

```bash
npx superstables demo-service --pay-to 0xYourSellerAddress
SUPERSTABLES_DEMO_SERVICE_URL="http://127.0.0.1:4402/v1/market" npx superstables find
```

A real x402 seller on `127.0.0.1:4402`. It answers `GET /v1/market?asset=BTC` with HTTP 402 and
its terms, verifies and settles the credential you send through a public facilitator, and only
then returns the data. 0.01 USDC per request by default.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen somewhere other than 4402. Set `SUPERSTABLES_DEMO_SERVICE_URL` to match |
| `--pay-to <0x…>` | Where the money goes. Defaults to `SUPERSTABLES_DEMO_PAY_TO` |
| `--price <decimal>` | USDC per request. Default 0.01 |

Point `--pay-to` at an address you control. With no `--pay-to` and no environment variable it
generates a throwaway address, prints it and warns you: anything paid there is unrecoverable.

## The local wallet, for a machine with no browser

The second signer keeps a key in a file and serves its own approval page, protected by a secret
carried in the URL fragment. It is the fallback, not the default.

```bash
npx superstables --wallet local setup          # creates ~/.superstables/wallet/key, prints the address
npx superstables --wallet local wallet serve   # leave it running
```

It binds `127.0.0.1:4411`, prints an approval URL of the form
`http://127.0.0.1:4411/#<owner-secret>`, and opens it in your browser. The secret is in the URL
fragment, so it never reaches the server; keep that link to yourself.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen somewhere other than 4411. Set `SUPERSTABLES_WALLET_URL` to match |
| `--approval-timeout <seconds>` | How long a request waits for you. Default 120 |
| `--no-open` | Do not open a browser; print the link only |

Every other command needs `--wallet local` too, or `SUPERSTABLES_WALLET=local` in the
environment — including the one that starts the MCP server, which is how an agent gets it.
Fund the address it prints from the same faucet. Stopping the wallet is the off switch: with no
wallet, `pay` fails with "the wallet is not running", and nothing can be signed.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `SUPERSTABLES_HOME` | `~/.superstables` | Where the policy, the records and the remembered account live |
| `SUPERSTABLES_WALLET` | `browser` | Who signs: `browser` (MetaMask) or `local` (the wallet process) |
| `SUPERSTABLES_APPROVE_PORT` | `4412` | Where the approval page is served, browser mode. `0` picks a free port |
| `SUPERSTABLES_POLICY` | `$SUPERSTABLES_HOME/policy.yaml` | Read the policy from somewhere else |
| `SUPERSTABLES_WALLET_URL` | `http://127.0.0.1:4411` | Where the client looks for the local wallet |
| `SUPERSTABLES_WALLET_AGENT_TOKEN` | read from `wallet/agent-token` | The agent's bearer token for the local wallet, when it is not on this filesystem |
| `SUPERSTABLES_DEMO_SERVICE_URL` | `https://www.superstables.com/api/demo/market` | Where the built-in catalogue says the paid service is |
| `SUPERSTABLES_DEMO_PAY_TO` | none | Default recipient for `demo-service` |
| `SUPERSTABLES_DEMO_HOST` | `127.0.0.1` | Which interface `demo-service` binds |
| `SUPERSTABLES_MCP_WAIT_MS` | `20000` | How long the MCP tools wait for a payment before answering "still waiting" |
| `SUPERSTABLES_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC, used to read the USDC balance |
| `SUPERSTABLES_INDEX_URL` | `https://www.superstables.com/api/v1/services` | The public service index |
| `SUPERSTABLES_DOCTOR_OFFLINE` | unset | `1` makes `doctor` skip every check that needs a network |

`SUPERSTABLES_HOME` is read when state is first touched, so set it before starting a process
rather than during one. The CLI's `--home <dir>` sets it for you, and `--wallet <mode>` sets
`SUPERSTABLES_WALLET` the same way.

## Ports

| Port | What binds it | When | Bound to |
| --- | --- | --- | --- |
| 4412 | the approval page, inside the agent's own process | browser mode, from the first payment | `127.0.0.1` |
| 4411 | the local wallet | `--wallet local` only | `127.0.0.1` |
| 4402 | the demo service | only if you run the seller yourself; the hosted one needs no port | `127.0.0.1` |

None of them is reachable from another machine. If a port is busy, move it with the matching
variable or `--port`.

## Uninstalling

Remove the MCP server (`claude mcp remove superstables`, or uninstall the extension in Claude
Desktop) and delete `~/.superstables`. In the default mode that directory holds no key — your
funds are in MetaMask and are not affected. With `--wallet local` it holds
`wallet/key`, so deleting it makes any funds that key holds unreachable; they are testnet
funds, but check before you delete.
