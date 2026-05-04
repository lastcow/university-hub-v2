// Default ToS and Privacy Policy boilerplate (epic UNI-21 / sub-issue
// UNI-34).
//
// This is the *opinionated FERPA-aligned starting point* the issue body
// asks for: serviceable text every customer falls back to until their
// counsel reviews and overrides it via the Legal tab in `/app/settings`.
// Two placeholder fields are templated at render time:
//
//   {{university_name}}  → the customer university's display name (or a
//                          generic phrase when the document is being
//                          read with no university context, e.g. a
//                          super_admin viewing the global default).
//   {{contact_email}}    → the configured `SUPPORT_EMAIL` env var, or
//                          a generic mailto: hint when not set.
//
// The body is markdown — the SPA renders a small subset (headings,
// paragraphs, bullet lists, links, emphasis). Anything more elaborate
// (tables, embedded HTML) is intentionally out of scope: customers who
// need richer formatting can take the boilerplate as a starting point
// and edit it in their own counsel-reviewed copy.

import type { LegalDocumentKind } from "@university-hub/shared";

export const DEFAULT_TERMS_MD = `# Terms of Service

_Last updated: see the version label below the document title._

## 1. Acceptance

By creating an account at {{university_name}} ("we", "us", "our") on the University Hub platform, you ("you", "your") agree to these Terms of Service and our [Privacy Policy](/privacy). If you do not agree, do not create an account or use the service.

## 2. Eligibility

You may use the service only to perform tasks delegated to you by {{university_name}} (e.g. teaching, learning, administration, reporting). The service is intended for use by faculty, staff, students, and authorised guests of {{university_name}}.

## 3. Acceptable Use

You agree not to:

- attempt to access another user's records without authorisation
- share your account credentials, including your password or recovery codes
- automate or scrape the service in a way that disrupts other users
- upload malware, illegal content, or content you do not have the right to share
- impersonate another person or misrepresent your role

We may suspend or terminate access for any violation. Violations involving student records may also be reported to {{university_name}} and, where appropriate, to law enforcement.

## 4. Account Responsibilities

You are responsible for keeping your password and any recovery codes confidential. Notify {{university_name}} immediately at {{contact_email}} if you believe your account has been accessed without your permission.

## 5. Customer (University) Responsibilities — FERPA Compliance

These Terms are layered: {{university_name}} is the institution responsible under the **Family Educational Rights and Privacy Act (FERPA, 20 U.S.C. § 1232g)** for the education records it stores using University Hub. The platform provides:

- per-course access scoping (faculty see only the courses they teach)
- record-of-access logging for grade views (FERPA § 99.32)
- written-consent tracking for disclosures (FERPA § 99.30)
- directory-information opt-out support
- under-18 / parent-guardian access controls
- audit logging on all administrative changes

{{university_name}} is responsible for:

- determining which staff need which roles, and reviewing those role assignments periodically
- collecting and reviewing FERPA written consent before authorising any disclosure of education records to a third party
- responding to student / parent requests to inspect or amend records, in accordance with FERPA and institutional policy
- notifying affected individuals in the event of a confirmed breach
- training its staff on FERPA obligations before granting access

## 6. Service Availability

We aim for high availability but do not warrant uninterrupted access. Scheduled maintenance and infrastructure upgrades may briefly suspend the service.

## 7. Termination

You may stop using the service at any time. {{university_name}} may revoke your access at any time. We may take down accounts that violate these Terms. Education records you produced during your association with {{university_name}} remain with {{university_name}} and are subject to the institution's retention schedule.

## 8. Changes to These Terms

We may update these Terms. Material changes will trigger a re-acceptance prompt the next time you sign in; minor edits (typos, clarifications) may be applied silently. The version label below the document title indicates which version is currently in force.

## 9. Contact

Questions about these Terms: {{contact_email}}
`;

export const DEFAULT_PRIVACY_MD = `# Privacy Policy

_Last updated: see the version label below the document title._

This Privacy Policy explains what {{university_name}} ("we", "us", "our") collects when you use the University Hub platform, how we use it, who we share it with, and your rights under FERPA and applicable state law.

## 1. Information We Collect

When you accept an invitation, we collect:

- your name, work / school email address, and role
- the password hash for your account (we never store the plaintext password)
- your sign-in events (timestamp, IP address truncated to a /24, user-agent excerpt)
- two-factor authentication metadata for administrators (TOTP secret hash, recovery-code hashes — not the codes themselves)

While you use the platform, we additionally collect operational records: courses you teach or take, grades you author or receive, attendance you log, and the audit trail of administrative actions you perform.

## 2. How We Use Information

We use the information to:

- authenticate you and authorise your actions
- protect against credential-stuffing, password-reset abuse, and other attacks (rate-limit counters, sign-in audit trail)
- run the academic functions you signed up for (grades, analytics, communications)
- comply with our legal obligations under FERPA and other applicable law

## 3. FERPA Disclosure

University Hub stores **education records** as defined by FERPA. Specifically:

- **What we collect**: enrolment, course assignments, grades, assessment scores, attendance, and audit metadata about access to those records.
- **What we release**: under FERPA's "school official" exception, education records are visible to {{university_name}} staff with a legitimate educational interest, scoped to the courses they are assigned to. Releases to third parties (parents, employers, transfer institutions, etc.) require your prior written consent under FERPA § 99.30 — we record both the consent and each subsequent release.
- **Retention**: education records are retained for the lifetime of the student record, with archival to a separate shadow table after seven years post-graduation; audit and disclosure logs are retained for seven years to satisfy FERPA's record-of-access requirement (see [docs/data-retention.md](https://github.com/lastcow/university-hub-v2/blob/main/docs/data-retention.md)).
- **Who has access**: scoped by role and per-course assignment. Faculty see only their own courses' records; admins see only their own university; cross-university access is structurally impossible (each customer is a separate deploy).
- **Inspecting and amending your record**: students 18 or older (and parents/guardians of under-18 students) may request to inspect or amend their education record by contacting {{contact_email}}. We respond within the timeframe required by FERPA and institutional policy.
- **Directory information**: by default we treat name, role, and university as directory information. You may opt out via your profile settings; we will not release directory information about you to third parties after that point.

## 4. Cookies

We use a single first-party HTTP-only session cookie to keep you signed in, plus a short-lived MFA-challenge cookie when you complete two-factor authentication. We do not use third-party tracking cookies, advertising cookies, or analytics pixels.

## 5. Sharing With Third Parties

We do not sell your information. Information is shared with:

- the cloud infrastructure providers we run on (Cloudflare for hosting, Mailgun for transactional email — see their respective sub-processor commitments)
- third parties named in a FERPA-compliant written consent that you have signed (or, for under-18 students, your parent or guardian has signed)

## 6. Security

Data is encrypted in transit (HTTPS) and at rest (Cloudflare D1 default encryption). Passwords are hashed with PBKDF2. We rate-limit authentication attempts and store record-of-access logs for forensic review.

## 7. Your Rights

You may at any time:

- request to inspect, amend, or receive an export of your records (contact {{contact_email}})
- opt out of directory-information disclosures via profile settings
- revoke any FERPA written consent you previously granted

## 8. Changes to This Policy

We may update this Policy. The version label below the document title indicates which version is in force; material changes are surfaced through a re-acceptance prompt at next sign-in.

## 9. Contact

FERPA inquiries and any other privacy questions: {{contact_email}}
`;

export interface RenderTemplateInput {
  university_name: string | null;
  contact_email: string | null;
}

const FALLBACK_UNIVERSITY = "your university";
const FALLBACK_CONTACT = "your university registrar";

/**
 * Replace `{{university_name}}` and `{{contact_email}}` placeholders.
 * Used by both the public-page render path and the admin tab so the
 * default boilerplate previews as it will look to end users.
 */
export function renderLegalTemplate(
  body: string,
  vars: RenderTemplateInput,
): string {
  const universityName = vars.university_name?.trim() || FALLBACK_UNIVERSITY;
  const contactEmail = vars.contact_email?.trim() || FALLBACK_CONTACT;
  return body
    .replaceAll("{{university_name}}", universityName)
    .replaceAll("{{contact_email}}", contactEmail);
}

export function defaultBodyForKind(kind: LegalDocumentKind): string {
  return kind === "terms" ? DEFAULT_TERMS_MD : DEFAULT_PRIVACY_MD;
}
