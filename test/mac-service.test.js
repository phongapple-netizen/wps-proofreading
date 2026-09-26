const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../scripts/mac-service.js");

test("Mac login service runs in the project directory with loopback arguments", () => {
  const xml = service.plist(
    service.services[1],
    ["/path/to/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"],
    { OPENCODE_CONFIG: "/project/opencode.json" }
  );
  assert.match(xml, /<key>WorkingDirectory<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /127\.0\.0\.1/);
  assert.match(xml, /OPENCODE_CONFIG/);
  assert.equal(xml.includes("0.0.0.0"), false);
});
