// Departments CRUD endpoints (epic UNI-1 §9, §17, §30).
//
//   GET    /api/departments        list (scoped, optional ?university_id=)
//   POST   /api/departments        create (super_admin or university_admin)
//   GET    /api/departments/:id    detail (scoped)
//   PATCH  /api/departments/:id    update (super_admin or that university's admin)
//   DELETE /api/departments/:id    delete (blocked if courses still reference it)
//
// Writes audit-log via department.created / .updated / .deleted. RBAC:
// super_admin sees and edits everything; university_admin is scoped to their
// own university; everyone else gets 403 on writes and a scoped read view.

import {
  createDepartmentInputSchema,
  updateDepartmentInputSchema,
  type Department,
  type DepartmentListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type DepartmentRow = Row & {
  id: string;
  university_id: string;
  name: string;
  code: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

type DepartmentListRow = DepartmentRow & {
  university_name: string | null;
  course_count: number;
};

const SELECT_DEPARTMENT = `
  SELECT id, university_id, name, code, description, created_at, updated_at
    FROM departments
`;

const SELECT_DEPARTMENT_LIST = `
  SELECT d.id, d.university_id, d.name, d.code, d.description,
         d.created_at, d.updated_at,
         u.name AS university_name,
         (SELECT COUNT(1) FROM courses c WHERE c.department_id = d.id) AS course_count
    FROM departments d
    LEFT JOIN universities u ON u.id = d.university_id
`;

function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    university_id: row.university_id,
    name: row.name,
    code: row.code,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toDepartmentListItem(row: DepartmentListRow): DepartmentListItem {
  return {
    ...toDepartment(row),
    university_name: row.university_name,
    course_count: Number(row.course_count ?? 0),
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Whether the actor may read departments in `universityId`. */
function canRead(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  return actor.university_id !== null && actor.university_id === universityId;
}

/** Whether the actor may write departments in `universityId`. */
function canWrite(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") {
    return actor.university_id !== null && actor.university_id === universityId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/departments
// ---------------------------------------------------------------------------

export async function handleListDepartments(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("d.university_id = ?");
      params.push(universityId);
    }
  } else if (actor.university_id) {
    where.push("d.university_id = ?");
    params.push(actor.university_id);
  } else {
    return jsonOk([]);
  }

  const sql =
    SELECT_DEPARTMENT_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY d.name ASC LIMIT 200";

  const rows = await queryAll<DepartmentListRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toDepartmentListItem));
}

// ---------------------------------------------------------------------------
// POST /api/departments
// ---------------------------------------------------------------------------

export async function handleCreateDepartment(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (actor.role !== "super_admin" && actor.role !== "university_admin") {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to create departments.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = createDepartmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid department payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  // Resolve target university. super_admin must specify it; university_admin
  // is always scoped to their own university (we ignore any value they send).
  let universityId: string;
  if (actor.role === "super_admin") {
    if (!parsed.data.university_id) {
      return errorResponse(
        400,
        "invalid_request",
        "university_id is required.",
        { issues: { university_id: ["Required"] } },
      );
    }
    universityId = parsed.data.university_id;
  } else {
    if (!actor.university_id) {
      return errorResponse(
        403,
        "forbidden",
        "You aren't linked to a university.",
      );
    }
    universityId = actor.university_id;
  }

  // Confirm the target university exists. (super_admin path could otherwise
  // succeed silently with a bogus id and FK enforcement off in some local
  // setups — fail loudly instead.)
  const uni = await queryFirst<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM universities WHERE id = ? LIMIT 1`,
    [universityId],
  );
  if (!uni) {
    return errorResponse(404, "university_not_found", "University not found.");
  }

  const code = parsed.data.code ?? null;
  const description = parsed.data.description ?? null;

  if (code) {
    const existing = await queryFirst<{ id: string }>(
      ctx.env.DB,
      `SELECT id FROM departments WHERE university_id = ? AND code = ? LIMIT 1`,
      [universityId, code],
    );
    if (existing) {
      return errorResponse(
        409,
        "code_taken",
        "Another department in this university already uses that code.",
      );
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `INSERT INTO departments (id, university_id, name, code, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, universityId, parsed.data.name, code, description, now, now],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "department.created",
    actorUserId: actor.id,
    universityId,
    entityType: "department",
    entityId: id,
    metadata: { name: parsed.data.name, code },
  });

  const row = await queryFirst<DepartmentListRow>(
    ctx.env.DB,
    `${SELECT_DEPARTMENT_LIST} WHERE d.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not create department.");
  }
  return jsonOk(toDepartmentListItem(row), { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/departments/:id
// ---------------------------------------------------------------------------

export async function handleGetDepartment(
  ctx: RequestContext,
  departmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<DepartmentListRow>(
    ctx.env.DB,
    `${SELECT_DEPARTMENT_LIST} WHERE d.id = ? LIMIT 1`,
    [departmentId],
  );
  // 404 (not 403) when out of scope: don't leak existence to other tenants.
  if (!row || !canRead(actor, row.university_id)) {
    return errorResponse(404, "not_found", "Department not found.");
  }
  return jsonOk(toDepartmentListItem(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/departments/:id
// ---------------------------------------------------------------------------

export async function handleUpdateDepartment(
  ctx: RequestContext,
  departmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await queryFirst<DepartmentRow>(
    ctx.env.DB,
    `${SELECT_DEPARTMENT} WHERE id = ? LIMIT 1`,
    [departmentId],
  );
  if (!existing || !canRead(actor, existing.university_id)) {
    return errorResponse(404, "not_found", "Department not found.");
  }
  if (!canWrite(actor, existing.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit this department.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateDepartmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid update payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};

  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
    changed.name = parsed.data.name;
  }
  if (parsed.data.code !== undefined) {
    const nextCode = parsed.data.code;
    if (nextCode !== existing.code) {
      if (nextCode) {
        const collision = await queryFirst<{ id: string }>(
          ctx.env.DB,
          `SELECT id FROM departments WHERE university_id = ? AND code = ? AND id != ? LIMIT 1`,
          [existing.university_id, nextCode, departmentId],
        );
        if (collision) {
          return errorResponse(
            409,
            "code_taken",
            "Another department in this university already uses that code.",
          );
        }
      }
      updates.push("code = ?");
      params.push(nextCode);
      changed.code = nextCode;
    }
  }
  if (parsed.data.description !== undefined) {
    const nextDescription = parsed.data.description;
    if (nextDescription !== existing.description) {
      updates.push("description = ?");
      params.push(nextDescription);
      changed.description = nextDescription;
    }
  }

  if (updates.length === 0) {
    const refreshed = await queryFirst<DepartmentListRow>(
      ctx.env.DB,
      `${SELECT_DEPARTMENT_LIST} WHERE d.id = ? LIMIT 1`,
      [departmentId],
    );
    return jsonOk(refreshed ? toDepartmentListItem(refreshed) : toDepartment(existing));
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(departmentId);

  await execute(
    ctx.env.DB,
    `UPDATE departments SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  await writeAuditLog(ctx.env.DB, {
    action: "department.updated",
    actorUserId: actor.id,
    universityId: existing.university_id,
    entityType: "department",
    entityId: departmentId,
    metadata: { changed },
  });

  const refreshed = await queryFirst<DepartmentListRow>(
    ctx.env.DB,
    `${SELECT_DEPARTMENT_LIST} WHERE d.id = ? LIMIT 1`,
    [departmentId],
  );
  return jsonOk(refreshed ? toDepartmentListItem(refreshed) : toDepartment(existing));
}

// ---------------------------------------------------------------------------
// DELETE /api/departments/:id
// ---------------------------------------------------------------------------

export async function handleDeleteDepartment(
  ctx: RequestContext,
  departmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await queryFirst<DepartmentRow>(
    ctx.env.DB,
    `${SELECT_DEPARTMENT} WHERE id = ? LIMIT 1`,
    [departmentId],
  );
  if (!existing || !canRead(actor, existing.university_id)) {
    return errorResponse(404, "not_found", "Department not found.");
  }
  if (!canWrite(actor, existing.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to delete this department.",
    );
  }

  // Block delete if any courses still reference this department. The schema
  // declares ON DELETE SET NULL, but the spec asks for safe-error rejection
  // rather than orphaning courses, so we check first and refuse.
  const referencing = await queryFirst<{ count: number }>(
    ctx.env.DB,
    `SELECT COUNT(1) AS count FROM courses WHERE department_id = ?`,
    [departmentId],
  );
  const courseCount = Number(referencing?.count ?? 0);
  if (courseCount > 0) {
    return errorResponse(
      409,
      "department_in_use",
      "This department still has courses. Reassign or delete them first.",
      { course_count: courseCount },
    );
  }

  await execute(ctx.env.DB, `DELETE FROM departments WHERE id = ?`, [departmentId]);

  await writeAuditLog(ctx.env.DB, {
    action: "department.deleted",
    actorUserId: actor.id,
    universityId: existing.university_id,
    entityType: "department",
    entityId: departmentId,
    metadata: { name: existing.name, code: existing.code },
  });

  return jsonOk({ id: departmentId, deleted: true });
}
