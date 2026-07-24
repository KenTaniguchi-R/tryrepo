/**
 * Snapshots each trending repo's README + manifests to disk so the eval can
 * run offline. Without this, every eval run would re-clone 20 repos and score
 * network flakiness as if it were model error.
 *
 * Re-run only when the repo list changes:
 *   pnpm exec tsx evals/snapshot-fixtures.ts
 */
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import trending from "../src/data/trending-repos.json";
import { cloneRepo, normalizeRepoUrl, readRepoContext } from "../src/lib/repo";

const OUT = join(process.cwd(), "evals", "fixtures.json");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(join(process.cwd(), "evals"), { recursive: true });
  const fixtures = [];

  for (const repo of trending.repos) {
    const url = normalizeRepoUrl(repo.url);
    process.stdout.write(`${repo.name}... `);
    let workDir: string | undefined;
    try {
      workDir = await cloneRepo(url);
      fixtures.push({
        name: repo.name,
        repoUrl: url,
        language: repo.language,
        hasDockerfile: await fileExists(join(workDir, "Dockerfile")),
        context: await readRepoContext(workDir),
      });
      console.log("ok");
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  await writeFile(OUT, JSON.stringify(fixtures, null, 2), "utf8");
  console.log(`\nwrote ${fixtures.length} fixtures -> ${OUT}`);
}

main();
