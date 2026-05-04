// Status / role badges for the users + universities admin UIs (epic UNI-1
// §28). The role badge uses ROLE_LABELS so `teacher_assistant` renders as
// "Teacher Assistant" everywhere.

import {
  ROLE_LABELS,
  type Role,
  type UniversityStatus,
  type UserStatus,
} from "@university-hub/shared";

import { Badge, type BadgeProps } from "@/components/ui/badge";

const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  suspended: "Suspended",
  pending: "Pending",
};

const USER_STATUS_VARIANTS: Record<UserStatus, BadgeProps["variant"]> = {
  active: "success",
  inactive: "outline",
  suspended: "destructive",
  pending: "warning",
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return (
    <Badge variant={USER_STATUS_VARIANTS[status]}>
      {USER_STATUS_LABELS[status]}
    </Badge>
  );
}

const ROLE_VARIANTS: Partial<Record<Role, BadgeProps["variant"]>> = {
  super_admin: "default",
  university_admin: "default",
  staff: "secondary",
  faculty: "secondary",
  teacher: "secondary",
  teacher_assistant: "secondary",
  student: "outline",
  guest: "outline",
  viewer: "outline",
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge variant={ROLE_VARIANTS[role] ?? "secondary"}>{ROLE_LABELS[role]}</Badge>;
}

const UNIVERSITY_STATUS_LABELS: Record<UniversityStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
};

const UNIVERSITY_STATUS_VARIANTS: Record<UniversityStatus, BadgeProps["variant"]> = {
  active: "success",
  inactive: "outline",
  archived: "destructive",
};

export function UniversityStatusBadge({ status }: { status: UniversityStatus }) {
  return (
    <Badge variant={UNIVERSITY_STATUS_VARIANTS[status]}>
      {UNIVERSITY_STATUS_LABELS[status]}
    </Badge>
  );
}
