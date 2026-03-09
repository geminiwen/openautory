#!/usr/bin/env bun
/**
 * OpenAutory 构建脚本
 *
 * 用法:
 *   bun scripts/build.ts          # 完整构建（sidecar + 桌面端）
 *   bun scripts/build.ts sidecar  # 仅编译内核 sidecar
 *   bun scripts/build.ts desktop  # 仅打包桌面端（需先编译 sidecar）
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const DESKTOP = resolve(ROOT, "apps/desktop");
const SERVER_ENTRY = resolve(ROOT, "apps/server/src/index.ts");
const BINARIES_DIR = resolve(DESKTOP, "src-tauri/binaries");

async function getTargetTriple(): Promise<string> {
  const result = await $`rustc -vV`.text();
  const match = result.match(/host: (.+)/);
  if (!match) throw new Error("无法获取 Rust target triple");
  return match[1].trim();
}

async function buildSidecar() {
  console.log("\n📦 编译内核 sidecar...\n");

  const triple = await getTargetTriple();
  const outfile = resolve(BINARIES_DIR, `server-${triple}`);

  await $`mkdir -p ${BINARIES_DIR}`;
  await $`bun build --compile ${SERVER_ENTRY} --outfile ${outfile}`;

  console.log(`\n✅ sidecar 已输出到 ${outfile}\n`);
}

async function buildDesktop() {
  console.log("\n🖥️  打包桌面端...\n");

  const triple = await getTargetTriple();
  const sidecarPath = resolve(BINARIES_DIR, `server-${triple}`);

  if (!existsSync(sidecarPath)) {
    throw new Error(
      `sidecar 不存在: ${sidecarPath}\n请先运行: bun scripts/build.ts sidecar`
    );
  }

  const bundleConfig = JSON.stringify({
    bundle: { externalBin: ["binaries/server"] },
  });

  await $`cd ${DESKTOP} && bunx tauri build --config ${bundleConfig}`;

  console.log("\n✅ 桌面端打包完成\n");
}

// --- main ---

const step = process.argv[2];

try {
  switch (step) {
    case "sidecar":
      await buildSidecar();
      break;
    case "desktop":
      await buildDesktop();
      break;
    default:
      await buildSidecar();
      await buildDesktop();
      break;
  }
} catch (err) {
  console.error("\n❌ 构建失败:", (err as Error).message);
  process.exit(1);
}
