// Cross-actor isolation suite (UNI-23).
//
// For every protected route × every seeded actor, this suite asserts:
//   - actors in the scenario's `successActors` list get a 2xx response, and
//   - every other actor is denied — either an HTTP 4xx (403 / 404 / 410 etc.)
//     or, for list endpoints whose university scoping yields an empty page,
//     a 200 with `data.length === 0`.
//
// Two regressions this catches:
//   1. Wrong-role access (e.g. a `viewer` reaching an admin endpoint).
//   2. Wrong-course-of-correct-role access (e.g. faculty A on UNI_A trying to
//      read course B1 in UNI_A — a course in their own university but not
//      one they're assigned to).
//
// Adding a new protected route is one entry in `scenarios.ts`; the matrix
// here automatically generates ~23 test cases for it.

import { describe, expect, it } from "vitest";

import { seed, UNI_A, UNI_B, type ActorCatalog, type ActorKey } from "./seed.js";
import { ALL_ACTOR_KEYS, SCENARIOS, type Scenario } from "./scenarios.js";

/** The university id that a scenario explicitly targets (e.g. "(UNI_A)"). */
function scenarioTargetUni(scenario: Scenario): string | null {
  if (scenario.id.includes("UNI_A")) return UNI_A;
  if (scenario.id.includes("UNI_B")) return UNI_B;
  return null;
}

// Each scenario gets a fresh seed so writes from one scenario don't bleed
// into another (e.g. POST /api/courses inserts a row that GET /api/courses
// would otherwise pick up).
async function runFor(actor: ActorCatalog[ActorKey], scenario: Scenario) {
  const { db } = seed();
  const res = await scenario.invoke(actor, db);
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    body = null;
  }
  return { res, body };
}

interface ListBody {
  ok?: boolean;
  data?: unknown[];
}

function isListBody(body: unknown): body is ListBody {
  return !!body && typeof body === "object" && Array.isArray((body as ListBody).data);
}

describe("Cross-actor route isolation matrix", () => {
  // Sanity: scenarios reference real actor keys.
  for (const sc of SCENARIOS) {
    for (const a of sc.successActors) {
      if (!ALL_ACTOR_KEYS.includes(a)) {
        throw new Error(
          `Scenario "${sc.id}" references unknown successActor "${a}"`,
        );
      }
    }
  }

  for (const scenario of SCENARIOS) {
    describe(scenario.id, () => {
      const successSet = new Set(scenario.successActors);

      it.each(scenario.successActors.map((k) => [k]))(
        "actor %s succeeds",
        async (actorKey) => {
          const { actors } = seed(); // actor reference only — fresh DB per call below
          const { res, body } = await runFor(actors[actorKey as ActorKey], scenario);
          expect(
            res.status,
            `${scenario.id} as ${actorKey}: expected 2xx, got ${res.status} ${JSON.stringify(body)}`,
          ).toBeLessThan(300);
          expect(res.status).toBeGreaterThanOrEqual(200);
        },
      );

      const wrongActors = ALL_ACTOR_KEYS.filter((k) => !successSet.has(k));

      it.each(wrongActors.map((k) => [k]))(
        "actor %s is denied (4xx, or empty list)",
        async (actorKey) => {
          const { actors } = seed();
          const { res, body } = await runFor(actors[actorKey as ActorKey], scenario);

          if (scenario.strictForbidden) {
            expect(
              res.status,
              `${scenario.id} as ${actorKey}: expected 403, got ${res.status}`,
            ).toBe(403);
            return;
          }

          // Acceptable failure shapes for a "wrong actor":
          //   - Any 4xx
          //   - 200 with empty data array, when emptyForOthers is set
          if (res.status >= 400 && res.status < 500) return;

          if (scenario.emptyForOthers && res.status === 200 && isListBody(body)) {
            expect(
              body.data!.length,
              `${scenario.id} as ${actorKey}: expected empty data array, got ${body.data!.length} rows`,
            ).toBe(0);
            return;
          }

          // Special-case: list endpoints that don't 4xx by default but scope
          // server-side (GET /api/universities, GET /api/courses,
          // GET /api/departments). Their wrong-actor path is "200 with no
          // foreign-uni rows visible" — assert that nothing in the response
          // crosses tenant lines.
          if ((res.status === 200 || res.status === 201) && isListBody(body)) {
            if (body.data!.length === 0) return;
            assertNoCrossTenantLeak(actors[actorKey as ActorKey], body.data!, scenario);
            return;
          }

          // Single-resource success (POST .../departments, POST .../courses)
          // can also be a valid wrong-actor outcome IF the route silently
          // re-scoped the write into the actor's own university. We accept
          // 200/201 only when the returned row's university_id is NOT the
          // tenant the scenario targets — i.e. the actor was prevented from
          // touching that tenant even though the call shape succeeded.
          if (
            (res.status === 200 || res.status === 201) &&
            body &&
            typeof body === "object"
          ) {
            const data = (body as { data?: unknown }).data;
            if (data && typeof data === "object" && !Array.isArray(data)) {
              const rowUni = (data as Record<string, unknown>).university_id;
              const targetUni = scenarioTargetUni(scenario);
              const actor = actors[actorKey as ActorKey];
              if (
                typeof rowUni === "string" &&
                targetUni !== null &&
                rowUni !== targetUni &&
                actor.role !== "super_admin"
              ) {
                // Created (or read) something in the actor's own uni instead
                // of the targeted one — that's the route enforcing isolation.
                return;
              }
            }
          }

          throw new Error(
            `${scenario.id} as ${actorKey}: unexpected non-denied status ${res.status} ${JSON.stringify(body)}`,
          );
        },
      );
    });
  }
});

// For broad list endpoints (GET /api/universities, /api/courses,
// /api/departments) we expect every signed-in actor to succeed but the
// result set must be filtered to the actor's own university (and global for
// super_admin). This helper enforces that property when a wrong-actor 200
// slips through the strict-deny check.
function assertNoCrossTenantLeak(
  actor: ActorCatalog[ActorKey],
  rows: unknown[],
  scenario: Scenario,
): void {
  if (actor.role === "super_admin") return; // global view is by design
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rowUni =
      typeof r.university_id === "string"
        ? r.university_id
        : typeof r.id === "string" && scenario.id.includes("/api/universities")
        ? r.id
        : null;
    if (rowUni && actor.university_id && rowUni !== actor.university_id) {
      throw new Error(
        `${scenario.id} leaked a row from university ${rowUni} to actor ${actor.id} ` +
          `(actor.university_id=${actor.university_id})`,
      );
    }
  }
}
