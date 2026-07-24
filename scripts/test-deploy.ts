import { deployRepo } from "../src/lib/deploy";

async function main() {
  const repoPath = process.argv[2];
  if (!repoPath) {
    console.error("usage: tsx scripts/test-deploy.ts <repo-url-or-local-path>");
    process.exit(1);
  }

  const result = await deployRepo(repoPath, {}, (msg) => console.log(`[progress] ${msg}`));
  console.log("\nRESULT:", result);

  console.log("\ncurling preview url...");
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(result.previewUrl);
      const body = await res.text();
      console.log(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      if (res.ok) {
        console.log("\nPASS");
        return;
      }
    } catch (e) {
      console.log(`not ready yet (${e}), retrying...`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("\nFAIL -- never got a 2xx response");
  process.exit(1);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
