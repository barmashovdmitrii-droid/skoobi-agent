Synthetic elevator user journey

The player crosses a shaft, calls and waits for a cabin, transports one resource
to the upper level, and continues into the next area. Keyboard and click actions
drive a small visible state machine with asynchronous movement. Delivery and
continuation controls are guarded by actual cabin position/inventory state.

The good ZIP must complete all four steps. Missing-call and stuck-cabin variants
retain the same packaged files but fail the second browser step. File existence
or a successful source build cannot mark either broken scenario passed.

Run only in an isolated checkout with the declared Chromium installed and core
built:

  scripts/with-node22.sh node evals/task-continuity/artifact-acceptance/elevator/run.mjs

The evaluator uses the shipped isolated-job controller, real browser checker,
authentic signed receipts, and the same delivery gate. A failed scenario gets no
deliverable snapshot. Unsupported isolation platforms return inconclusive.
The core elevator-artifact-acceptance.test.ts suite runs these regressions in CI
where the macOS containment boundary is available. No production game, private
asset, user conversation or external message is used. Passing the declared
journey is not human acceptance or a claim about every possible interaction.
