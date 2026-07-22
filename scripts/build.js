#!/usr/bin/env node
// scripts/build.js
//
// Packages the loadable extension into dist/tab-agent-<version>.zip.
//
// Usage:
//   node scripts/build.js            — zip using the version already in manifest.json
//   node scripts/build.js 1.4.0      — sync manifest.json + package.json to 1.4.0, then zip
//
// The version arg form is how semantic-release drives this (see .releaserc.json's
// @semantic-release/exec prepareCmd: `node scripts/build.js ${nextRelease.version}`).
// semantic-release computes versions like "1.4.0" or occasionally a prerelease such
// as "1.4.0-beta.1" on a prerelease branch; Chrome's manifest "version" field only
// accepts 1-4 dot-separated integers, so we strip any -prerelease/+build suffix
// before writing it there (package.json keeps the full semver as usual).

const fs = require("fs");
const path = require("path");
// archiver v8's CJS interop exposes named exports (ZipArchive class), not
// the old v5/v6/v7 `archiver(format, opts)` factory function — see
// https://www.archiverjs.com/ "Quick Start" for the current API.
const { ZipArchive } = require("archiver");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");

// Exactly what a `chrome://extensions` "Load unpacked" needs — nothing from
// the dev toolchain (tests, configs, node_modules, the docs/ landing page)
// ships in the zip. The one exception is docs/privacy-policy.html: the
// Options page links to it directly (Privacy tab) so the policy is always
// reachable from inside the extension, even offline or before GitHub Pages
// is set up - so that one file rides along despite living under docs/.
const INCLUDE = ["manifest.json", "background.js", "content.js", "options.html", "options.css", "options.js", "sidepanel.html", "sidepanel.css", "sidepanel.js", "icons", "lib"];
const INCLUDE_FILES_FROM_EXCLUDED_DIRS = ["docs/privacy-policy.html"];

function toManifestVersion(semver) {
  // Chrome requires 1-4 dot-separated non-negative integers, no -/+ suffix.
  return semver.split(/[-+]/)[0];
}

function syncVersion(semver) {
  const manifestVersion = toManifestVersion(semver);

  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = manifestVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = semver;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`Synced version -> manifest.json: ${manifestVersion}, package.json: ${semver}`);
}

function currentManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  return manifest.version;
}

async function zipExtension(zipVersion) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, `tab-agent-${zipVersion}.zip`);
  const output = fs.createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);
  for (const entry of INCLUDE) {
    const fullPath = path.join(ROOT, entry);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`build.js: expected file/dir missing: ${entry}`);
    }
    if (fs.statSync(fullPath).isDirectory()) {
      archive.directory(fullPath, entry);
    } else {
      archive.file(fullPath, { name: entry });
    }
  }
  for (const entry of INCLUDE_FILES_FROM_EXCLUDED_DIRS) {
    const fullPath = path.join(ROOT, entry);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`build.js: expected file missing: ${entry}`);
    }
    archive.file(fullPath, { name: entry });
  }
  await archive.finalize();
  await done;

  console.log(`Built ${path.relative(ROOT, outPath)} (${(archive.pointer() / 1024).toFixed(1)} KB)`);
  return outPath;
}

async function main() {
  const versionArg = process.argv[2];
  if (versionArg) syncVersion(versionArg);
  const zipVersion = versionArg || currentManifestVersion();
  await zipExtension(zipVersion);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
