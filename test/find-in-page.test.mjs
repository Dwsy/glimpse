import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const swift = readFileSync(new URL("../src/glimpse.swift", import.meta.url), "utf8");
const nodeHost = readFileSync(new URL("../src/glimpse.mjs", import.meta.url), "utf8");

assert.match(swift, /var findInPage: Bool = false/);
assert.match(swift, /json\["findInPage"\] as\? Bool/);
assert.match(swift, /case "--find-in-page":\s*config\.findInPage = true/);
assert.match(swift, /withTitle: "Find…", action: #selector\(showFindPanel\(_:\)\), keyEquivalent: "f"/);
assert.match(swift, /withTitle: "Find Next", action: #selector\(findNextInPage\(_:\)\), keyEquivalent: "g"/);
assert.match(swift, /findPreviousItem\.keyEquivalentModifierMask = \[\.command, \.shift\]/);
assert.match(swift, /guard record\.config\.findInPage, !record\.config\.clickThrough/);
assert.match(swift, /let configuration = WKFindConfiguration\(\)/);
assert.match(swift, /configuration\.wraps = true/);
assert.match(swift, /webView\.find\(query, configuration: configuration\)/);
assert.match(swift, /commandSelector == #selector\(NSResponder\.cancelOperation\(_:\)\)/);
assert.match(nodeHost, /options\.findInPage === true\) payload\.findInPage = true/);
assert.match(nodeHost, /options\.findInPage === true && supportsFindInPage\) args\.push\('--find-in-page'\)/);

console.log("find-in-page opt-in test passed");
