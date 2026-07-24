import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MANIFEST_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  ".env.example",
  ".env.sample",
  "docker-compose.yml",
  "docker-compose.yaml",
];
const README_NAMES = ["README.md", "README", "README.rst", "Readme.md"];
const MAX_CHARS_PER_FILE = 4000;

export function normalizeRepoUrl(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("git@") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("/")
  ) {
    return trimmed;
  }
  // allow shorthand like "owner/repo"
  return `https://github.com/${trimmed}.git`;
}

export async function cloneRepo(repoUrl: string): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "tryrepo-"));
  await execFileAsync("git", ["clone", "--depth", "1", repoUrl, workDir], {
    timeout: 60_000,
  });
  return workDir;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).slice(0, MAX_CHARS_PER_FILE);
  } catch {
    return null;
  }
}

/**
 * Assembles the README + manifest files an LLM needs to reason about how a
 * repo is meant to be built, run, and configured.
 */
export async function readRepoContext(workDir: string): Promise<string> {
  const files = await readdir(workDir);
  const sections: string[] = [`Root directory listing:\n${files.join("\n")}`];

  for (const name of README_NAMES) {
    const content = await readIfExists(join(workDir, name));
    if (content) {
      sections.push(`--- ${name} ---\n${content}`);
      break;
    }
  }

  for (const name of MANIFEST_FILES) {
    const content = await readIfExists(join(workDir, name));
    if (content) sections.push(`--- ${name} ---\n${content}`);
  }

  return sections.join("\n\n");
}
