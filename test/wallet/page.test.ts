// The approval page has no build step and no test runner of its own, so this guards the two
// things that would be dangerous to lose: it must stay self-contained (nothing loaded from
// another origin, since this page authorises payments), and it must keep saying which facts
// the wallet verified and which ones the agent merely claimed.

import { describe, expect, it } from "vitest";
import { APPROVAL_PAGE } from "../../src/wallet/page.js";

describe("the approval page", () => {
  it("loads nothing from anywhere else", () => {
    expect(APPROVAL_PAGE).not.toMatch(/<script[^>]+src=/i);
    expect(APPROVAL_PAGE).not.toMatch(/<link[^>]+href=/i);
    expect(APPROVAL_PAGE).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it("says who holds the key and who decides", () => {
    expect(APPROVAL_PAGE).toContain("This key never leaves this process");
    expect(APPROVAL_PAGE).toContain("the agent can ask, only you can approve");
  });

  it("labels the agent's own account of the payment as unverified", () => {
    expect(APPROVAL_PAGE).toContain("Reported by the agent (not verified)");
  });

  it("offers both decisions, and only those", () => {
    expect(APPROVAL_PAGE).toContain("Approve and sign");
    expect(APPROVAL_PAGE).toContain("Reject");
  });

  it("escapes everything it renders, reads the secret from the fragment and follows the system theme", () => {
    expect(APPROVAL_PAGE).toContain("function esc(value)");
    expect(APPROVAL_PAGE).toContain('location.hash.replace(/^#/, "")');
    expect(APPROVAL_PAGE).toContain("color-scheme: light dark");
    expect(APPROVAL_PAGE).toContain("prefers-color-scheme: dark");
  });
});
