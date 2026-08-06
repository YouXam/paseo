import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const daemonWorkspaces = [
  "@getpaseo/highlight",
  "@getpaseo/relay",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/server",
  "@getpaseo/cli",
];

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/build-daemon-release-assets.mjs --tag <tag> --out <dir>\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    tag: "",
    outDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out") {
      args.outDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.tag || !args.outDir) {
    usageAndExit();
  }

  return args;
}

function parseNpmPackOutput(output, workspace) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output for ${workspace}: ${output}`);
  }
  return parsed[0];
}

function packWorkspace(workspace, packagesDir) {
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      `--workspace=${workspace}`,
      "--pack-destination",
      packagesDir,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return parseNpmPackOutput(output, workspace);
}

function packageJsonPathForWorkspace(workspace) {
  const packageName = workspace.replace("@getpaseo/", "");
  return path.join("packages", packageName, "package.json");
}

function buildDaemonReleaseAssets(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outDir = path.resolve(args.outDir);
  const packagesDir = path.join(outDir, "packages");
  const bundleName = `paseo-daemon-npm-tarballs-${args.tag}.tgz`;
  const bundlePath = path.join(outDir, bundleName);

  rmSync(packagesDir, { force: true, recursive: true });
  mkdirSync(packagesDir, { recursive: true });

  const packages = [];
  for (const workspace of daemonWorkspaces) {
    const packageJson = JSON.parse(readFileSync(packageJsonPathForWorkspace(workspace), "utf8"));
    const packed = packWorkspace(workspace, packagesDir);
    packages.push({
      name: packageJson.name,
      version: packageJson.version,
      workspace,
      filename: packed.filename,
    });
  }

  const manifest = {
    tag: args.tag,
    generatedAt: new Date().toISOString(),
    installOrder: daemonWorkspaces,
    packages,
  };
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  rmSync(bundlePath, { force: true });
  execFileSync("tar", ["-czf", bundlePath, "-C", outDir, "manifest.json", "packages"], {
    stdio: "inherit",
  });

  console.log(bundlePath);
}

buildDaemonReleaseAssets();
