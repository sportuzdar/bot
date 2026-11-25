import assert from "node:assert/strict";
import test from "node:test";
import {
  isBlockedHostname,
  isBlockedIp,
  pickSafeAddresses,
  resolveRedirectTarget,
  validateImportUrl,
} from "./ssrf.js";

test("blocks private, loopback, link-local and metadata IPv4", () => {
  for (const ip of [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test("allows public IPv4 and range edges", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "193.87.1.1",
  ]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("blocks private IPv6 forms incl. mapped / NAT64 / 6to4", () => {
  for (const ip of [
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "[::1]",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "0:0:0:0:0:0:0:1",
    "::127.0.0.1",
    "fe80::1%eth0",
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test("allows public IPv6 and mapped public IPv4", () => {
  for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450::1"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("unparseable addresses fail closed", () => {
  for (const ip of ["", "abc", "1.2.3", "999.1.1.1", ":::"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test("hostname checks", () => {
  for (const h of [
    "localhost",
    "LOCALHOST.",
    "a.localhost",
    "db.internal",
    "x.local",
    "127.0.0.1",
    "[::1]",
    "2130706433",
    "0x7f.1",
  ]) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  for (const h of [
    "example.com",
    "sportuzdar.sk",
    "1.example.com",
    "8.8.8.8",
  ]) {
    assert.equal(isBlockedHostname(h), false, h);
  }
});

test("validateImportUrl: https, port 443, no credentials, public host", () => {
  assert.equal(validateImportUrl("https://example.com/path?q=1").ok, true);
  assert.equal(validateImportUrl("https://example.com:443/").ok, true);
  const bad: Array<[string, string]> = [
    ["http://example.com", "protocol"],
    ["ftp://example.com", "protocol"],
    ["https://example.com:8443/", "port"],
    ["https://example.com:80/", "port"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://127.0.0.1/", "host"],
    ["https://2130706433/", "host"],
    ["https://0x7f.0.0.1/", "host"],
    ["https://[::ffff:127.0.0.1]/", "host"],
    ["https://169.254.169.254/latest/meta-data", "host"],
    ["not a url", "invalid-url"],
  ];
  for (const [u, reason] of bad) {
    const r = validateImportUrl(u);
    assert.equal(r.ok, false, u);
    if (!r.ok) assert.equal(r.reason, reason, u);
  }
});

test("resolveRedirectTarget resolves relative Locations and rejects junk", () => {
  const cur = new URL("https://example.com/a/b");
  assert.equal(resolveRedirectTarget(cur, "/x")?.href, "https://example.com/x");
  assert.equal(resolveRedirectTarget(cur, undefined), null);
  const abs = resolveRedirectTarget(cur, "http://169.254.169.254/")!;
  assert.equal(validateImportUrl(abs).ok, false);
});

test("pickSafeAddresses refuses empty and mixed answers", () => {
  assert.equal(pickSafeAddresses([]), null);
  assert.equal(
    pickSafeAddresses([{ address: "8.8.8.8" }, { address: "10.0.0.1" }]),
    null,
  );
  assert.deepEqual(pickSafeAddresses([{ address: "8.8.8.8" }]), [
    { address: "8.8.8.8" },
  ]);
});
