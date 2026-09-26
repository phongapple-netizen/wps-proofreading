const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dev = require("../scripts/dev-server.js");

test("macOS resolves normal sandbox path when WPS container exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wps-mac-"));
  const container = path.join(home, "Library", "Containers", "com.kingsoft.wpsoffice.mac");
  fs.mkdirSync(container, { recursive: true });

  const paths = dev.resolvePublishPaths({ platform: "darwin", homeDir: home, fsImpl: fs });
  assert.equal(paths.length, 1);
  assert.match(paths[0], /com\.kingsoft\.wpsoffice\.mac/);
  assert.match(paths[0], /Data[\\/]\.kingsoft[\\/]wps[\\/]jsaddons[\\/]publish\.xml$/);
});

test("macOS registers both normal and global WPS containers when both exist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wps-mac-"));
  [
    "com.kingsoft.wpsoffice.mac",
    "com.kingsoft.wpsoffice.mac.global"
  ].forEach((bundle) => {
    fs.mkdirSync(path.join(home, "Library", "Containers", bundle), { recursive: true });
  });

  const paths = dev.resolvePublishPaths({ platform: "darwin", homeDir: home, fsImpl: fs });
  assert.equal(paths.length, 2);
});

test("macOS falls back to the normal sandbox path before WPS has created its folders", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wps-mac-"));
  const paths = dev.resolvePublishPaths({ platform: "darwin", homeDir: home, fsImpl: fs });
  assert.equal(paths.length, 1);
  assert.match(paths[0], /com\.kingsoft\.wpsoffice\.mac/);
});

test("registerPlugin writes a localhost jspluginonline entry on macOS", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wps-mac-"));
  fs.mkdirSync(path.join(home, "Library", "Containers", "com.kingsoft.wpsoffice.mac"), { recursive: true });

  const paths = dev.registerPlugin({ platform: "darwin", homeDir: home, fsImpl: fs });
  const xml = fs.readFileSync(paths[0], "utf8");
  assert.match(xml, /name="wps-text-proofreading"/);
  assert.match(xml, /type="wps"/);
  assert.match(xml, /url="http:\/\/127\.0\.0\.1:3891\//);
  assert.match(xml, /enable="enable_dev"/);
});

test("publish.xml update replaces an old project entry without duplicating it", () => {
  const original = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<jsplugins>',
    '  <jspluginonline name="wps-text-proofreading" type="wps" url="http://127.0.0.1:9999/" />',
    '  <jspluginonline name="other-addon" type="wps" url="https://example.test/" />',
    '</jsplugins>'
  ].join("\n");

  const xml = dev.updatePublishXml(original);
  assert.equal((xml.match(/name="wps-text-proofreading"/g) || []).length, 1);
  assert.match(xml, /127\.0\.0\.1:3891/);
  assert.match(xml, /name="other-addon"/);
});
