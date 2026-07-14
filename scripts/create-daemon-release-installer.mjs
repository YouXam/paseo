import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

function usageAndExit(code = 1) {
  process.stderr.write(
    [
      "Usage: node scripts/create-daemon-release-installer.mjs --repo <owner/repo> --tag <tag> --bundle <asset.tgz> --out <file>",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    repo: "",
    tag: "",
    bundle: "",
    outFile: "",
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
    if (arg === "--bundle") {
      args.bundle = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out") {
      args.outFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.repo || !args.tag || !args.bundle || !args.outFile) {
    usageAndExit();
  }

  return args;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function createInstaller(args) {
  const repo = shellSingleQuote(args.repo);
  const tag = shellSingleQuote(args.tag);
  const bundle = shellSingleQuote(args.bundle);

  return `#!/usr/bin/env bash
set -euo pipefail

REPO=${repo}
TAG=${tag}
BUNDLE=${bundle}
BASE_URL="\${PASEO_RELEASE_BASE_URL:-https://github.com/\${REPO}/releases/download/\${TAG}}"
ARCHIVE_URL="\${BASE_URL}/\${BUNDLE}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install Paseo daemon tarballs." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

archive_path="$tmp_dir/$BUNDLE"

echo "Downloading $ARCHIVE_URL"
if command -v curl >/dev/null 2>&1; then
  curl \\
    --fail \\
    --location \\
    --retry 5 \\
    --retry-delay 2 \\
    --retry-connrefused \\
    --connect-timeout 30 \\
    --max-time 300 \\
    "$ARCHIVE_URL" \\
    -o "$archive_path"
elif command -v wget >/dev/null 2>&1; then
  wget \\
    --tries=5 \\
    --timeout=30 \\
    -O "$archive_path" \\
    "$ARCHIVE_URL"
else
  echo "curl or wget is required to download Paseo daemon tarballs." >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$tmp_dir"

find_one() {
  local pattern="$1"
  local match
  match="$(find "$tmp_dir/packages" -maxdepth 1 -name "$pattern" -print | sort | head -n 1)"
  if [ -z "$match" ]; then
    echo "Missing package tarball matching $pattern" >&2
    exit 1
  fi
  printf '%s\\n' "$match"
}

tarballs=(
  "$(find_one 'getpaseo-highlight-*.tgz')"
  "$(find_one 'getpaseo-relay-*.tgz')"
  "$(find_one 'getpaseo-protocol-*.tgz')"
  "$(find_one 'getpaseo-client-*.tgz')"
  "$(find_one 'getpaseo-server-*.tgz')"
  "$(find_one 'getpaseo-cli-*.tgz')"
)

npm_args=(install --global)
if [ -n "\${PASEO_NPM_PREFIX:-}" ]; then
  npm_args+=(--prefix "$PASEO_NPM_PREFIX")
fi
npm_args+=("\${tarballs[@]}")

echo "Installing Paseo daemon packages for $TAG"
npm "\${npm_args[@]}"

if [ -n "\${PASEO_NPM_PREFIX:-}" ] && [ -x "$PASEO_NPM_PREFIX/bin/paseo" ]; then
  "$PASEO_NPM_PREFIX/bin/paseo" --version
elif command -v paseo >/dev/null 2>&1; then
  paseo --version
else
  echo "Installed Paseo packages, but paseo is not on PATH." >&2
fi

echo "Paseo daemon packages installed. Restart any running daemon to use the new code."
`;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outFile = path.resolve(args.outFile);
  writeFileSync(outFile, createInstaller(args));
  chmodSync(outFile, 0o755);
  console.log(outFile);
}

main();
