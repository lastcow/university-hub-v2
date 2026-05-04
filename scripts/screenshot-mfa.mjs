// Capture screenshots of the UNI-24 MFA UI states using Playwright with
// mocked API routes against the live Vite dev server.
//
// Usage:  node scripts/screenshot-mfa.mjs <base-url>  (e.g. http://127.0.0.1:5176)
//
// Outputs three PNGs into ./screenshots/ :
//   - mfa-credentials.png   sign-in form
//   - mfa-enroll.png        first-time enrollment (QR + recovery codes)
//   - mfa-challenge.png     existing-enrollment challenge
//   - mfa-settings.png      Security & sessions tab in /app/settings

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OUT_DIR = path.resolve("screenshots");
mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE_RECOVERY = [
  "ABCDE-FGHIJ", "KMNPQ-RSTUV", "WXYZ2-34567", "89ABC-DEFGH",
  "JKMNP-QRSTU", "VWXYZ-23456", "789AB-CDEFG", "HJKMN-PQRST",
  "UVWXY-Z2345", "6789A-BCDEF",
];

const SAMPLE_OTPAUTH =
  "otpauth://totp/University%20Hub:superadmin@dev.local?" +
  "secret=JBSWY3DPEHPK3PXP&issuer=University+Hub&algorithm=SHA1&digits=6&period=30";

const SESSION_USER = {
  id: "00000000-0000-0000-0000-00000000aaaa",
  email: "superadmin@dev.local",
  name: "Dev Super Admin",
  role: "super_admin",
  status: "active",
  university_id: null,
};

async function jsonOk(route, data) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
}

async function jsonErr(route, status, code, message) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      ok: false,
      error: { status, code, message },
    }),
  });
}

async function shoot(page, file) {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log("wrote", out);
}

async function captureCredentials(browser) {
  const page = await browser.newPage({
    viewport: { width: 480, height: 720 },
    deviceScaleFactor: 2,
  });
  await page.route("**/api/auth/me", (route) => jsonErr(route, 401, "unauthenticated", ""));
  await page.goto(`${BASE}/sign-in`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', "superadmin@dev.local");
  await page.fill('input[type="password"]', "DevSuperAdmin!2026");
  await shoot(page, "mfa-credentials.png");
  await page.close();
}

async function captureEnroll(browser) {
  const page = await browser.newPage({
    viewport: { width: 520, height: 1100 },
    deviceScaleFactor: 2,
  });
  await page.route("**/api/auth/me", (route) =>
    jsonErr(route, 401, "unauthenticated", ""),
  );
  await page.route("**/api/auth/sign-in", (route) =>
    jsonOk(route, { status: "mfa_required", mfa_enrolled: false }),
  );
  await page.route("**/api/auth/mfa/enroll", (route) =>
    jsonOk(route, {
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_url: SAMPLE_OTPAUTH,
      recovery_codes: SAMPLE_RECOVERY,
    }),
  );

  await page.goto(`${BASE}/sign-in`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', "superadmin@dev.local");
  await page.fill('input[type="password"]', "DevSuperAdmin!2026");
  await page.click('button[type="submit"]');
  // Wait for the enroll step to render its QR + recovery list.
  await page.waitForSelector('img[alt="QR code for your TOTP secret"]', { timeout: 10000 });
  // Settle the QR image network request.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await shoot(page, "mfa-enroll.png");
  await page.close();
}

async function captureChallenge(browser) {
  const page = await browser.newPage({
    viewport: { width: 480, height: 720 },
    deviceScaleFactor: 2,
  });
  await page.route("**/api/auth/me", (route) =>
    jsonErr(route, 401, "unauthenticated", ""),
  );
  await page.route("**/api/auth/sign-in", (route) =>
    jsonOk(route, { status: "mfa_required", mfa_enrolled: true }),
  );
  await page.goto(`${BASE}/sign-in`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', "superadmin@dev.local");
  await page.fill('input[type="password"]', "DevSuperAdmin!2026");
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[autocomplete="one-time-code"]');
  await page.fill('input[autocomplete="one-time-code"]', "123456");
  await shoot(page, "mfa-challenge.png");
  await page.close();
}

async function captureSettings(browser) {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 1500 },
    deviceScaleFactor: 2,
  });
  await page.route("**/api/auth/me", (route) => jsonOk(route, SESSION_USER));
  await page.route("**/api/auth/mfa/status", (route) =>
    jsonOk(route, {
      required: true,
      enrolled: true,
      enabled_at: "2026-04-15T09:32:00.000Z",
      recovery_codes_remaining: 9,
    }),
  );
  await page.route("**/api/settings/mailgun-status", (route) =>
    jsonOk(route, {
      configured: true,
      variables: [
        { key: "MAILGUN_API_KEY",   status: "Configured", value: null, optional: false },
        { key: "MAILGUN_DOMAIN",    status: "Configured", value: null, optional: false },
        { key: "MAILGUN_FROM_EMAIL", status: "Configured", value: null, optional: false },
        { key: "MAILGUN_FROM_NAME", status: "Configured", value: null, optional: false },
        { key: "MAILGUN_REGION",    status: "Configured", value: "US",  optional: false },
      ],
    }),
  );
  await page.route(/\/api\/universities\/.*/, (route) =>
    jsonOk(route, {
      id: "uni-1",
      name: "Demo University",
      slug: "demo-u",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  );

  await page.goto(`${BASE}/app/settings`);
  await page.waitForSelector("text=Security & sessions");
  await page.waitForSelector("text=Two-factor authentication");
  // Scroll the Security card into view for the screenshot.
  await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h3, h2, [data-slot='card-title']"))
      .find((el) => el.textContent?.trim().startsWith("Security"));
    heading?.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.waitForTimeout(300);
  await shoot(page, "mfa-settings.png");
  await page.close();
}

const browser = await chromium.launch({ headless: true });
try {
  await captureCredentials(browser);
  await captureEnroll(browser);
  await captureChallenge(browser);
  await captureSettings(browser);
} finally {
  await browser.close();
}
