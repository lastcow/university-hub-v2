// User-facing LMS connect flow (epic UNI-50 / sub-issue UNI-54).
//
//   GET    /api/lms/connections                       any authenticated user —
//                                                     their own connections,
//                                                     no tokens in response.
//   POST   /api/lms/connections/canvas/start          mint CSRF state, persist
//                                                     short-lived row, return
//                                                     the Canvas authorize URL.
//   GET    /api/lms/connections/canvas/callback       browser redirect target;
//                                                     validates state, exchanges
//                                                     code, encrypts tokens,
//                                                     upserts `lms_connections`,
//                                                     redirects back to the SPA.
//   POST   /api/lms/connections/:id/disconnect        flip status to `revoked`,
//                                                     clear stored tokens,
//                                                     write `lms.disconnected`
//                                                     audit row.
//
// Tokens never leave the Worker. The listing endpoint surfaces only
// metadata (status, last_synced_at, base_url, etc.); the connect flow
// stores access + refresh tokens via `encryptForUniversity` and reads
// them back only on the callback path (and later, sub-issue UNI-55, on
// sync). The disconnect handler clears the encrypted columns so a
// subsequent breach of D1 cannot re-derive a usable token.
//
// CSRF: the `/start` handler mints a 32-byte random `state`, persists it
// in `lms_oauth_states` keyed to `(user_id, university_id, provider_id,
// redirect_uri, expires_at)`, and returns the authorize URL with that
// state baked in. The `/callback` handler validates that:
//   1. A non-expired row with that exact state exists, AND
//   2. The row's `user_id` matches the calling session's `user.id`.
// Mismatched / missing / expired states return 400 and write nothing.
//
// `redirect_uri` is captured at start-time so the token exchange can
// pass it back to Canvas verbatim (Canvas treats `redirect_uri` as a
// binding parameter and rejects mismatches). This also means the same
// redirect URI Canvas was configured with by the customer admin must be
// what we send on `/start`; we derive it from the incoming request URL
// + the static `/api/lms/connections/canvas/callback` path.

import {
  type DisconnectLmsConnectionResponse,
  type LmsConnectionPublic,
  type LmsConnectionStatus,
  type LmsConnectionsResponse,
  type LmsProviderConfig,
  type LmsProviderId,
  type StartLmsConnectionResponse,
  startLmsConnectionInputSchema,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { encryptForUniversity } from "../crypto/field-encryption.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { decryptForUniversity } from "../crypto/field-encryption.js";
import { buildAuthorizeUrl, exchangeCodeForTokens } from "../lms/canvas/oauth.js";
import { CanvasOAuthError } from "../lms/canvas/http.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// State value is 32 bytes of randomness, base64url-encoded — the same
// shape (and source) we use for session tokens. 256 bits of entropy is
// well past the OWASP guidance for an OAuth state.
const STATE_BYTES = 32;
// The `/start` row lives ~10 minutes. Canvas's authorize hop is
// interactive but rarely takes longer; an expired state is the right
// failure mode (user clicks Connect again).
const STATE_TTL_SECONDS = 10 * 60;

interface ProviderConfigRow extends Row {
  id: string;
  university_id: string;
  provider_id: LmsProviderId;
  base_url: string;
  client_id: string;
  client_secret_encrypted: string;
  enabled: number;
  configured_by_user_id: string | null;
  configured_at: string;
  updated_at: string;
}

interface ConnectionRow extends Row {
  id: string;
  user_id: string;
  university_id: string;
  provider_id: LmsProviderId;
  auth_method: "oauth" | "pat";
  base_url: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scope: string | null;
  status: LmsConnectionStatus;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

type LmsConnectOrigin = "onboarding" | "integrations";

interface OauthStateRow extends Row {
  state: string;
  user_id: string;
  university_id: string;
  provider_id: LmsProviderId;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
  /** UNI-57. Captured at /start-time so /callback can route the user
   *  back to either the standing /app/integrations page or the
   *  onboarding "Connected — sync now or later" step. */
  origin: LmsConnectOrigin;
}

const SELECT_CONNECTION = `
  SELECT id, user_id, university_id, provider_id, auth_method, base_url,
         access_token_encrypted, refresh_token_encrypted,
         token_expires_at, scope, status, last_synced_at,
         created_at, updated_at
    FROM lms_connections
`;

const SELECT_PROVIDER_CONFIG = `
  SELECT id, university_id, provider_id, base_url, client_id,
         client_secret_encrypted, enabled, configured_by_user_id,
         configured_at, updated_at
    FROM lms_provider_configs
`;

function rowToPublic(row: ConnectionRow): LmsConnectionPublic {
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    provider_id: row.provider_id,
    auth_method: row.auth_method,
    base_url: row.base_url,
    status: row.status,
    scope: row.scope,
    token_expires_at: (row.token_expires_at ?? null) as
      | LmsConnectionPublic["token_expires_at"],
    last_synced_at: (row.last_synced_at ?? null) as
      | LmsConnectionPublic["last_synced_at"],
    created_at: row.created_at as LmsConnectionPublic["created_at"],
    updated_at: row.updated_at as LmsConnectionPublic["updated_at"],
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function generateStateToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Compose the absolute URL Canvas will be redirected back to after the
 * authorize hop. The path is fixed; the origin comes from the incoming
 * request so the URL matches whatever host the Worker is reachable at
 * (custom domain, workers.dev preview, local `wrangler dev`, etc.). The
 * customer admin must configure this URL in their Canvas Developer Key
 * — see docs/lms-canvas.md.
 */
function buildRedirectUri(ctx: RequestContext): string {
  return `${ctx.url.origin}/api/lms/connections/canvas/callback`;
}

/**
 * Choose where the `/callback` handler should redirect the browser
 * after a (success or failure) OAuth round-trip. Production deploys
 * set `APP_BASE_URL` to the SPA's origin (Cloudflare Pages); local dev
 * doesn't, in which case we fall back to the request's own origin.
 *
 * The path differs by `origin`:
 *   - `integrations` (default): /app/integrations — pre-existing
 *     behavior. Handles the recurring "manage my LMS link" surface.
 *   - `onboarding` (UNI-57): /app/onboarding/lms — the post-MFA
 *     onboarding flow's "Connected — sync now or later" step.
 *
 * Both paths read the same `?connected=canvas` / `?lms_error=...&detail=...`
 * query params; the SPA's two pages just render slightly different copy
 * around the toast.
 */
function buildSpaReturnUrl(
  ctx: RequestContext,
  outcome: "connected" | "error",
  origin: LmsConnectOrigin,
  detail?: string,
): string {
  const base =
    (ctx.env.APP_BASE_URL && ctx.env.APP_BASE_URL.trim()) || ctx.url.origin;
  const trimmed = base.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (outcome === "connected") {
    params.set("connected", "canvas");
  } else {
    params.set("lms_error", "canvas");
    if (detail) params.set("detail", detail);
  }
  const path =
    origin === "onboarding" ? "/app/onboarding/lms" : "/app/integrations";
  return `${trimmed}${path}?${params.toString()}`;
}

async function loadProviderConfig(
  db: D1Database,
  universityId: string,
  providerId: LmsProviderId,
): Promise<ProviderConfigRow | null> {
  return queryFirst<ProviderConfigRow>(
    db,
    `${SELECT_PROVIDER_CONFIG} WHERE university_id = ? AND provider_id = ? LIMIT 1`,
    [universityId, providerId],
  );
}

async function loadConnectionsForUser(
  db: D1Database,
  userId: string,
): Promise<ConnectionRow[]> {
  return queryAll<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  );
}

async function loadConnectionById(
  db: D1Database,
  id: string,
): Promise<ConnectionRow | null> {
  return queryFirst<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE id = ? LIMIT 1`,
    [id],
  );
}

async function loadConnectionByUserAndProvider(
  db: D1Database,
  userId: string,
  providerId: LmsProviderId,
): Promise<ConnectionRow | null> {
  return queryFirst<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE user_id = ? AND provider_id = ? LIMIT 1`,
    [userId, providerId],
  );
}

async function consumeStateRow(
  db: D1Database,
  state: string,
): Promise<OauthStateRow | null> {
  // SELECT-then-DELETE rather than DELETE … RETURNING because D1 does
  // not yet support RETURNING; the two-step is fine because `state` is
  // a 256-bit nonce and a duplicate consume race only matters at the
  // attacker level, where they'd have already had to guess the value.
  const row = await queryFirst<OauthStateRow>(
    db,
    `SELECT state, user_id, university_id, provider_id, redirect_uri,
            created_at, expires_at, origin
       FROM lms_oauth_states
      WHERE state = ?
      LIMIT 1`,
    [state],
  );
  if (!row) return null;
  await execute(
    db,
    `DELETE FROM lms_oauth_states WHERE state = ?`,
    [state],
  );
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/lms/connections — caller's own connections, no tokens.
// ---------------------------------------------------------------------------

export async function handleListLmsConnections(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await loadConnectionsForUser(ctx.env.DB, auth.user.id);
  const body: LmsConnectionsResponse = {
    connections: rows.map(rowToPublic),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/lms/connections/canvas/start
// ---------------------------------------------------------------------------

export async function handleStartCanvasConnection(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!actor.university_id) {
    return errorResponse(
      400,
      "invalid_request",
      "Your account is not associated with a university; LMS connections are scoped per-university.",
    );
  }

  const raw = await readJson(ctx.request);
  // An empty body is fine — `purpose` is optional. Treat null/undefined
  // as `{}` so the schema doesn't reject the common no-body case.
  const parsed = startLmsConnectionInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid connect-flow payload.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }

  const config = await loadProviderConfig(
    ctx.env.DB,
    actor.university_id,
    "canvas",
  );
  if (!config || config.enabled !== 1) {
    return errorResponse(
      400,
      "lms_not_configured",
      "Canvas is not configured for your university yet — ask your administrator to enable it in Settings → Integrations.",
    );
  }

  const state = generateStateToken();
  const redirectUri = buildRedirectUri(ctx);
  const origin: LmsConnectOrigin =
    parsed.data.origin === "onboarding" ? "onboarding" : "integrations";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_SECONDS * 1000);
  await execute(
    ctx.env.DB,
    `INSERT INTO lms_oauth_states
       (state, user_id, university_id, provider_id, redirect_uri,
        created_at, expires_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      state,
      actor.id,
      actor.university_id,
      "canvas",
      redirectUri,
      now.toISOString(),
      expiresAt.toISOString(),
      origin,
    ],
  );

  const purpose =
    parsed.data.purpose && parsed.data.purpose.length > 0
      ? parsed.data.purpose
      : (ctx.env.APP_NAME ?? "University Hub");

  const authorizeUrl = buildAuthorizeUrl(
    { base_url: config.base_url, client_id: config.client_id },
    state,
    redirectUri,
    { purpose },
  );

  const body: StartLmsConnectionResponse = {
    authorize_url: authorizeUrl,
    state,
    provider_id: "canvas",
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// GET /api/lms/connections/canvas/callback?code=...&state=...
// ---------------------------------------------------------------------------

export async function handleCanvasOAuthCallback(
  ctx: RequestContext,
): Promise<Response> {
  // The callback hop is hit by the browser, with the Hub session cookie
  // attached. We require the same authenticated user that started the
  // dance — anything else is a CSRF / replay attempt.
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const errorParam = ctx.url.searchParams.get("error");
  if (errorParam) {
    // The user denied access at Canvas's consent screen, or Canvas
    // surfaced an error. Don't write an audit / DB row; bounce back to
    // the SPA with a `lms_error` query param the page can render. The
    // pre-callback denial path doesn't have a state row to read origin
    // from, so we always redirect to the standing integrations page —
    // an onboarding-flow user will see the error there and can re-trigger
    // from /app/integrations.
    return Response.redirect(
      buildSpaReturnUrl(ctx, "error", "integrations", errorParam),
      302,
    );
  }

  const code = ctx.url.searchParams.get("code");
  const state = ctx.url.searchParams.get("state");
  if (!code || !state) {
    return errorResponse(
      400,
      "invalid_request",
      "OAuth callback missing code or state.",
    );
  }

  const stateRow = await consumeStateRow(ctx.env.DB, state);
  if (!stateRow) {
    return errorResponse(
      400,
      "invalid_state",
      "Unknown or already-consumed OAuth state. Start the connect flow again.",
    );
  }
  if (Date.parse(stateRow.expires_at) <= Date.now()) {
    return errorResponse(
      400,
      "invalid_state",
      "OAuth state has expired. Start the connect flow again.",
    );
  }
  if (stateRow.user_id !== actor.id) {
    // Different user finishing someone else's dance. Treat as CSRF.
    return errorResponse(
      400,
      "invalid_state",
      "OAuth state does not belong to the current session.",
    );
  }
  if (stateRow.provider_id !== "canvas") {
    return errorResponse(
      400,
      "invalid_state",
      "OAuth state was not minted for this provider.",
    );
  }

  const config = await loadProviderConfig(
    ctx.env.DB,
    stateRow.university_id,
    "canvas",
  );
  if (!config || config.enabled !== 1) {
    return errorResponse(
      400,
      "lms_not_configured",
      "Canvas is no longer configured for your university.",
    );
  }

  // Decrypt the OAuth client secret for the duration of the token
  // exchange. The plaintext lives only in this function; we never log
  // it, never return it, never store it in cleartext form.
  let clientSecret: string;
  try {
    clientSecret = await decryptForUniversity(
      ctx.env,
      config.client_secret_encrypted,
      stateRow.university_id,
    );
  } catch (cause) {
    console.error("lms_callback_decrypt_failed", { cause });
    return errorResponse(
      500,
      "internal_error",
      "Could not unwrap the Canvas OAuth client secret. Contact your administrator.",
    );
  }

  // `origin` defaults to 'integrations' for any state row written before
  // migration 0020 (the column has a default at the SQL level, but
  // defensive normalization here keeps the post-migration path explicit
  // and the type narrow).
  const origin: LmsConnectOrigin =
    stateRow.origin === "onboarding" ? "onboarding" : "integrations";

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(
      {
        base_url: config.base_url,
        client_id: config.client_id,
        client_secret: clientSecret,
      } as Pick<LmsProviderConfig, "base_url" | "client_id" | "client_secret">,
      code,
      stateRow.redirect_uri,
    );
  } catch (cause) {
    if (cause instanceof CanvasOAuthError) {
      return Response.redirect(
        buildSpaReturnUrl(ctx, "error", origin, cause.code),
        302,
      );
    }
    console.error("lms_callback_token_exchange_failed", { cause });
    return Response.redirect(
      buildSpaReturnUrl(ctx, "error", origin, "exchange_failed"),
      302,
    );
  }

  const accessTokenEncrypted = await encryptForUniversity(
    ctx.env,
    tokens.access_token,
    stateRow.university_id,
  );
  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptForUniversity(
        ctx.env,
        tokens.refresh_token,
        stateRow.university_id,
      )
    : null;

  const now = new Date().toISOString();
  const existing = await loadConnectionByUserAndProvider(
    ctx.env.DB,
    actor.id,
    "canvas",
  );
  let connectionId: string;
  let created: boolean;
  if (existing) {
    connectionId = existing.id;
    created = false;
    await execute(
      ctx.env.DB,
      `UPDATE lms_connections
          SET university_id = ?,
              auth_method = ?,
              base_url = ?,
              access_token_encrypted = ?,
              refresh_token_encrypted = ?,
              token_expires_at = ?,
              scope = ?,
              status = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        stateRow.university_id,
        "oauth",
        config.base_url,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        tokens.expires_at,
        tokens.scope,
        "active",
        now,
        existing.id,
      ],
    );
  } else {
    connectionId = crypto.randomUUID();
    created = true;
    await execute(
      ctx.env.DB,
      `INSERT INTO lms_connections
         (id, user_id, university_id, provider_id, auth_method, base_url,
          access_token_encrypted, refresh_token_encrypted,
          token_expires_at, scope, status, last_synced_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        connectionId,
        actor.id,
        stateRow.university_id,
        "canvas",
        "oauth",
        config.base_url,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        tokens.expires_at,
        tokens.scope,
        "active",
        null,
        now,
        now,
      ],
    );
  }

  await writeAuditLog(ctx.env.DB, {
    action: "lms.connected",
    actorUserId: actor.id,
    universityId: stateRow.university_id,
    entityType: "lms_connection",
    entityId: connectionId,
    metadata: {
      provider_id: "canvas",
      auth_method: "oauth",
      created,
      origin,
      has_refresh_token: refreshTokenEncrypted !== null,
    },
  });

  // UNI-57: a successful connect (from any origin) means the user has
  // demonstrated intent. Stamp `users.lms_onboarding_dismissed_at` with
  // COALESCE so we preserve the original timestamp on a re-connect
  // (existing.user dropping then reconnecting). The onboarding gate
  // then permanently treats the user as past the welcome flow.
  await execute(
    ctx.env.DB,
    `UPDATE users
        SET lms_onboarding_dismissed_at =
              COALESCE(lms_onboarding_dismissed_at, ?),
            updated_at = ?
      WHERE id = ?`,
    [now, now, actor.id],
  );

  return Response.redirect(
    buildSpaReturnUrl(ctx, "connected", origin),
    302,
  );
}

// ---------------------------------------------------------------------------
// POST /api/lms/connections/:id/disconnect
// ---------------------------------------------------------------------------

export async function handleDisconnectLmsConnection(
  ctx: RequestContext,
  connectionId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await loadConnectionById(ctx.env.DB, connectionId);
  if (!existing || existing.user_id !== actor.id) {
    // Tenant scoping: cloak the row's existence to a non-owner. A user
    // can only disconnect their own connections; a super_admin who
    // wants to surgically revoke someone else's Canvas link can do it
    // directly in D1 (no admin-on-behalf-of-user surface in Phase 1).
    return errorResponse(404, "not_found", "Connection not found.");
  }

  if (existing.status === "revoked") {
    // Already revoked. Re-write the audit row so post-incident review
    // sees the explicit "user clicked disconnect again" event, but
    // don't touch the row content (it's already cleared).
    await writeAuditLog(ctx.env.DB, {
      action: "lms.disconnected",
      actorUserId: actor.id,
      universityId: existing.university_id,
      entityType: "lms_connection",
      entityId: existing.id,
      metadata: {
        provider_id: existing.provider_id,
        already_revoked: true,
      },
    });
    return jsonOk<DisconnectLmsConnectionResponse>({
      ok: true,
      connection: rowToPublic(existing),
    });
  }

  // Snapshot the audit-relevant fields before the UPDATE so the audit
  // metadata reflects the row as it was at the moment the user clicked
  // disconnect (and so we don't depend on the SELECT returning a copy
  // vs. the same in-memory row reference).
  const previousStatus = existing.status;
  const previousAuthMethod = existing.auth_method;
  const previousProviderId = existing.provider_id;
  const previousUniversityId = existing.university_id;

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE lms_connections
        SET status = ?,
            access_token_encrypted = ?,
            refresh_token_encrypted = ?,
            token_expires_at = ?,
            scope = ?,
            updated_at = ?
      WHERE id = ?`,
    [
      "revoked",
      "",
      null,
      null,
      null,
      now,
      existing.id,
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "lms.disconnected",
    actorUserId: actor.id,
    universityId: previousUniversityId,
    entityType: "lms_connection",
    entityId: existing.id,
    metadata: {
      provider_id: previousProviderId,
      previous_status: previousStatus,
      auth_method: previousAuthMethod,
    },
  });

  const updated = await loadConnectionById(ctx.env.DB, existing.id);
  if (!updated) {
    return errorResponse(
      500,
      "internal_error",
      "Connection row could not be re-read after disconnect.",
    );
  }
  return jsonOk<DisconnectLmsConnectionResponse>({
    ok: true,
    connection: rowToPublic(updated),
  });
}
