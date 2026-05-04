import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import {
  sendAccountStatusChangedEmail,
  sendContactNotificationEmail,
  sendInvitationEmail,
  sendInvitationResentEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "../../src/mail/index.js";
import type { FetchLike } from "../../src/mail/mailgun.js";
import { FakeD1 } from "../helpers/fake-d1.js";

function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    MAILGUN_API_KEY: "real-key",
    MAILGUN_DOMAIN: "mg.example.com",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    SUPPORT_EMAIL: "support@example.com",
    ...overrides,
  };
}

function unconfiguredEnv(db: FakeD1): Env {
  return makeEnv(db, {
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
  });
}

function lastEmailLogParams(db: FakeD1): readonly unknown[] {
  const rows = db.executions.filter((e) => e.sql.includes("INSERT INTO email_logs"));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1]!.params;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("send* functions", () => {
  it("missing-config short-circuit: writes failed email_log with mailgun_not_configured and never calls fetch", async () => {
    const db = new FakeD1();
    const env = unconfiguredEnv(db);
    const fetchImpl = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>();

    const result = await sendContactNotificationEmail(
      env,
      {
        to: "support@example.com",
        contactMessageId: "msg-123",
        variables: { contact_name: "A", contact_email: "a@b.c", contact_message: "hi" },
      },
      { options: { fetchImpl } },
    );

    expect(result).toEqual({ ok: false, reason: "mailgun_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const params = lastEmailLogParams(db);
    // INSERT order: id, university_id, recipient_email, type, template_name,
    //               status, mailgun_message_id, error,
    //               related_entity_type, related_entity_id
    expect(params[2]).toBe("support@example.com");
    expect(params[3]).toBe("contact_notification");
    expect(params[4]).toBe("university_hub_contact_notification");
    expect(params[5]).toBe("failed");
    expect(params[6]).toBeNull();
    expect(params[7]).toBe("mailgun_not_configured");
    expect(params[8]).toBe("contact_message");
    expect(params[9]).toBe("msg-123");
  });

  it("success path: writes sent email_log with messageId and returns ok", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ id: "<abc@mg>", message: "Queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const result = await sendInvitationEmail(
      env,
      {
        to: "alice@example.com",
        invitationId: "inv-1",
        universityId: "u-9",
        variables: {
          recipient_name: "Alice",
          role: "staff",
          invitation_url: "https://hub.example.com/accept-invitation?token=xyz",
          invited_by_name: "Admin",
          university_name: "Demo U",
        },
      },
      { options: { fetchImpl } },
    );

    expect(result).toEqual({ ok: true, messageId: "<abc@mg>" });

    const params = lastEmailLogParams(db);
    expect(params[1]).toBe("u-9");
    expect(params[2]).toBe("alice@example.com");
    expect(params[3]).toBe("invitation");
    expect(params[4]).toBe("university_hub_invitation");
    expect(params[5]).toBe("sent");
    expect(params[6]).toBe("<abc@mg>");
    expect(params[7]).toBeNull();
    expect(params[8]).toBe("invitation");
    expect(params[9]).toBe("inv-1");
  });

  it("Mailgun error path: writes failed email_log with reason and detail", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: "Sandbox subdomains restricted" }), {
        status: 403,
      });

    const result = await sendWelcomeEmail(
      env,
      { to: "newuser@example.com", variables: { recipient_name: "New" } },
      { options: { fetchImpl } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mailgun_http_error");

    const params = lastEmailLogParams(db);
    expect(params[3]).toBe("welcome");
    expect(params[5]).toBe("failed");
    expect(params[7]).toBe("mailgun_http_error: Sandbox subdomains restricted");
  });

  it("each send* function uses the correct template name and email type", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ id: "<x@mg>", message: "Queued" }), { status: 200 });

    const opts = { options: { fetchImpl } };
    await sendInvitationEmail(env, { to: "a@x", invitationId: "i1" }, opts);
    await sendInvitationResentEmail(env, { to: "a@x", invitationId: "i1" }, opts);
    await sendWelcomeEmail(env, { to: "a@x" }, opts);
    await sendPasswordResetEmail(env, { to: "a@x", userId: "u1" }, opts);
    await sendContactNotificationEmail(env, { to: "support@x", contactMessageId: "c1" }, opts);
    await sendAccountStatusChangedEmail(env, { to: "a@x", userId: "u1" }, opts);

    const inserts = db.executions
      .filter((e) => e.sql.includes("INSERT INTO email_logs"))
      .map((e) => ({ type: e.params[3], template: e.params[4] }));
    expect(inserts).toEqual([
      { type: "invitation", template: "university_hub_invitation" },
      { type: "invitation_resend", template: "university_hub_invitation_resend" },
      { type: "welcome", template: "university_hub_welcome" },
      { type: "password_reset", template: "university_hub_password_reset" },
      { type: "contact_notification", template: "university_hub_contact_notification" },
      { type: "account_status_changed", template: "university_hub_account_status_changed" },
    ]);
  });

  it("merges base variables (app_name, app_base_url, recipient_email) with caller-supplied", async () => {
    const env = makeEnv(new FakeD1());
    let captured: URLSearchParams | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = new URLSearchParams(init.body as string);
      return new Response(JSON.stringify({ id: "<x@mg>" }), { status: 200 });
    };

    await sendInvitationEmail(
      env,
      { to: "alice@example.com", invitationId: "i1", variables: { role: "staff" } },
      { options: { fetchImpl } },
    );

    expect(captured).not.toBeNull();
    const vars = JSON.parse(captured!.get("h:X-Mailgun-Variables")!);
    expect(vars).toMatchObject({
      app_name: "University Hub",
      app_base_url: "https://hub.example.com",
      recipient_email: "alice@example.com",
      role: "staff",
    });
  });

  it("never writes the Mailgun API key into the email_logs row", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { MAILGUN_API_KEY: "leak-canary-12345" });
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: "boom" }), { status: 500 });

    await sendWelcomeEmail(env, { to: "z@example.com" }, { options: { fetchImpl } });

    for (const exec of db.executions) {
      const serialized = JSON.stringify(exec.params);
      expect(serialized).not.toContain("leak-canary-12345");
    }
  });

  it("swallows email_logs insert failures so the caller still gets the SendResult", async () => {
    const db = new FakeD1();
    db.forceRunError = new Error("disk full");
    const env = makeEnv(db);
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ id: "<m@mg>" }), { status: 200 });

    // Suppress the expected console.error from the writer.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendWelcomeEmail(env, { to: "z@example.com" }, { options: { fetchImpl } });
    expect(result).toEqual({ ok: true, messageId: "<m@mg>" });
    expect(errSpy).toHaveBeenCalled();
  });
});
