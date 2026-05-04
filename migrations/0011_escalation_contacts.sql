-- 0011_escalation_contacts.sql
--
-- Runtime-configurable "Owners + escalation contacts" surface for the
-- breach-response runbook (epic UNI-21 / sub-issue UNI-40).
--
-- Background. The incident-response runbook (`docs/incident-response.md`,
-- shipped under UNI-35) carried a placeholder table for the six escalation
-- roles every customer deploy needs filled in before opening to real
-- students: operator on-call, customer DPO, customer FERPA officer,
-- customer IT / security lead, customer general counsel, customer CEO.
-- Leaving those rows blank is itself a runbook gap (`blank rows in
-- production = self-incident (S2)`).
--
-- This migration moves the contacts out of markdown into D1 so super_admin
-- operators can edit them in-app, and seeds six rows with mockup defaults
-- (RFC 2606 reserved-domain emails — `*@example.com` / `*@example.edu` —
-- and the +1-555-01xx fictional phone range). The mockups unblock the
-- "blank rows" launch gate at the system level: instead of "must populate
-- before launch", the rule shifts to "must replace mockup defaults before
-- launch" (the mockup-vs-real check keys off `*@example.*` emails / 555
-- phone numbers).
--
-- Single-tenant per deploy means we do NOT scope contacts by
-- `university_id` — there's exactly one row per `role_key` per deploy.
-- Multi-tenant per-customer overlays are explicitly out of scope (matches
-- the same decision in `docs/incident-response.md` § Out of scope).
--
-- Edits are audited via `audit_logs` (action `escalation.contact_updated`),
-- following the same pattern as `legal.document_updated` from UNI-34. The
-- audit row is the durable history of who changed which contact when —
-- this table stores only the current state, no version history.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- escalation_contacts — current owner + after-hours phone per role
-- ---------------------------------------------------------------------------

CREATE TABLE escalation_contacts (
  -- Stable string identifier for the role slot. The runbook + UI render
  -- the rows in the order defined by `display_order`. Keys are NOT
  -- user-editable — only the contact details are.
  role_key            TEXT PRIMARY KEY
                       CHECK (role_key IN (
                         'operator_oncall',
                         'customer_dpo',
                         'customer_ferpa_officer',
                         'customer_it_lead',
                         'customer_general_counsel',
                         'customer_ceo'
                       )),
  -- Human-readable label for the role; ships seeded but admins can rename
  -- (e.g. "DPO" → "Privacy Officer" if the customer uses different titles).
  role_label          TEXT NOT NULL,
  -- Display order for both the in-app table and the rendered runbook.
  display_order       INTEGER NOT NULL,
  -- Contact details — all replaceable via PATCH /api/escalation-contacts/:role_key.
  person_name         TEXT NOT NULL,
  email               TEXT NOT NULL,
  -- Stored as free-text to allow customer-specific formats / extensions
  -- (e.g. "+1-555-0142 ext 7" or international formats).
  phone               TEXT NOT NULL,
  -- Free-text notes — context like "First responder. Reachable 24/7
  -- during launch + first 90 days." or any role-specific reminders.
  notes               TEXT NOT NULL DEFAULT '',
  updated_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_escalation_contacts_display_order
  ON escalation_contacts(display_order);

-- ---------------------------------------------------------------------------
-- Mockup seed rows. Phone numbers are in the +1-555-01xx fictional range
-- (FCC-reserved for fictional use, won't dial a real human). Email domains
-- are the IANA-reserved example.com / example.edu ranges per RFC 2606 so
-- the mockup-vs-real check (`*@example.*`) catches them in production.
-- ---------------------------------------------------------------------------

INSERT INTO escalation_contacts
  (role_key, role_label, display_order,
   person_name, email, phone, notes)
VALUES
  ('operator_oncall', 'SaaS operator on-call lead', 1,
   'Jordan Reyes', 'jordan.reyes@universityhub.example.com', '+1-555-0142',
   'First responder. Reachable 24/7 during launch + first 90 days.'),
  ('customer_dpo', 'Customer DPO / privacy officer', 2,
   'Dr. Sam Patel', 'dpo@stanton.example.edu', '+1-555-0188',
   'Owns student-facing FERPA notifications, DOE / state filings.'),
  ('customer_ferpa_officer', 'Customer FERPA officer', 3,
   'Dr. Sam Patel', 'ferpa@stanton.example.edu', '+1-555-0188',
   'Issues student notifications for material breaches. May be the same person as the DPO at smaller institutions.'),
  ('customer_it_lead', 'Customer IT / security lead', 4,
   'Alex Nakamura', 'ciso@stanton.example.edu', '+1-555-0191',
   'Day-of-incident technical counterpart.'),
  ('customer_general_counsel', 'Customer General Counsel', 5,
   'Marisol Greene', 'counsel@stanton.example.edu', '+1-555-0184',
   'Litigation-hold and disclosure decisions.'),
  ('customer_ceo', 'Customer CEO / executive sponsor', 6,
   'Dr. Eleanor Whitaker', 'president@stanton.example.edu', '+1-555-0173',
   'Final-call escalation. Notified for S0 within 24h.');
