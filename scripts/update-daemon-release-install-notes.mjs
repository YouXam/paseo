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

function getRelease(repo, tag) {
  const output = execFileSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`], {
    encoding: "utf8",
  });
  const release = JSON.parse(output);
  if (typeof release?.id !== "number") {
    throw new Error(`Release ${tag} in ${repo} did not include a numeric id.`);
  }
  return release;
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
  const existing = body.trimEnd();
  return `${existing ? `${existing}\n\n` : ""}${block}\n`;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const release = getRelease(args.repo, args.tag);
  const body = typeof release.body === "string" ? release.body : "";
  const nextBody = mergeInstallBlock(body, args.repo, args.tag);
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-daemon-release-notes-"));
  const notesPath = path.join(tempDir, `${args.tag}-notes.md`);

  try {
    writeFileSync(notesPath, nextBody);
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `repos/${args.repo}/releases/${release.id}`,
        "-F",
        `body=@${notesPath}`,
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
