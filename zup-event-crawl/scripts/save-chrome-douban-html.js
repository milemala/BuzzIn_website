#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const urlMatch = args.find((arg) => arg.startsWith("--match="))?.split("=")[1] || "douban.com/event";
const outPath = args.find((arg) => arg.startsWith("--out="))?.split("=")[1];

if (!outPath) {
  console.error("Usage: node scripts/save-chrome-douban-html.js --out=path/to/file.html [--match=douban.com/events]");
  process.exit(1);
}

function runAppleScript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function getActiveTabUrl() {
  return runAppleScript('tell application "Google Chrome" to get URL of active tab of front window');
}

function readActiveTabHtml() {
  // Use nested "tell active tab" — the older "execute javascript ... in active tab"
  // form often fails with -1723 even when View → Developer → Allow JS is enabled.
  const script = `
tell application "Google Chrome"
  tell active tab of front window
    set htmlText to execute javascript "document.documentElement.outerHTML"
  end tell
end tell
return htmlText`;
  return runAppleScript(script);
}

const activeUrl = getActiveTabUrl();
if (!activeUrl.includes(urlMatch)) {
  console.error(`Active tab is not a match: ${activeUrl}`);
  console.error(`Switch Chrome to a tab containing "${urlMatch}" and run again.`);
  process.exit(1);
}

const html = readActiveTabHtml();
const target = { url: activeUrl };
const absOut = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
fs.mkdirSync(path.dirname(absOut), { recursive: true });
fs.writeFileSync(absOut, html);
console.log(`Saved ${html.length} bytes from ${target.url}`);
console.log(`-> ${absOut}`);
