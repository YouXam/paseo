import assert from "node:assert/strict";
import test from "node:test";
import { mergeInstallBlock } from "./update-daemon-release-install-notes.mjs";

const repo = "YouXam/paseo";
const tag = "v0.3.0-beta.2";

test("appends the daemon install block to release notes", () => {
  const notes = mergeInstallBlock("## Release notes\n", repo, tag);

  assert.match(notes, /## Release notes/);
  assert.match(notes, /<!-- paseo-daemon-install:start -->/);
  assert.match(
    notes,
    /https:\/\/github\.com\/YouXam\/paseo\/releases\/download\/v0\.3\.0-beta\.2\/install-paseo-daemon\.sh/,
  );
});

test("replaces an existing daemon install block without duplicating it", () => {
  const original = mergeInstallBlock("## Release notes\n", repo, "v0.2.3");
  const updated = mergeInstallBlock(original, repo, tag);

  assert.equal(updated.match(/paseo-daemon-install:start/g)?.length, 1);
  assert.doesNotMatch(updated, /download\/v0\.2\.3/);
  assert.match(updated, /download\/v0\.3\.0-beta\.2/);
});
