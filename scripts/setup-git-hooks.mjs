#!/usr/bin/env node
// setup-git-hooks.mjs — UNI-29.
//
// Points this checkout's git config at the repo-tracked hooks under
// `scripts/git-hooks/`. Runs as the root package's `postinstall` so a
// fresh `npm install` activates the secret-scan hook automatically; on
// CI runners and tarball/degit checkouts (no .git dir) it exits silently.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = "scripts/git-hooks";

// Skip when this is a transitive install (e.g. another project depending on
// this repo) or there's no working git repo to configure.
if (process.env.npm_lifecycle_event === "postinstall" && process.env.INIT_CWD && process.env.INIT_CWD !== REPO_ROOT) {
  process.exit(0);
}
if (!existsSync(resolve(REPO_ROOT, ".git"))) {
  process.exit(0);
}

// Idempotent: only writes if the value is not already correct, so the
// postinstall stays quiet on no-op runs.
const current = spawnSync("git", ["config", "--local", "core.hooksPath"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
if (current.stdout && current.stdout.trim() === HOOKS_DIR) {
  process.exit(0);
}

const set = spawnSync("git", ["config", "--local", "core.hooksPath", HOOKS_DIR], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
if (set.status !== 0) {
  process.stderr.write(
    `setup-git-hooks: could not set core.hooksPath (exit ${set.status}). Pre-commit secret scan is NOT active in this checkout. Run 'git config --local core.hooksPath ${HOOKS_DIR}' manually.\n`,
  );
  // Non-fatal — `npm install` should not break because of an unsupported
  // git environment. The audit/codeql/license workflows still run on PR.
  process.exit(0);
}
process.stdout.write(`setup-git-hooks: core.hooksPath -> ${HOOKS_DIR}\n`);
