import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import { readMailgunConfig, sendViaMailgun, type FetchLike } from "../../src/mail/mailgun.js";
import { FakeD1 } from "../helpers/fake-d1.js";

function configuredEnv(overrides: Partial<Env> = {}): Env {
  const db = new FakeD1();
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    MAILGUN_API_KEY: "test-secret-key-do-not-leak",
    MAILGUN_DOMAIN: "mg.example.com",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    MAILGUN_REGION: "US",
    SUPPORT_EMAIL: "support@example.com",
    ...overrides,
  };
}

function unconfiguredEnv(): Env {
  // Mirrors the .dev.vars.example placeholder values shipped with the repo.
  return configuredEnv({
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
  });
}

describe("readMailgunConfig", () => {
  it("returns null when API key or domain is missing", () => {
    expect(readMailgunConfig(configuredEnv({ MAILGUN_API_KEY: undefined }))).toBeNull();
    expect(readMailgunConfig(configuredEnv({ MAILGUN_DOMAIN: undefined }))).toBeNull();
  });

  it("returns null when secrets are still the dev placeholder values", () => {
    expect(readMailgunConfig(unconfiguredEnv())).toBeNull();
  });

  it("returns config when both API key and domain are real", () => {
    const cfg = readMailgunConfig(configuredEnv());
    expect(cfg).toMatchObject({
      apiKey: "test-secret-key-do-not-leak",
      domain: "mg.example.com",
      fromEmail: "no-reply@example.com",
      fromName: "University Hub",
      baseUrl: "https://api.mailgun.net",
    });
  });

  it("uses the EU base URL when MAILGUN_REGION=EU", () => {
    const cfg = readMailgunConfig(configuredEnv({ MAILGUN_REGION: "eu" }));
    expect(cfg?.baseUrl).toBe("https://api.eu.mailgun.net");
  });
});

describe("sendViaMailgun", () => {
  it("short-circuits to mailgun_not_configured without calling fetch", async () => {
    const fetchImpl = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>();
    const result = await sendViaMailgun(
      unconfiguredEnv(),
      {
        type: "contact_notification",
        templateName: "university_hub_contact_notification",
        to: "support@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: false, reason: "mailgun_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the correct URL with Basic auth and form-encoded body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "<msg-id@mg.example.com>", message: "Queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await sendViaMailgun(
      configuredEnv(),
      {
        type: "invitation",
        templateName: "university_hub_invitation",
        to: "alice@example.com",
        variables: { recipient_name: "Alice", role: "staff", invitation_url: "https://x/y" },
      },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, messageId: "<msg-id@mg.example.com>" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    // Basic auth = base64("api:<key>")
    expect(headers.Authorization).toBe(`Basic ${btoa("api:test-secret-key-do-not-leak")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(call.init.body as string);
    expect(body.get("from")).toBe("University Hub <no-reply@example.com>");
    expect(body.get("to")).toBe("alice@example.com");
    expect(body.get("template")).toBe("university_hub_invitation");
    const vars = JSON.parse(body.get("h:X-Mailgun-Variables")!);
    expect(vars).toEqual({
      recipient_name: "Alice",
      role: "staff",
      invitation_url: "https://x/y",
    });
  });

  it("returns ok with null messageId when Mailgun returns 2xx without an id", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: "Queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const result = await sendViaMailgun(
      configuredEnv(),
      {
        type: "welcome",
        templateName: "university_hub_welcome",
        to: "bob@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: true, messageId: null });
  });

  it("returns mailgun_http_error with sanitized message on non-2xx", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: "domain not verified" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const result = await sendViaMailgun(
      configuredEnv(),
      {
        type: "password_reset",
        templateName: "university_hub_password_reset",
        to: "charlie@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(result).toEqual({
      ok: false,
      reason: "mailgun_http_error",
      detail: "domain not verified",
    });
  });

  it("falls back to http_<status> when error body has no message", async () => {
    const fetchImpl: FetchLike = async () => new Response("", { status: 502 });
    const result = await sendViaMailgun(
      configuredEnv(),
      {
        type: "welcome",
        templateName: "university_hub_welcome",
        to: "dave@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: false, reason: "mailgun_http_error", detail: "http_502" });
  });

  it("returns mailgun_network_error when fetch throws", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await sendViaMailgun(
      configuredEnv(),
      {
        type: "welcome",
        templateName: "university_hub_welcome",
        to: "erin@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("mailgun_network_error");
      expect(result.detail).toBe("ECONNRESET");
    }
  });

  it("never writes the API key into the result detail", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection failure");
    };
    const env = configuredEnv({ MAILGUN_API_KEY: "super-secret-leak-canary" });
    const result = await sendViaMailgun(
      env,
      {
        type: "welcome",
        templateName: "university_hub_welcome",
        to: "frank@example.com",
        variables: {},
      },
      { fetchImpl },
    );
    expect(JSON.stringify(result)).not.toContain("super-secret-leak-canary");
  });
});
