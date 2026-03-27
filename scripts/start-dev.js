#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

// Map to CLI binary paths
const platformMap = {
  darwin: {
    x64: 'darwin-x64',
    arm64: 'darwin-arm64',
  },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-arm64',
  },
  win32: {
    x64: 'win32-x64',
  },
};

const binDir = platformMap[platform]?.[arch];
if (!binDir) {
  console.error(`Unsupported platform/arch: ${platform}/${arch}`);
  process.exit(1);
}

const cliName = platform === 'win32' ? 'codex.exe' : 'codex';
const projectRoot = path.join(__dirname, '..');
const localCliPath = path.join(projectRoot, 'resources', 'bin', binDir, cliName);

// 平台 -> target triple 映射（与 forge.config.js 保持一致）
const TARGET_TRIPLE_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const OPENAI_PLATFORM_PACKAGE_MAP = {
  'darwin-arm64': ['@openai', 'codex-darwin-arm64'],
  'darwin-x64': ['@openai', 'codex-darwin-x64'],
  'linux-arm64': ['@openai', 'codex-linux-arm64'],
  'linux-x64': ['@openai', 'codex-linux-x64'],
  'win32-x64': ['@openai', 'codex-win32-x64'],
};

function getVendorRoots(platformArch) {
  const roots = [];
  const openaiPackagePath = OPENAI_PLATFORM_PACKAGE_MAP[platformArch];

  if (openaiPackagePath) {
    roots.push(
      path.join(projectRoot, 'node_modules', '@openai', 'codex', 'node_modules', ...openaiPackagePath, 'vendor'),
      path.join(projectRoot, 'node_modules', ...openaiPackagePath, 'vendor'),
    );
  }

  // 兼容旧的 @cometix/codex vendor 布局。
  roots.push(path.join(projectRoot, 'node_modules', '@cometix', 'codex', 'vendor'));
  return roots;
}

// 从 npm vendor 同步到 resources/bin/
const triple = TARGET_TRIPLE_MAP[binDir];
if (triple) {
  for (const vendorRoot of getVendorRoots(binDir)) {
    const vendorPath = path.join(vendorRoot, triple, 'codex', cliName);
    if (!fs.existsSync(vendorPath)) continue;

    const localDir = path.join(projectRoot, 'resources', 'bin', binDir);
    fs.mkdirSync(localDir, { recursive: true });
    fs.copyFileSync(vendorPath, path.join(localDir, cliName));
    try { fs.chmodSync(path.join(localDir, cliName), 0o755); } catch {}
    console.log(`[start-dev] Synced codex binary: vendor → resources/bin/${binDir}/${cliName}`);
    break;
  }
}

const cliPath = localCliPath;
const codexHome = process.env.CODEX_HOME || path.join(projectRoot, '.codex-dev');

// Verify CLI exists
if (!fs.existsSync(cliPath)) {
  console.error(`CLI not found at: ${cliPath}`);
  console.error('Tried: resources/bin/, node_modules/@openai/codex/.../vendor/, and node_modules/@cometix/codex/vendor/');
  process.exit(1);
}

// 开发模式默认隔离状态目录，避免读取用户全局 ~/.codex 状态库。
try {
  fs.mkdirSync(codexHome, { recursive: true });
} catch (error) {
  console.error(`[start-dev] Failed to prepare CODEX_HOME at: ${codexHome}`);
  console.error(error);
  process.exit(1);
}

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);
console.log(`[start-dev] CODEX_HOME: ${codexHome}${process.env.CODEX_HOME ? ' (from env)' : ' (isolated dev state)'}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    CODEX_HOME: codexHome,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    // 使用 app:// 自定义协议加载静态资源（而非 Vite dev server）
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
  },
});

child.on('close', (code) => {
  process.exit(code);
});
