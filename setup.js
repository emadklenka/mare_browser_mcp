#!/usr/bin/env node
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "src/index.js");

console.log("Registering mare-browser with Claude Code...");

try {
  execSync(`claude mcp add mare-browser -e HEADLESS=false -- node "${entry}"`, {
    stdio: "inherit",
  });
  console.log("Done! Restart Claude Code and the browser tools will be ready.");
} catch {
  console.error("Failed. Is Claude Code installed? Try: npm install -g @anthropic-ai/claude-code");
}
