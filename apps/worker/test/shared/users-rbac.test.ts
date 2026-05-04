// Pure tests for the user-management RBAC helpers in @university-hub/shared.
// These guard the privilege-escalation rules that the Worker re-checks.

import { describe, expect, it } from "vitest";

import {
  canAssignRole,
  canManageTargetUser,
  canManageUsers,
  rolesAssignableBy,
  ROLES,
  type Role,
} from "@university-hub/shared";

describe("user-management RBAC helpers", () => {
  it("super_admin can manage every role and assign every role", () => {
    expect(canManageUsers("super_admin")).toBe(true);
    for (const r of ROLES) {
      expect(canManageTargetUser("super_admin", r)).toBe(true);
      expect(canAssignRole("super_admin", r)).toBe(true);
    }
    expect(rolesAssignableBy("super_admin")).toContain("super_admin");
  });

  it("university_admin can manage non-admin roles and assign non-admin roles", () => {
    expect(canManageUsers("university_admin")).toBe(true);
    const nonAdmin: readonly Role[] = [
      "staff",
      "faculty",
      "teacher",
      "teacher_assistant",
      "student",
      "guest",
      "viewer",
    ];
    for (const r of nonAdmin) {
      expect(canManageTargetUser("university_admin", r)).toBe(true);
      expect(canAssignRole("university_admin", r)).toBe(true);
    }
  });

  it("university_admin cannot escalate: cannot manage or assign admin roles", () => {
    // Privilege escalation guard — the rule under test.
    expect(canManageTargetUser("university_admin", "super_admin")).toBe(false);
    expect(canManageTargetUser("university_admin", "university_admin")).toBe(false);
    expect(canAssignRole("university_admin", "super_admin")).toBe(false);
    expect(canAssignRole("university_admin", "university_admin")).toBe(false);
    expect(rolesAssignableBy("university_admin")).not.toContain("super_admin");
    expect(rolesAssignableBy("university_admin")).not.toContain("university_admin");
  });

  it.each(["staff", "faculty", "teacher", "teacher_assistant", "student", "guest", "viewer"] as const)(
    "%s cannot manage anyone",
    (role) => {
      expect(canManageUsers(role)).toBe(false);
      expect(rolesAssignableBy(role)).toEqual([]);
      for (const target of ROLES) {
        expect(canManageTargetUser(role, target)).toBe(false);
        expect(canAssignRole(role, target)).toBe(false);
      }
    },
  );
});
