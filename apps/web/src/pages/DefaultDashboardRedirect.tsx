// Index route under `/app` — sends the user to their role-specific default
// dashboard so deep-linking to /app always lands somewhere useful.

import { Navigate } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { defaultDashboardForRole } from "@/lib/default-dashboard";

export function DefaultDashboardRedirect() {
  const { user } = useAuth();
  const target = user ? defaultDashboardForRole(user.role) : "/app/dashboard";
  return <Navigate to={target} replace />;
}
