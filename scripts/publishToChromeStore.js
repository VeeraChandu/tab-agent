#!/usr/bin/env node
// scripts/publishToChromeStore.js
//
// Uploads the built extension zip to the Chrome Web Store and publishes it.
// Run only by semantic-release's @semantic-release/exec `publishCmd` on
// main (see .releaserc.json) — never on dev, so alpha releases never touch
// the Store.
//
// Usage:
//   node scripts/publishToChromeStore.js <version>
//
// This runs `node scripts/build.js <version> --store` itself first, producing
// dist/store/tab-agent-<version>.zip - a copy of the package with manifest.json's
// "key" field stripped out. The Chrome Web Store rejects any upload whose manifest
// contains a "key" field ("key field is not allowed in manifest") - that field
// only exists to pin a stable extension id for local "Load unpacked" installs (see
// README's "Updating" section), and the Store assigns/owns its own id once an item
// is created. This is intentionally a separate build from the dist/tab-agent-<version>.zip
// that ships in GitHub Releases, which must keep the key.
//
// Required env vars (see CLAUDE.md for how to obtain these):
//   CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN, CHROME_EXTENSION_ID,
//   CHROME_PUBLISHER_ID (the developer account identifier shown in the Chrome Web
//   Store Developer Dashboard URL when logged in - NOT the extension ID)
//
// Optional env var:
//   CHROME_STORE_UPLOAD_ONLY=true — upload the new package but don't call
//   publish(). Useful for validating credentials/packaging without pushing
//   the update live (the upload still goes through the Store's own review
//   process once published later from the dashboard).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
// chrome-webstore-upload ships as an ESM-only package ("type": "module"), so
// require()'ing it returns the module namespace object (with __esModule/
// default/named exports), not the factory function itself directly - the
// actual factory is the .default property.
const { default: chromeWebstoreUpload } = require("chrome-webstore-upload");

const ROOT = path.resolve(__dirname, "..");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `publishToChromeStore.js: missing required env var ${name}. ` +
        "See CLAUDE.md's Chrome Web Store setup checklist."
    );
  }
  return value;
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    throw new Error("publishToChromeStore.js: usage: node scripts/publishToChromeStore.js <version>");
  }

  console.log(`Building Store-safe package (no "key" field) for ${version}...`);
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.js"), version, "--store"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const zipPath = path.join(ROOT, "dist", "store", `tab-agent-${version}.zip`);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`publishToChromeStore.js: expected zip missing after build: ${path.relative(ROOT, zipPath)}`);
  }

  const extensionId = requireEnv("CHROME_EXTENSION_ID");
  const publisherId = requireEnv("CHROME_PUBLISHER_ID");
  const clientId = requireEnv("CHROME_CLIENT_ID");
  const clientSecret = requireEnv("CHROME_CLIENT_SECRET");
  const refreshToken = requireEnv("CHROME_REFRESH_TOKEN");

  const store = chromeWebstoreUpload({
    extensionId,
    publisherId,
    clientId,
    clientSecret,
    refreshToken,
  });

  console.log(`Uploading ${path.relative(ROOT, zipPath)} to Chrome Web Store (extension ${extensionId})...`);
  const uploadResult = await store.uploadExisting(fs.createReadStream(zipPath));
  if (uploadResult.uploadState === "FAILED") {
    throw new Error(`publishToChromeStore.js: upload failed: ${JSON.stringify(uploadResult.itemError || uploadResult)}`);
  }
  console.log(`Upload state: ${uploadResult.uploadState}`);

  if (process.env.CHROME_STORE_UPLOAD_ONLY === "true") {
    console.log("CHROME_STORE_UPLOAD_ONLY=true — skipping publish() call. Package uploaded but not pushed live.");
    return;
  }

  console.log("Publishing...");
  const publishResult = await store.publish("default");
  console.log(`Publish response: ${JSON.stringify(publishResult)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
