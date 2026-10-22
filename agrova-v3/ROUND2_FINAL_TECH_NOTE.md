# Agrova Round 2 — Technical Note

1. Extends the existing Node.js 22, SQLite and vanilla JavaScript Round 1 codebase.
2. The additive evidence_versions table stores verification and correction history.
3. First verification creates Version 1; each correction appends another version.
4. SQLite triggers prevent changes or deletion to existing evidence versions.
5. Latest verification is selected by version_number DESC for both evidence kinds.
6. Reconciliation and the farmer ledger derive their values from the latest versions.
7. A correction after review reopens the delivery as needs_review.
8. The settlement screen shows newest-first version history with reason, actor, time and a current marker.
9. Correction audit events show previous kg, new kg, actor and reason.
10. Manager-only correction APIs enforce reason and kg validation; buyers receive 403.

Tests: npm test; node scripts/check-ui-render.mjs; npm run smoke:isolated.
