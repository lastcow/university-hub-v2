// Central Mailgun HTTP boundary.
//
// All six send* functions in ./index.ts go through `sendViaMailgun`. This is
// the only place that:
//   - reads MAILGUN_* env vars,
//   - performs the HTTP call,
//   - normalizes failures into `SendResult`,
//   - and chooses a sanitized error string suitable for `email_logs.error`.
//
// Per epic UNI-1 §16: never throw raw Mailgun errors at callers, never log
// secrets. The API key is only read inside this file and is sent as the
// password half of HTTP Basic auth. Variables and recipient are the only
// things written to logs.

import type { Env } from "../env.js";

import type { MailgunSendRequest, SendResult, TemplateVariables } from "./types.js";

interface MailgunConfig {
  apiKey: string;
  domain: string;
  fromEmail: string;
  fromName: string;
  baseUrl: string;
}

function mailgunBaseUrl(region: string | undefined): string {
  // Mailgun supports two regions; only US and EU are valid. Anything else
  // (including the unset/placeholder case) defaults to US.
  if ((region ?? "").trim().toUpperCase() === "EU") {
    return "https://api.eu.mailgun.net";
  }
  return "https://api.mailgun.net";
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.trim();
  if (v.length === 0) return true;
  // The .dev.vars.example file ships sentinel placeholders that look like
  // `replace-with-...`. Treat them as "not configured" so dev never sends.
  return v.toLowerCase().startsWith("replace-with-");
}

export function readMailgunConfig(env: Env): MailgunConfig | null {
  if (isPlaceholder(env.MAILGUN_API_KEY) || isPlaceholder(env.MAILGUN_DOMAIN)) {
    return null;
  }
  const fromEmail = (env.MAILGUN_FROM_EMAIL ?? "").trim() || "no-reply@example.com";
  const fromName = (env.MAILGUN_FROM_NAME ?? "").trim() || env.APP_NAME || "University Hub";
  return {
    apiKey: env.MAILGUN_API_KEY!.trim(),
    domain: env.MAILGUN_DOMAIN!.trim(),
    fromEmail,
    fromName,
    baseUrl: mailgunBaseUrl(env.MAILGUN_REGION),
  };
}

function buildAuthHeader(apiKey: string): string {
  // Mailgun expects HTTP Basic with username "api". `btoa` is available in
  // the Workers runtime.
  return `Basic ${btoa(`api:${apiKey}`)}`;
}

function fromAddress(cfg: MailgunConfig): string {
  // `Name <email>` — Mailgun parses this into the From header.
  return `${cfg.fromName} <${cfg.fromEmail}>`;
}

function serializeVariables(variables: TemplateVariables): string {
  // Mailgun only accepts string values for template variables. Drop nulls /
  // undefineds; coerce numbers/booleans to strings so callers don't have to.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return JSON.stringify(out);
}

function buildFormBody(cfg: MailgunConfig, req: MailgunSendRequest): URLSearchParams {
  const body = new URLSearchParams();
  body.set("from", fromAddress(cfg));
  body.set("to", req.to);
  body.set("template", req.templateName);
  // Mailgun pulls the subject from the template by default. Variables ride
  // along in `h:X-Mailgun-Variables` as JSON.
  body.set("h:X-Mailgun-Variables", serializeVariables(req.variables));
  return body;
}

interface MailgunSuccessBody {
  id?: unknown;
  message?: unknown;
}

interface MailgunErrorBody {
  message?: unknown;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractMessageId(body: unknown): string | null {
  if (body && typeof body === "object" && "id" in body) {
    const id = (body as MailgunSuccessBody).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function extractErrorDetail(body: unknown): string | null {
  if (body && typeof body === "object" && "message" in body) {
    const msg = (body as MailgunErrorBody).message;
    if (typeof msg === "string" && msg.length > 0) {
      // Cap the persisted error to keep `email_logs.error` from ballooning if
      // Mailgun ever returns something unusually large.
      return msg.slice(0, 500);
    }
  }
  return null;
}

/**
 * The injectable fetch boundary used by every send* function. In production
 * this is `globalThis.fetch`; tests pass a fake.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SendViaMailgunOptions {
  fetchImpl?: FetchLike;
}

/**
 * Perform a single Mailgun HTTP send. Returns a discriminated `SendResult` —
 * never throws Mailgun-shaped errors at the caller.
 */
export async function sendViaMailgun(
  env: Env,
  req: MailgunSendRequest,
  options: SendViaMailgunOptions = {},
): Promise<SendResult> {
  const cfg = readMailgunConfig(env);
  if (!cfg) {
    return { ok: false, reason: "mailgun_not_configured" };
  }

  const url = `${cfg.baseUrl}/v3/${encodeURIComponent(cfg.domain)}/messages`;
  const body = buildFormBody(cfg, req);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader(cfg.apiKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (cause) {
    // Network-layer failures (DNS, TLS, abort). Don't include the raw error
    // object in logs — it can serialize the request URL with auth headers in
    // some runtimes.
    console.error("mailgun_network_error", { type: req.type });
    return {
      ok: false,
      reason: "mailgun_network_error",
      detail: cause instanceof Error ? cause.message.slice(0, 200) : "fetch_failed",
    };
  }

  const parsed = await readJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorDetail(parsed) ?? `http_${response.status}`;
    console.error("mailgun_http_error", { type: req.type, status: response.status });
    return { ok: false, reason: "mailgun_http_error", detail };
  }

  const messageId = extractMessageId(parsed);
  if (!messageId) {
    // Mailgun returned 2xx but no `id`. Treat as a successful send with
    // unknown message id rather than a hard failure — the log row still
    // reflects the attempt.
    return { ok: true, messageId: null };
  }
  return { ok: true, messageId };
}
