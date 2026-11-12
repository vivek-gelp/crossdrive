import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminView, SignedOutView, type AdminViewProps } from "../../app/connect/view";
import type { AccountStatus } from "./status";

function account(label: string, email: string): AccountStatus {
  return {
    label,
    email,
    provider: "google",
    mode: "write",
    mail: "draft",
    scopes: ["drive", "gmail"],
    connectedAt: "2026-11-12T10:00:00.000Z",
    ageDays: 0,
    token: { ok: true, checkedAt: "2026-11-12T10:00:00.000Z" },
    gmail: true,
    storage: "memory",
  };
}

const base: AdminViewProps = {
  email: "me@gmail.com",
  csrf: "t",
  accounts: [],
  warnings: [],
  google: true,
  microsoft: false,
  dropbox: false,
  mcpUrl: "https://x.example/api/mcp",
  connected: null,
  notice: null,
  error: null,
  prefill: {},
};

const render = (p: Partial<AdminViewProps>) => renderToStaticMarkup(createElement(AdminView, { ...base, ...p }));
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("/connect view", () => {
  it("signed out: explains the two steps", () => {
    const html = renderToStaticMarkup(createElement(SignedOutView, { error: null, googleProblem: null }));
    expect(text(html)).toContain("Sign in to manage this instance.");
    expect(text(html)).toContain("Then connect each cloud account under a label.");
  });

  it("nothing connected: says so, pre-fills the admin's account, one primary button", () => {
    const html = render({});
    const t = text(html);
    expect(t).toContain("is not connected yet");
    expect(t).toContain("No accounts are connected yet");
    expect(html.match(/btn-primary/g)).toHaveLength(1);
    expect(html).toContain('value="personal"');
    expect(html).toContain('value="me@gmail.com"');
    expect(html).not.toContain("Disconnect everything");
  });

  it("add form comes before the account list; kill switch last", () => {
    const html = render({ accounts: [account("work", "w@example.com")] });
    const add = html.indexOf('id="add"');
    const list = html.indexOf("Connected accounts");
    const kill = html.indexOf("Disconnect everything");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(list);
    expect(list).toBeLessThan(kill);
    // admin not connected while others are: a one-click connect with a de-duplicated label suggestion
    expect(text(html)).toContain("Connect me@gmail.com as");
    expect(html).toContain('name="email" value="me@gmail.com"');
    // suggestions skip labels in use
    expect(html).not.toMatch(/class="chip"[^>]*>work</);
  });

  it("no notice once the admin's own account is connected", () => {
    const html = render({ accounts: [account("personal", "Me@Gmail.com")] });
    expect(text(html)).not.toContain("is not connected yet");
  });

  it("success and error banners, escaped", () => {
    const ok = render({ accounts: [account("work", "w@example.com")], connected: "work" });
    expect(text(ok)).toContain("Connected w@example.com as work: read + write, mail drafts only.");
    expect(ok).toContain("https://x.example/api/mcp");
    const bad = render({ error: "<script>x</script> Google consent failed: access_denied" });
    expect(bad).not.toContain("<script>");
    const denied = render({ error: "Google consent failed: access_denied" });
    expect(text(denied)).toContain("cancelled or declined");
  });
});
