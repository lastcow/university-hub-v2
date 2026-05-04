#!/usr/bin/env node
// Bootstrap the first super_admin against a deployed Worker (epic UNI-1 §35,
// sub-issue UNI-16). Sister command to `node scripts/hash-password.mjs`.
//
// The Worker endpoint at POST /api/bootstrap/super-admin is gated by the
// `BOOTSTRAP_SECRET` env var: it 404s without the secret and 409s once any
// super_admin row exists. This script is just a thin wrapper that prompts
// for the password (reading from a TTY without echoing), supplies the
// Bearer token, and calls the endpoint.
//
// Usage:
//   BOOTSTRAP_SECRET=<secret> node scripts/bootstrap-admin.mjs \
//     --url=https://<worker-host> \
//     --email=admin@example.com \
//     --name="Site Admin" \
//     [--university-name="Example University"] \
//     [--password-env=ADMIN_PASSWORD]
//
// The npm shortcut is `npm run bootstrap:admin -- --url=... --email=...`.
//
// After a successful bootstrap, sign in at <url>/sign-in and (recommended)
// remove the secret with `wrangler secret delete BOOTSTRAP_SECRET` to close
// the door behind you.

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function usage(message) {
  if (message) process.stderr.write(`bootstrap-admin: ${message}\n\n`);
  process.stderr.write(
    [
      "Usage:",
      "  BOOTSTRAP_SECRET=<secret> node scripts/bootstrap-admin.mjs \\",
      "    --url=https://<worker-host> \\",
      "    --email=admin@example.com \\",
      "    --name=\"Site Admin\" \\",
      "    [--university-name=\"Example University\"] \\",
      "    [--password-env=ADMIN_PASSWORD]",
      "",
      "BOOTSTRAP_SECRET must match the wrangler secret of the same name on",
      "the target Worker. After a successful bootstrap, run",
      "`wrangler secret delete BOOTSTRAP_SECRET` to disable the endpoint.",
      "",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

async function readPasswordFromTty(prompt) {
  // Refuses to read a password from a non-TTY stdin to avoid silently
  // logging it from a piped invocation. Use --password-env=NAME for CI.
  if (!process.stdin.isTTY) {
    throw new Error(
      "stdin is not a TTY — pass --password-env=NAME and export the password to that env var instead.",
    );
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (code === 3) {
        cleanup();
        reject(new Error("aborted"));
        return;
      }
      if (code === 13 || code === 10) {
        cleanup();
        resolve(buf);
        return;
      }
      if (code === 127 || code === 8) {
        buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
    };
    stdin.on("data", onData);
  });
}

const args = parseArgs(process.argv);
if (args.help || args.h) usage();

const url = args.url;
const email = args.email;
const name = args.name;
const universityName = args["university-name"] ?? null;
const passwordEnvName = args["password-env"] ?? null;
const secret = process.env.BOOTSTRAP_SECRET;

if (!url) usage("--url is required (e.g. https://university-hub-v2.your-acct.workers.dev)");
if (!email) usage("--email is required");
if (!name) usage("--name is required");
if (!secret) usage("BOOTSTRAP_SECRET env var is required — set it to the wrangler secret of the same name");

let password;
if (passwordEnvName) {
  password = process.env[passwordEnvName];
  if (!password) {
    process.stderr.write(
      `bootstrap-admin: --password-env=${passwordEnvName} is set but the env var is empty\n`,
    );
    process.exit(2);
  }
} else {
  password = await readPasswordFromTty("Password (min 8 chars, will not echo): ");
  const confirm = await readPasswordFromTty("Confirm password: ");
  if (password !== confirm) {
    process.stderr.write("bootstrap-admin: passwords do not match\n");
    process.exit(2);
  }
}

if (password.length < 8) {
  process.stderr.write("bootstrap-admin: password must be at least 8 characters\n");
  process.exit(2);
}

const endpoint = new URL("/api/bootstrap/super-admin", url).toString();
const body = { email, name, password };
if (universityName) body.university_name = universityName;

let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
} catch (cause) {
  process.stderr.write(`bootstrap-admin: request to ${endpoint} failed: ${cause}\n`);
  process.exit(1);
}

let payload = null;
try {
  payload = await response.json();
} catch {
  // ignore — we'll print status + raw text fallback
}

if (!response.ok) {
  const code = payload?.error?.code ?? "unknown";
  const message = payload?.error?.message ?? `HTTP ${response.status}`;
  process.stderr.write(`bootstrap-admin: ${code}: ${message}\n`);
  if (response.status === 404) {
    process.stderr.write(
      "  (404 means BOOTSTRAP_SECRET is not set on the Worker. Run `wrangler secret put BOOTSTRAP_SECRET`.)\n",
    );
  } else if (response.status === 409 && code === "already_bootstrapped") {
    process.stderr.write(
      "  (a super_admin already exists. Use the invitations flow instead, or sign in at /sign-in.)\n",
    );
  }
  process.exit(1);
}

const user = payload?.data?.user;
const universityId = payload?.data?.university_id ?? null;
process.stdout.write(
  [
    "bootstrap-admin: super_admin created.",
    `  email:    ${user?.email}`,
    `  user_id:  ${user?.id}`,
    universityId ? `  univ_id:  ${universityId}` : "  univ_id:  (none — assign one later via /app/universities)",
    "",
    "Recommended next step:",
    "  wrangler secret delete BOOTSTRAP_SECRET",
    "to close the bootstrap endpoint.",
    "",
  ].join("\n"),
);
