import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const installBlockPattern =
  /<!-- paseo-daemon-install:start -->[\s\S]*?<!-- paseo-daemon-install:end -->/;

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/update-daemon-release-install-notes.mjs --repo <owner/repo> --tag <tag>\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    tag: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      args.repo = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      args.tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.repo || !args.tag) {
    usageAndExit();
  }

  return args;
}

function getReleaseBody(repo, tag) {
  const output = execFileSync(
    "gh",
    ["release", "view", tag, "--repo", repo, "--json", "body", "--jq", ".body"],
    { encoding: "utf8" },
  );
  return output.trimEnd();
}

function installBlock(repo, tag) {
  return [
    "<!-- paseo-daemon-install:start -->",
    "### Install daemon from this release",
    "",
    "```sh",
    `curl -fsSL https://github.com/${repo}/releases/download/${tag}/install-paseo-daemon.sh | bash`,
    "```",
    "<!-- paseo-daemon-install:end -->",
  ].join("\n");
}

export function mergeInstallBlock(body, repo, tag) {
  const block = installBlock(repo, tag);
  if (installBlockPattern.test(body)) {
    return body.replace(installBlockPattern, block);
  }
  return `${body.trimEnd()}\n\n${block}\n`;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const body = getReleaseBody(args.repo, args.tag);
  const nextBody = mergeInstallBlock(body, args.repo, args.tag);
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-daemon-release-notes-"));
  const notesPath = path.join(tempDir, `${args.tag}-notes.md`);

  try {
    writeFileSync(notesPath, nextBody);
    execFileSync(
      "gh",
      ["release", "edit", args.tag, "--repo", args.repo, "--notes-file", notesPath],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
