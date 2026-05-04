-- 0012_escalation_contacts_general_counsel_phone_fix.sql
--
-- Convergence fix for the general-counsel seed phone (UNI-42 follow-up to
-- UNI-40).
--
-- Background. The 0011 seed used `+1-555-0205` for the general-counsel
-- contact, which sits *outside* the +1-555-01xx mockup range that 0011's
-- own header advertises and that the Worker's `MOCKUP_PHONE_RE` actually
-- matches. The row still flagged `is_mockup=true` because the seeded
-- email matches `*@example.edu`, so the launch-blocker banner kept firing
-- and the test suite stayed green — but the seed contradicted its own
-- contract, and a customer skim-reading the runbook could in theory dial
-- 555-0205 (which is real-allocatable, not in the FCC fictional block).
--
-- 0011 has been amended to seed `+1-555-0184`. This follow-up converges
-- already-deployed environments where the row still carries the original
-- value. We only touch the row when it still looks untouched (phone is
-- exactly `+1-555-0205` and the email is still the seeded mockup) so we
-- never overwrite a customer's real General Counsel phone if they edited
-- the row downstream from the buggy default.
--
-- Audit: this is a schema-time convergence, not a user edit, so we
-- intentionally do NOT write an `escalation.contact_updated` row. The
-- audit log is the durable record of admin edits; migrations are not
-- admin edits.

PRAGMA foreign_keys = ON;

UPDATE escalation_contacts
   SET phone = '+1-555-0184',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE role_key = 'customer_general_counsel'
   AND phone = '+1-555-0205'
   AND email = 'counsel@stanton.example.edu';
