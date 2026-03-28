#!/usr/bin/env node
/**
 * 构建后补丁：renderer 卸载期间停止向 main 继续发送 bridge IPC。
 *
 * 目的：
 *   窗口关闭 / renderer 销毁后，前端仍可能有异步任务继续调用
 *   `electronBridge.sendMessageFromView(...)`，造成主进程退出期 IPC 风暴。
 *
 * 策略：
 *   在 renderer bundle 的统一消息出口 O4t.postMessage 处增加：
 *   1. `beforeunload` / `pagehide` 置位关闭标记
 *   2. 页面关闭后，不再走 electronBridge.sendMessageFromView
 *   3. 关闭后的发送失败也不再打印 warning
 *
 * 用法：
 *   node scripts/patch-renderer-unload-ipc.js
 *   node scripts/patch-renderer-unload-ipc.js --check
 */

const fs = require("fs");
const path = require("path");

const SENTINEL = "__codexViewClosing";
const ORIGINAL = 'const O4t={postMessage:t=>{let e=!1;const n=window.electronBridge;if(n?.sendMessageFromView){const i=t;n.sendMessageFromView(i).catch(s=>{i.type!=="log-message"&&wt.warning("Failed to send message from view",{safe:{type:i.type},sensitive:{message:t,error:s}})}),e=!0}const r=new CustomEvent("codex-message-from-view",{detail:t});e&&(r.__codexForwardedViaBridge=!0),window.dispatchEvent(r)},getState:()=>I3e,setState:t=>{I3e=t}};';
const REPLACEMENT = 'let __codexViewClosing=!1;const __codexMarkViewClosing=()=>{__codexViewClosing=!0};window.addEventListener("beforeunload",__codexMarkViewClosing,{once:!0});window.addEventListener("pagehide",__codexMarkViewClosing,{once:!0});const O4t={postMessage:t=>{let e=!1;const n=window.electronBridge;if(!__codexViewClosing&&n?.sendMessageFromView){const i=t;n.sendMessageFromView(i).catch(s=>{if(__codexViewClosing||i.type==="log-message")return;wt.warning("Failed to send message from view",{safe:{type:i.type},sensitive:{message:t,error:s}})}),e=!0}const r=new CustomEvent("codex-message-from-view",{detail:t});e&&(r.__codexForwardedViaBridge=!0),window.dispatchEvent(r)},getState:()=>I3e,setState:t=>{I3e=t}};';

function locateBundle() {
  const assetsDir = path.join(__dirname, "..", "src", "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    console.error("❌ 资源目录不存在:", assetsDir);
    process.exit(1);
  }

  const files = fs.readdirSync(assetsDir).filter((file) => /^index-.*\.js$/.test(file));
  if (files.length === 0) {
    console.error("❌ 未找到 index-*.js bundle 文件");
    process.exit(1);
  }
  if (files.length > 1) {
    console.error("❌ 发现多个 index-*.js bundle 文件:", files.join(", "));
    process.exit(1);
  }

  return path.join(assetsDir, files[0]);
}

function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const relPath = path.relative(path.join(__dirname, ".."), bundlePath);
  const source = fs.readFileSync(bundlePath, "utf8");

  console.log(`📄 目标文件: ${relPath}`);

  if (source.includes(SENTINEL)) {
    console.log("✅ renderer unload IPC 补丁已存在");
    return;
  }

  if (!source.includes(ORIGINAL)) {
    console.error("❌ 未找到预期的 O4t.postMessage 片段，无法注入补丁");
    process.exit(1);
  }

  console.log("🔎 检测到未修复的 renderer unload IPC 出口");

  if (isCheck) {
    console.log("📍 将替换 O4t.postMessage，增加页面关闭标记与 IPC 短路");
    return;
  }

  const patched = source.replace(ORIGINAL, REPLACEMENT);
  fs.writeFileSync(bundlePath, patched, "utf8");
  console.log("✅ 已注入 renderer unload IPC 补丁");
}

main();
