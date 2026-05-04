// Production bootstrap endpoint (epic UNI-1 §35, sub-issue UNI-16).
//
// `POST /api/bootstrap/super-admin` creates the first super_admin user (and
// optionally the first university). It is a one-shot path:
//
//   1. The Worker must have a `BOOTSTRAP_SECRET` env var set. Without it,
//      the endpoint always returns 404 — the route effectively does not
//      exist in production.
//   2. The request must present `Authorization: Bearer <BOOTSTRAP_SECRET>`.
//      Compared in constant time.
//   3. Refused once any `super_admin` row already exists, regardless of
//      secret. This is the real "one-shot" gate — even a leaked secret
//      cannot be reused after a successful bootstrap.
//
// After a successful bootstrap, operators should also delete the secret
// with `wrangler secret delete BOOTSTRAP_SECRET` as defense in depth.
//
// There is intentionally NO public registration path — invitations land via
// `POST /api/invitations` from a signed-in admin (created here first).

import type { SessionUser } from "@university-hub/shared";

import { hashPassword } from "../auth/password.js";
import { toSessionUser, type UserRow } from "../auth/session.js";
import { execute, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";
import type { RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface BootstrapInput {
  email: string;
  name: string;
  password: string;
  university_name?: string | null;
}

export interface BootstrapResult {
  user: SessionUser;
  university_id: string | null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? (m[1] ?? "").trim() : null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseInput(raw: unknown): BootstrapInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const emailVal = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  const nameVal = typeof r.name === "string" ? r.name.trim() : "";
  const passwordVal = typeof r.password === "string" ? r.password : "";
  const universityName =
    typeof r.university_name === "string" && r.university_name.trim().length > 0
      ? r.university_name.trim()
      : null;
  if (!EMAIL_RE.test(emailVal)) return null;
  if (nameVal.length === 0 || nameVal.length > 200) return null;
  if (passwordVal.length < MIN_PASSWORD_LENGTH) return null;
  return {
    email: emailVal,
    name: nameVal,
    password: passwordVal,
    university_name: universityName,
  };
}

/** True iff the env has `BOOTSTRAP_SECRET` set to a non-placeholder value. */
function bootstrapEnabled(env: Env): boolean {
  const v = env.BOOTSTRAP_SECRET;
  if (!v) return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.toLowerCase().startsWith("replace-with-")) return false;
  return true;
}

export async function handleBootstrapSuperAdmin(
  ctx: RequestContext,
): Promise<Response> {
  // Without the secret configured, the endpoint does not exist. We return 404
  // rather than 401/403 to avoid advertising the route in environments where
  // bootstrap has been disabled.
  if (!bootstrapEnabled(ctx.env)) {
    return errorResponse(
      404,
      "not_found",
      "The requested resource was not found.",
    );
  }

  const provided = readBearer(ctx.request.headers.get("authorization"));
  const expected = (ctx.env.BOOTSTRAP_SECRET ?? "").trim();
  if (!provided || !constantTimeEquals(provided, expected)) {
    return errorResponse(
      401,
      "unauthorized",
      "Invalid bootstrap credentials.",
    );
  }

  // Hard one-shot gate: refused once any super_admin already exists. This
  // makes the endpoint safe even if the secret is ever leaked or reused —
  // the only way past it is to first delete every super_admin row, which
  // requires DB access anyway.
  const existing = await queryFirst<Row & { id: string }>(
    ctx.env.DB,
    `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`,
  );
  if (existing) {
    return errorResponse(
      409,
      "already_bootstrapped",
      "A super_admin user already exists. The bootstrap endpoint is closed.",
    );
  }

  const raw = await readJson(ctx.request);
  const input = parseInput(raw);
  if (!input) {
    return errorResponse(
      400,
      "invalid_request",
      "email, name, and an 8+ character password are required.",
    );
  }

  // Defend against the (rare) race where the email is already in use even
  // though no super_admin exists yet — e.g. an inactive user from a previous
  // partial bootstrap or a manual SQL insert.
  const dupe = await queryFirst<Row & { id: string }>(
    ctx.env.DB,
    `SELECT id FROM users WHERE email = ? LIMIT 1`,
    [input.email],
  );
  if (dupe) {
    return errorResponse(
      409,
      "user_exists",
      "An account already exists for that email address.",
    );
  }

  let universityId: string | null = null;
  if (input.university_name) {
    universityId = crypto.randomUUID();
    await execute(
      ctx.env.DB,
      `INSERT INTO universities (id, name, status) VALUES (?, ?, 'active')`,
      [universityId, input.university_name],
    );
    await writeAuditLog(ctx.env.DB, {
      action: "university.created",
      actorUserId: null,
      universityId,
      entityType: "university",
      entityId: universityId,
      metadata: { source: "bootstrap" },
    });
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  await execute(
    ctx.env.DB,
    `INSERT INTO users
       (id, email, password_hash, name, role, status, university_id)
     VALUES (?, ?, ?, ?, 'super_admin', 'active', ?)`,
    [userId, input.email, passwordHash, input.name, universityId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "user.created",
    actorUserId: null,
    universityId,
    entityType: "user",
    entityId: userId,
    metadata: { source: "bootstrap", role: "super_admin", email: input.email },
  });

  const userRow = await queryFirst<UserRow>(
    ctx.env.DB,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at
       FROM users WHERE id = ?`,
    [userId],
  );
  if (!userRow) {
    return errorResponse(500, "bootstrap_failed", "Bootstrap insert succeeded but user could not be read back.");
  }

  const body: BootstrapResult = {
    user: toSessionUser(userRow),
    university_id: universityId,
  };
  return jsonOk(body, { status: 201 });
}
