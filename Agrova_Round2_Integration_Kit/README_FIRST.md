# Agrova Round 2 — One-shot local integration kit

This kit is intended to be **copied into your existing Git repository**. It is not a replacement project, and it deliberately does **not** include anyone's SQLite databases, tokens, or accounts.

## Reviewed sources (22 October 2026)

- Main: `cf2345108b8e9501314003a16fd5ff01dd66fff0` — Round 1 merges and the feature-3 evidence-versioning PR.
- Round 2: `0993656346ee0f29982695d6d4a9ea02084497e0` — 12 stage commits plus the independent audited-version schema, migrations, storage and newest-version reconciliation commits.
- These branches diverged and both implemented evidence versioning differently. **Do not blindly merge them.** The patch uses the Round 2 branch as the single runtime implementation, retaining all shared prior contributors' commits and keeping main's competing version helper out of the runtime.

## Steps (Windows)

1. Open your local folder **Agrova-INNOVATRIX** (the folder containing `.git` and `agrova-v3`). Make sure you have Node 22+ and Git. **Do not delete your existing repo or storage folder.**
2. Extract this entire `Agrova_Round2_Integration_Kit` folder into the repo root.
3. Commit/stash any existing **tracked** uncommitted changes before running. The installer stops rather than overwriting them.
4. Open PowerShell in the repo root and run:

   `powershell -NoProfile -ExecutionPolicy Bypass -File .\Agrova_Round2_Integration_Kit\SETUP-WINDOWS.ps1`

5. The installer fetches the reviewed commit, creates `round2-final-integration`, uses the already integrated settlement version-history UI, adds manager display names, and formats correction audit details, and runs the full tests / UI checks / disposable smoke suite. It does **not** make a commit or push.
6. Inspect the diff with `git diff` and ensure the tests have passed. Then run:

   ```sh
   git add agrova-v3/public/app.js agrova-v3/server.mjs agrova-v3/scripts/check-ui-render.mjs agrova-v3/ROUND2_FINAL_TECH_NOTE.md
   git commit -m "feat(round2): integrate audited evidence history UI and full settlement review"
   git push -u origin round2-final-integration
   ```

7. Submit the final commit hash and branch URL, your test output and 3-minute screen recording. Don't claim the build passes if the installer reports a failure.

## Why this integration strategy?

`main` contains a contributor's alternative `evidence_versions` implementation with conflicting db helpers and schema. `round2-corrections` already contains the shared Round 1 project, manager-only correction, reason validation, append-only history triggers, migration, versioned recalculation and tests. Combining both competing schemas would break the app. This kit completes the display and audit presentation on that single tested line of development.

## What it covers

- Both inspection and buyer corrections; manager-only enforcement and buyer 403 from the existing Round 2 backend
- First verification without a correction reason; later reason validation and bad kg rejection
- Append-only immutable versions, with migration of existing verified evidence
- Latest version drives settlement, discrepancy and farmer ledger
- Reviewed deliveries reopen after corrections
- Newest-first history with current marker, reason, manager and time
- Audit event formatted with old and new accepted kg and reason
- Test suite, UI checks and the original ₹48-smoke demo in an isolated database

**Limitation:** Since GitHub's connector can read repository files here but cannot supply a binary clone to the execution container, the complete source has not been run in this sandbox. This kit performs the actual full run **on your local repository before any push** and stops on any failures. The integration script itself was syntax-checked here.
