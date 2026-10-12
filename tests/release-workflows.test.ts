import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function text(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

test("CI covers minimum Node 22 on three OSes and Linux Node 24 release gates", async () => {
  const workflow = await text(".github/workflows/ci.yml");

  for (const entry of [
    ["ubuntu-latest", "22.0.0"],
    ["macos-latest", "22.0.0"],
    ["windows-latest", "22.0.0"],
    ["ubuntu-latest", "24"],
  ] as const) {
    assert.match(
      workflow,
      new RegExp(`os:\\s*${entry[0]}[\\s\\S]{0,120}node:\\s*["']?${entry[1].replaceAll(".", "\\.")}`),
      `${entry.join(" / ")} fehlt`,
    );
  }
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run check:package/);
  assert.match(
    workflow,
    /ORCODE_PACKAGE_VERSION=\$\(node -p [\s\S]{0,100}package\.json[\s\S]{0,100}version[\s\S]{0,20}\)/,
  );
  assert.match(workflow, /npm run check:release -- --tag "v\$\{ORCODE_PACKAGE_VERSION\}"/);
  assert.match(workflow, /npm run test:migration/);
  assert.match(workflow, /npm run test:release-regressions/);
  assert.match(workflow, /npm run test:pty/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /git diff --check/);
});

test("release publishing is manual OIDC-only and verifies the selected tag", async () => {
  const workflow = await text(".github/workflows/release.yml");
  const verifyStart = workflow.indexOf("  verify:");
  const publishStart = workflow.indexOf("  publish:");
  assert.ok(verifyStart >= 0 && publishStart > verifyStart);
  const verifyJob = workflow.slice(verifyStart, publishStart);
  const publishJob = workflow.slice(publishStart);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tag:/);
  assert.doesNotMatch(workflow, /push:\s*[\s\S]{0,100}tags:/);
  assert.doesNotMatch(verifyJob, /id-token:\s*write|environment:\s*npm-production/);
  assert.match(verifyJob, /npm run check:package -- --output release-artifact/);
  assert.match(
    verifyJob,
    /actions\/upload-artifact@[0-9a-f]{40}[\s\S]{0,240}path:\s*release-artifact/,
  );

  assert.match(publishJob, /needs:\s*verify/);
  assert.match(verifyJob, /github\.ref_protected/);
  assert.match(publishJob, /github\.ref_protected/);
  assert.match(
    publishJob,
    /github\.ref\s*==\s*format\(['"]refs\/tags\/\{0\}['"],\s*inputs\.tag\)/,
  );
  assert.match(
    publishJob,
    /github\.workflow_ref\s*==\s*format\(['"]dkay95\/orcode\/\.github\/workflows\/release\.yml@refs\/tags\/\{0\}['"],\s*inputs\.tag\)/,
  );
  assert.match(publishJob, /environment:\s*npm-production/);
  assert.match(publishJob, /id-token:\s*write/);
  assert.match(publishJob, /node-version:\s*["']?24\.17\.0/);
  assert.match(publishJob, /npm --version/);
  assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(publishJob, /actions\/checkout|npm ci|npm install/);
  assert.match(verifyJob, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(verifyJob, /git\s+rev-parse\s+HEAD[\s\S]{0,80}GITHUB_SHA/);
  assert.doesNotMatch(verifyJob, /ref:\s*refs\/tags\/\$\{\{\s*inputs\.tag\s*\}\}/);
  assert.match(workflow, /ORCODE_RELEASE_TAG:\s*\$\{\{\s*inputs\.tag\s*\}\}/);
  assert.match(workflow, /npm run check:release/);
  assert.match(publishJob, /package\/package\.json/);
  assert.match(publishJob, /packedManifest\.name\s*!==\s*["']orcode["']/);
  assert.match(publishJob, /packedManifest\.version\s*!==\s*tag\.slice\(1\)/);
  assert.match(
    publishJob,
    /packedManifest\.repository\?\.url\s*!==\s*["']git\+https:\/\/github\.com\/dkay95\/orcode\.git["']/,
  );
  assert.match(publishJob, /packedManifest\.private\s*!==\s*undefined[\s\S]{0,80}packedManifest\.private\s*!==\s*false/);
  assert.match(publishJob, /packedManifest\.bin\?\.orcode[\s\S]{0,160}packedManifest\.bin\?\.routercode/);
  assert.match(publishJob, /npm publish [^\n]+ --access public/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});

test("release documentation does not claim an unpublished or stale runtime contract", async () => {
  const readme = await text("README.md");
  const changelog = await text("CHANGELOG.md");

  assert.match(readme, /first registry publication|erste Registry-Veröffentlichung/i);
  assert.match(readme, /Trusted Publishing|OIDC/);
  assert.match(readme, /required\s+reviewer|erforderliche(?:n|r)?\s+Reviewer/i);
  assert.match(readme, /prevent\s+self-review|eigene\s+Freigabe/i);
  assert.match(readme, /distinct\s+trusted[\s\S]{0,80}(maintainer|release\s+bot)/i);
  assert.match(readme, /sole-owner[\s\S]{0,100}not\s+release-authorized/i);
  assert.match(readme, /deployment\s+refs?[\s\S]{0,80}v\*/i);
  assert.match(readme, /two\s+separate[\s\S]{0,100}tag\s+rulesets|zwei\s+getrennte[\s\S]{0,100}tag-regelsätze/i);
  assert.match(readme, /creation[\s\S]{0,120}owner[\s\S]{0,160}update[\s\S]{0,80}delete[\s\S]{0,100}no\s+bypass/i);
  assert.match(await text(".github/workflows/release.yml"), /two\s+separate[\s\S]{0,120}creation[\s\S]{0,120}update\/delete[\s\S]{0,80}no\s+bypass/i);
  assert.doesNotMatch(readme, /owner-created immutable|immutable `v\*` tags/i);
  assert.match(readme, /gh\s+workflow\s+run\s+release\.yml[\s\S]{0,120}--ref\s+["']?\$TAG["']?[\s\S]{0,80}-f\s+tag=["']?\$TAG["']?/i);
  assert.doesNotMatch(readme, /use\s+workflow\s+from/i);
  assert.match(readme, /valid but unfunded|gültig.*kein.*Guthaben/i);
  assert.match(readme, /compressor.*never receives.*current prompt|Kompressor.*aktuellen Prompt.*nicht/is);
  assert.doesNotMatch(readme, /legacy pre-multi-chat session files, left untouched/i);
  assert.doesNotMatch(changelog, /commands are shipped/i);
  assert.match(changelog, /OIDC|Trusted Publishing/);
});
