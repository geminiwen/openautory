#!/usr/bin/env bun
/**
 * 清理构建产物
 *
 * 用法:
 *   bun scripts/clean.ts
 */

import { rmSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const BINARIES_DIR = resolve(ROOT, "apps/desktop/src-tauri/binaries");

if (existsSync(BINARIES_DIR)) {
  let cleaned = 0;
  for (const file of readdirSync(BINARIES_DIR)) {
    if (file === ".gitkeep") continue;
    const full = resolve(BINARIES_DIR, file);
    rmSync(full, { force: true });
    cleaned++;
    console.log(`  🗑  ${full}`);
  }
  if (cleaned === 0) {
    console.log("  (no sidecar binaries to clean)");
  }
}

console.log("\n✅ clean 完成\n");
