import { describe, expect, it } from "vitest";
import { isValidLabel } from "./config";
import {
  adminNotConnected,
  availableLabelSuggestions,
  connectedMessage,
  dedupeLabel,
  describeConnectError,
  prefillEmail,
  prefillLabel,
  progressSteps,
  suggestLabelFor,
} from "./connect-ui";

describe("label suggestions", () => {
  it("offers the common labels that are still free, in order", () => {
    expect(availableLabelSuggestions([])).toEqual(["personal", "work", "client"]);
    expect(availableLabelSuggestions(["work", "Personal"])).toEqual(["client"]);
    expect(availableLabelSuggestions(["personal", "work", "client"])).toEqual([]);
  });

  it("de-duplicates with a numeric suffix and stays a valid label", () => {
    expect(dedupeLabel("work", [])).toBe("work");
    expect(dedupeLabel("work", ["work"])).toBe("work-2");
    expect(dedupeLabel("work", ["work", "work-2", "work-3"])).toBe("work-4");
    const long = "a".repeat(24);
    const d = dedupeLabel(long, [long]);
    expect(d).toBe(`${"a".repeat(22)}-2`);
    expect(isValidLabel(d)).toBe(true);
  });

  it("suggests personal for gmail.com, work otherwise, using only the domain", () => {
    expect(suggestLabelFor("alex@gmail.com", [])).toBe("personal");
    expect(suggestLabelFor("Alex@GoogleMail.com", [])).toBe("personal");
    expect(suggestLabelFor("alex@example.com", [])).toBe("work");
    expect(suggestLabelFor("alex@gmail.com", ["personal"])).toBe("personal-2");
    expect(suggestLabelFor("alex@example.com", ["work", "work-2"])).toBe("work-3");
    expect(suggestLabelFor("not-an-email", [])).toBe("work");
  });
});

describe("adminNotConnected", () => {
  const accounts = [{ email: "a@example.com" }, { email: "B@Example.com" }];
  it("is true only when the signed-in e-mail is missing from the accounts", () => {
    expect(adminNotConnected("c@example.com", accounts)).toBe(true);
    expect(adminNotConnected("a@example.com", accounts)).toBe(false);
    expect(adminNotConnected(" b@example.COM ", accounts)).toBe(false);
    expect(adminNotConnected("a@example.com", [])).toBe(true);
  });
  it("is false without a signed-in admin", () => {
    expect(adminNotConnected(null, [])).toBe(false);
    expect(adminNotConnected("", [])).toBe(false);
  });
});

describe("banners", () => {
  it("names e-mail, label and access after a connection", () => {
    expect(connectedMessage("work", { email: "a@example.com", provider: "google", mode: "write", mail: "draft" })).toBe(
      "Connected a@example.com as work: read + write, mail drafts only.",
    );
    expect(connectedMessage("box", { email: "a@example.com", provider: "dropbox", mode: "read", mail: "off" })).toBe(
      "Connected a@example.com as box: read-only, no mail.",
    );
    expect(connectedMessage("gone", undefined)).toBe("Connected gone.");
  });

  it("explains a cancelled consent and passes other errors through", () => {
    expect(describeConnectError("Google consent failed: access_denied")).toMatch(/cancelled or declined/);
    expect(describeConnectError("Google consent failed: invalid_scope")).toMatch(/refused the request \(invalid_scope\)/);
    expect(describeConnectError("Drive scope was not granted")).toBe("Drive scope was not granted");
  });
});

describe("prefill and progress", () => {
  it("accepts only plausible prefill values", () => {
    expect(prefillLabel("work")).toBe("work");
    expect(prefillLabel("Work!")).toBeUndefined();
    expect(prefillLabel(["work"])).toBeUndefined();
    expect(prefillEmail("a@example.com")).toBe("a@example.com");
    expect(prefillEmail("a b@example.com")).toBeUndefined();
  });

  it("marks the steps done and next", () => {
    expect(progressSteps(false, 0).map((s) => s.state)).toEqual(["next", "todo", "todo"]);
    expect(progressSteps(true, 0).map((s) => s.state)).toEqual(["done", "next", "todo"]);
    expect(progressSteps(true, 2).map((s) => s.state)).toEqual(["done", "done", "next"]);
  });
});
