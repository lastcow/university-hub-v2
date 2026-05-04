-- 0002_email_logs.sql
--
-- Email delivery log (epic UNI-1 §13, §16, §18). Every Mailgun call records a
-- row here — successful or failed. The `/app/email-logs` admin page reads from
-- this table.
--
-- `type` matches the email service module functions (epic §13):
--   invitation, invitation_resend, welcome, password_reset,
--   contact_notification, account_status_changed
--
-- `related_entity_type` / `related_entity_id` link a log row back to the thing
-- that triggered it (e.g. type=invitation -> related_entity_type='invitation',
-- related_entity_id=<invitation uuid>).

PRAGMA foreign_keys = ON;

CREATE TABLE email_logs (
  id                   TEXT PRIMARY KEY,
  university_id        TEXT REFERENCES universities(id) ON DELETE SET NULL,
  recipient_email      TEXT NOT NULL,
  type                 TEXT NOT NULL
                       CHECK (type IN (
                         'invitation','invitation_resend','welcome',
                         'password_reset','contact_notification',
                         'account_status_changed'
                       )),
  template_name        TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('sent','failed','pending')),
  mailgun_message_id   TEXT,
  error                TEXT,
  related_entity_type  TEXT,
  related_entity_id    TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_email_logs_university_id    ON email_logs(university_id);
CREATE INDEX idx_email_logs_recipient_email  ON email_logs(recipient_email);
CREATE INDEX idx_email_logs_type             ON email_logs(type);
CREATE INDEX idx_email_logs_status           ON email_logs(status);
CREATE INDEX idx_email_logs_related_entity   ON email_logs(related_entity_type, related_entity_id);
CREATE INDEX idx_email_logs_created_at       ON email_logs(created_at);
