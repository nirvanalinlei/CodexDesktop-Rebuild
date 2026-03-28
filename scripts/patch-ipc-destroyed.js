#!/usr/bin/env node
/**
 * 构建后补丁：抑制窗口销毁后的 renderer -> main IPC 异常风暴。
 *
 * 现象：
 *   Error occurred in handler for 'codex_desktop:message-from-view':
 *   TypeError: Object has been destroyed
 *
 * 处理策略：
 *   在 main bundle 尾部覆盖注册 `UQ` 对应的 ipcMain handler：
 *   1. 应用退出中，直接忽略消息
 *   2. sender 已销毁，直接忽略消息
 *   3. 后续链路仍抛出 `Object has been destroyed`，降级为 warning
 *
 * 用法：
 *   node scripts/patch-ipc-destroyed.js
 *   node scripts/patch-ipc-destroyed.js --check
 */

const fs = require("fs");
const path = require("path");

const SENTINEL = 'Ignoring renderer message for destroyed webContents';
const SOURCE_MAP_MARKER = '//# sourceMappingURL=main.js.map';
const REQUIRED_MARKERS = [
  'R.ipcMain.handle(UQ,async',
  'const eo=t=>mt.isTrustedIpcSender',
  'R.app.on("before-quit"',
];

const INJECTION = [
  'R.ipcMain.removeHandler(UQ);',
  'R.ipcMain.handle(UQ,async(t,e)=>{',
  'if(!eo(t)||mt.isAppQuitting||t.sender.isDestroyed())return;',
  'if(await by.handleMessage(t,e))return;',
  'const n=mt.getContextForWebContents(t.sender);',
  'if(!n){',
  'Nt().warning("Message received for unknown window context");',
  'return',
  '}',
  'try{',
  'await n.handleMessage(t.sender,e)',
  '}catch(r){',
  'if(r instanceof Error&&/Object has been destroyed/i.test(r.message)){',
  'Nt().warning("Ignoring renderer message for destroyed webContents",{safe:{channel:UQ,quitting:mt.isAppQuitting},sensitive:{error:r}});',
  'return',
  '}',
  'throw r',
  '}',
  '});',
  '',
].join("\n");

function locateBundle() {
  const buildDir = path.join(__dirname, "..", "src", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.error("❌ 构建目录不存在:", buildDir);
    process.exit(1);
  }

  const files = fs.readdirSync(buildDir);
  const mainFile = files.find((file) => /^main(-[^.]+)?\.js$/.test(file));
  if (!mainFile) {
    console.error("❌ 未找到 main bundle (main*.js)");
    process.exit(1);
  }

  return path.join(buildDir, mainFile);
}

function ensurePatchable(source) {
  for (const marker of REQUIRED_MARKERS) {
    if (!source.includes(marker)) {
      throw new Error(`Missing expected marker: ${marker}`);
    }
  }

  if (!source.includes(SOURCE_MAP_MARKER)) {
    throw new Error("Missing source map marker in main bundle");
  }
}

function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const relPath = path.relative(path.join(__dirname, ".."), bundlePath);
  const source = fs.readFileSync(bundlePath, "utf8");

  console.log(`📄 目标文件: ${relPath}`);

  ensurePatchable(source);

  if (source.includes(SENTINEL)) {
    console.log("✅ IPC destroyed 补丁已存在");
    return;
  }

  console.log("🔎 检测到未修复的 ipc destroyed handler");

  if (isCheck) {
    console.log("📍 将在 source map 注释前注入覆盖 handler");
    return;
  }

  const patched = source.replace(
    SOURCE_MAP_MARKER,
    `${INJECTION}${SOURCE_MAP_MARKER}`
  );

  fs.writeFileSync(bundlePath, patched, "utf8");
  console.log("✅ 已注入 ipc destroyed 补丁");
}

main();
