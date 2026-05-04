// Sanity tests for the invitation RBAC helpers shipped in
// `@university-hub/shared`. They live in the worker test tree because that's
// where the existing vitest runner is wired up.

import { describe, expect, it } from "vitest";

import {
  canInvite,
  invitableRoleGroups,
  rolesInvitableBy,
} from "@university-hub/shared";

describe("invitation RBAC helpers", () => {
  it("super_admin can invite every role", () => {
    expect(canInvite("super_admin")).toBe(true);
    const allowed = rolesInvitableBy("super_admin");
    expect(allowed).toContain("super_admin");
    expect(allowed).toContain("guest");
  });

  it("university_admin can invite anyone except super_admin", () => {
    expect(canInvite("university_admin")).toBe(true);
    const allowed = rolesInvitableBy("university_admin");
    expect(allowed).toContain("university_admin");
    expect(allowed).toContain("student");
    expect(allowed).not.toContain("super_admin");
  });

  it.each(["staff", "faculty", "teacher", "student", "guest", "viewer"] as const)(
    "%s cannot invite",
    (role) => {
      expect(canInvite(role)).toBe(false);
      expect(rolesInvitableBy(role)).toEqual([]);
    },
  );

  it("groups invitable roles by §27 categories and drops empty groups", () => {
    const groups = invitableRoleGroups("university_admin");
    const groupNames = groups.map((g) => g.group);
    expect(groupNames).toContain("admin");
    expect(groupNames).toContain("operations");
    expect(groupNames).toContain("learner");
    expect(invitableRoleGroups("student")).toEqual([]);
  });
});
