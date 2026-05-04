// Regression guard for the escalation-contacts seed (UNI-42).
//
// 0011's header contract — and the Worker's `MOCKUP_PHONE_RE` regex —
// treat `+1-555-01xx` as the mockup phone signature. UNI-42 caught the
// general-counsel row drifting outside that range (`+1-555-0205`), where
// the email regex was the only thing keeping `is_mockup=true`. This test
// scans the seed INSERT rows in 0011 and asserts every phone matches the
// FCC fictional `+1-555-01xx` shape so the contract can't drift again.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SEED_SQL_PATH = resolve(
  REPO_ROOT,
  "migrations/0011_escalation_contacts.sql",
);
const FOLLOWUP_SQL_PATH = resolve(
  REPO_ROOT,
  "migrations/0012_escalation_contacts_general_counsel_phone_fix.sql",
);

const MOCKUP_PHONE_SHAPE = /^\+1-555-01\d{2}$/;

function extractSeedPhones(sql: string): string[] {
  // Pull the INSERT INTO escalation_contacts (...) VALUES (...); block and
  // grab every quoted +1-555-... phone literal inside it. Robust to
  // formatting tweaks as long as the values stay quoted.
  const match = sql.match(
    /INSERT\s+INTO\s+escalation_contacts[\s\S]*?VALUES([\s\S]*?);/i,
  );
  if (!match) return [];
  const body = match[1]!;
  const phones: string[] = [];
  for (const m of body.matchAll(/'(\+1-[^']+)'/g)) {
    phones.push(m[1]!);
  }
  return phones;
}

describe("escalation-contacts seed phones", () => {
  const seedSql = readFileSync(SEED_SQL_PATH, "utf8");
  const phones = extractSeedPhones(seedSql);

  it("finds the six seeded phone literals in 0011", () => {
    expect(phones.length).toBe(6);
  });

  it("seeds every row with a phone in the +1-555-01xx mockup range", () => {
    for (const phone of phones) {
      expect(phone, `seed phone ${phone} is outside +1-555-01xx`).toMatch(
        MOCKUP_PHONE_SHAPE,
      );
    }
  });

  it("0012 converges any deployed +1-555-0205 row to a +1-555-01xx phone", () => {
    const followup = readFileSync(FOLLOWUP_SQL_PATH, "utf8");
    expect(followup).toMatch(/phone\s*=\s*'(\+1-555-01\d{2})'/);
    expect(followup).toMatch(/phone\s*=\s*'\+1-555-0205'/);
    expect(followup).toMatch(/role_key\s*=\s*'customer_general_counsel'/);
  });
});
