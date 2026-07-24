/**
 * Deletes leftover sandboxes. Daytona enforces a total disk quota (30GiB on
 * the free tier) and a failed/abandoned sandbox still counts against it, so a
 * few test runs can exhaust the quota and make every subsequent create fail
 * with a misleading "build_failed".
 *
 *   pnpm exec tsx scripts/cleanup-sandboxes.ts
 */
import { Daytona } from "@daytona/sdk";

async function main() {
  const daytona = new Daytona();

  // list() is an async iterator, not an array.
  let total = 0;
  let deleted = 0;
  for await (const sandbox of daytona.list()) {
    total++;
    try {
      await sandbox.delete();
      deleted++;
      console.log(`deleted ${sandbox.id}`);
    } catch (err) {
      console.log(`could not delete ${sandbox.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\ndeleted ${deleted}/${total}`);
}

main();
