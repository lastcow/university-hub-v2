-- 0020_lms_onboarding.sql
--
-- Onboarding hook for the LMS connect flow (epic UNI-50 / sub-issue UNI-57).
--
-- After a newly invited faculty / teacher / TA finishes invitation acceptance
-- and MFA enrollment (UNI-49), surface a one-time "Connect your LMS" step.
-- The step is dismissible: a Skip click and a successful Connect both flip
-- `users.lms_onboarding_dismissed_at` so subsequent sign-ins skip the page.
--
-- Two columns on two tables:
--
--   1. `users.lms_onboarding_dismissed_at` — TEXT timestamp, nullable. NULL
--      means the user is still eligible to see the onboarding step on their
--      next sign-in (assuming the role + provider + connection gates also
--      pass — see apps/worker/src/routes/onboarding.ts). The
--      `GET /api/onboarding/lms-step` handler treats any non-NULL value as
--      "permanently dismissed". This column is also stamped by the
--      `GET /api/lms/connections/canvas/callback` happy path so a user who
--      connects via the onboarding flow (or via the Settings → Integrations
--      page) doesn't have the step come back the next time they sign in.
--
--   2. `lms_oauth_states.origin` — TEXT enum, NOT NULL with default
--      `'integrations'`. The `/start` handler captures whether the dance
--      was kicked off from the onboarding step or the standing
--      `/app/integrations` page; the `/callback` handler reads it back to
--      decide where to redirect on success ('connected — sync now or later'
--      onboarding step vs. the integrations page). Default is the
--      pre-existing behavior so any in-flight states from before this
--      migration light up correctly post-deploy.

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN lms_onboarding_dismissed_at TEXT;

ALTER TABLE lms_oauth_states ADD COLUMN origin TEXT NOT NULL DEFAULT 'integrations';
