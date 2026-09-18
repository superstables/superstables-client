// The owner's approval page: one self-contained HTML string, served at GET / by the wallet
// process. No build step, no framework, no external asset — the page a person uses to
// authorise a payment should be readable in full, in one file, by anyone who wants to check
// what it does before clicking "Approve".
//
// The owner secret never reaches the server as part of a URL: it lives in the location
// fragment (http://127.0.0.1:4411/#<secret>), which browsers do not send, and the page puts
// it in an Authorization header itself.
//
// Two rules the markup follows everywhere: every value that came from outside is escaped
// before it is inserted, and anything the agent said about the payment is shown in its own
// block, labelled as unverified. What the wallet verified and what the agent claimed must
// never look alike.

export const APPROVAL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Superstables wallet</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card: #ffffff;
    --ink: #14171f;
    --muted: #61697a;
    --line: #e3e6ec;
    --accent: #1b6b4a;
    --accent-ink: #ffffff;
    --danger: #a3302a;
    --warn-bg: #fff8e6;
    --warn-line: #e7d9ae;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101319;
      --card: #171b23;
      --ink: #e9ecf2;
      --muted: #9aa3b4;
      --line: #262c38;
      --accent: #2f9e6e;
      --accent-ink: #06130d;
      --danger: #e8776f;
      --warn-bg: #241f12;
      --warn-line: #4a3f23;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  header h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  .note { margin: 20px 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--muted); }
  .note.bad { border-color: var(--danger); color: var(--danger); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 32px 0 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
  .amount { font-size: 34px; font-weight: 640; letter-spacing: -0.02em; }
  .amount span { font-size: 18px; font-weight: 500; color: var(--muted); margin-left: 6px; }
  .tag { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); vertical-align: 2px; margin-left: 6px; }
  .rows { margin: 16px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; }
  .rows dt { color: var(--muted); }
  .rows dd { margin: 0; word-break: break-all; }
  .reported { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 10px; font-size: 13px; }
  .reported strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 560; padding: 10px 18px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button[disabled] { opacity: 0.55; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 560; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  tr:last-child td { border-bottom: 0; }
  .status-signed { color: var(--accent); }
  .status-denied, .status-rejected, .status-expired { color: var(--danger); }
  .empty { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Superstables wallet</h1>
    <p>This key never leaves this process &middot; the agent can ask, only you can approve.</p>
  </header>

  <div id="notice" class="note" hidden></div>

  <h2>Waiting for you</h2>
  <div id="pending"><p class="empty">No payment is waiting for approval.</p></div>

  <h2>History</h2>
  <div id="history"><p class="empty">Nothing yet.</p></div>
</div>

<script>
(function () {
  var secret = location.hash.replace(/^#/, "");
  var notice = document.getElementById("notice");
  var pendingEl = document.getElementById("pending");
  var historyEl = document.getElementById("history");
  var busy = {};

  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function say(message, bad) {
    notice.hidden = false;
    notice.className = bad ? "note bad" : "note";
    notice.textContent = message;
  }

  function clear() { notice.hidden = true; }

  function ask(path, options) {
    var init = options || {};
    init.headers = { "Authorization": "Bearer " + secret };
    init.cache = "no-store";
    return fetch(path, init);
  }

  function seconds(request) {
    return Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
  }

  function networkCell(terms) {
    var label = String(terms.networkLabel || terms.network || "");
    var testnet = /testnet/i.test(label);
    var name = esc(label.replace(/\\s*\\(testnet\\)\\s*/i, "").trim() || label);
    return name + (testnet ? ' <span class="tag">testnet</span>' : "");
  }

  function reportedBlock(reported) {
    if (!reported) return "";
    var rows = [];
    if (reported.serviceName) rows.push("<div>Service: " + esc(reported.serviceName) + "</div>");
    if (reported.target) rows.push('<div class="mono">' + esc(reported.target) + "</div>");
    if (reported.description) rows.push("<div>" + esc(reported.description) + "</div>");
    if (rows.length === 0) rows.push("<div>The agent said nothing about this payment.</div>");
    return '<div class="reported"><strong>Reported by the agent (not verified)</strong>' + rows.join("") + "</div>";
  }

  function card(request) {
    var terms = request.verified || {};
    var disabled = busy[request.id] ? " disabled" : "";
    return '<div class="card">' +
      '<div class="amount">' + esc(terms.amountDecimal) + "<span>" + esc(terms.asset) + "</span></div>" +
      '<dl class="rows">' +
        "<dt>Network</dt><dd>" + networkCell(terms) + "</dd>" +
        "<dt>To</dt><dd class=\\"mono\\">" + esc(terms.recipient) + "</dd>" +
        "<dt>Paying from</dt><dd class=\\"mono\\">" + esc(terms.payer) + "</dd>" +
        "<dt>Expires in</dt><dd>" + seconds(request) + " s</dd>" +
      "</dl>" +
      reportedBlock(request.reported) +
      '<div class="actions">' +
        '<button class="primary" data-act="approve" data-id="' + esc(request.id) + '"' + disabled + ">Approve and sign</button>" +
        '<button data-act="deny" data-id="' + esc(request.id) + '"' + disabled + ">Reject</button>" +
      "</div>" +
    "</div>";
  }

  function historyTable(requests) {
    var rows = requests.map(function (request) {
      var terms = request.verified || {};
      var when = new Date(request.createdAt).toLocaleTimeString();
      return "<tr>" +
        "<td>" + esc(when) + "</td>" +
        '<td class="status-' + esc(request.status) + '">' + esc(request.status) + "</td>" +
        "<td>" + esc(terms.amountDecimal) + " " + esc(terms.asset) + "</td>" +
        '<td class="mono">' + esc(terms.recipient) + "</td>" +
        "<td>" + esc(request.reason || "") + "</td>" +
      "</tr>";
    }).join("");
    return "<table><thead><tr><th>Time</th><th>Status</th><th>Amount</th><th>Recipient</th><th>Reason</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function render(requests) {
    var pending = requests.filter(function (r) { return r.status === "pending"; });
    var rest = requests.filter(function (r) { return r.status !== "pending"; });
    pending.sort(function (a, b) { return a.createdAt - b.createdAt; });
    rest.sort(function (a, b) { return b.createdAt - a.createdAt; });
    pendingEl.innerHTML = pending.length
      ? pending.map(card).join("")
      : '<p class="empty">No payment is waiting for approval.</p>';
    historyEl.innerHTML = rest.length ? historyTable(rest) : '<p class="empty">Nothing yet.</p>';
  }

  function refresh() {
    if (!secret) {
      say("This page needs the owner secret in the address bar. Open the link the wallet printed when it started: it ends with #<secret>.", true);
      return Promise.resolve();
    }
    return ask("/owner/requests").then(function (response) {
      if (response.status === 401 || response.status === 403) {
        say("That owner secret is not right. Open the link the wallet printed when it started.", true);
        return null;
      }
      if (!response.ok) {
        say("The wallet answered with HTTP " + response.status + ".", true);
        return null;
      }
      return response.json();
    }).then(function (body) {
      if (!body) return;
      clear();
      render(body.requests || []);
    }).catch(function () {
      say("The wallet is not answering. Is it still running?", true);
    });
  }

  function decide(id, action) {
    busy[id] = true;
    refresh();
    ask("/owner/requests/" + encodeURIComponent(id) + "/" + action, { method: "POST" })
      .then(function (response) {
        if (!response.ok) say("The wallet refused that (HTTP " + response.status + "). It may have expired.", true);
      })
      .catch(function () { say("The wallet is not answering. Is it still running?", true); })
      .then(function () { delete busy[id]; refresh(); });
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled) return;
    decide(button.getAttribute("data-id"), button.getAttribute("data-act"));
  });

  refresh();
  setInterval(refresh, 1000);
})();
</script>
</body>
</html>
`;
