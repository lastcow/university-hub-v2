// Per-section settings routes (UNI-58 §A). Each child route renders one
// or more section components from `SettingsPage.tsx`. Role gating is
// enforced here rather than only in the side nav so a deep-link by an
// out-of-scope role redirects cleanly instead of showing a section it
// shouldn't.

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import type { Role } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import {
  AccountSection,
  ActiveSessionsSection,
  EscalationContactsSection,
  IntegrationsSection,
  LegalSection,
  MailgunSection,
  SecuritySection,
  SystemSettingsSection,
  TrustedDevicesSection,
  UniversitySection,
} from "@/pages/SettingsPage";

function RequireRole({
  roles,
  children,
}: {
  roles: readonly Role[];
  children: ReactNode;
}): ReactNode {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) {
    return <Navigate to="/app/settings/account" replace />;
  }
  return <>{children}</>;
}

const ADMIN: readonly Role[] = ["super_admin", "university_admin"];
const SUPER_ADMIN: readonly Role[] = ["super_admin"];

export function AccountSettingsRoute() {
  return <AccountSection />;
}

export function SecuritySettingsRoute() {
  return (
    <div className="space-y-6">
      <SecuritySection />
      <ActiveSessionsSection />
      <TrustedDevicesSection />
    </div>
  );
}

export function UniversitySettingsRoute() {
  return (
    <RequireRole roles={ADMIN}>
      <UniversitySection />
    </RequireRole>
  );
}

export function IntegrationsSettingsRoute() {
  return <IntegrationsSection />;
}

export function LegalSettingsRoute() {
  return (
    <RequireRole roles={ADMIN}>
      <LegalSection />
    </RequireRole>
  );
}

export function MailgunSettingsRoute() {
  return (
    <RequireRole roles={SUPER_ADMIN}>
      <MailgunSection />
    </RequireRole>
  );
}

export function SystemSettingsRoute() {
  return (
    <RequireRole roles={SUPER_ADMIN}>
      <div className="space-y-6">
        <SystemSettingsSection />
        <EscalationContactsSection />
      </div>
    </RequireRole>
  );
}
