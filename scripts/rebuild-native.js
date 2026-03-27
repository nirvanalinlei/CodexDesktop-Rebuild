#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');

function patchFile(filePath, transform) {
  if (!fs.existsSync(filePath)) return false;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  fs.writeFileSync(filePath, after, 'utf8');
  return true;
}

function hasPath(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findVsOnlyV145Toolset() {
  const roots = [
    'C:\\Program Files\\Microsoft Visual Studio',
    'C:\\Program Files (x86)\\Microsoft Visual Studio',
    'D:\\Program Files\\Microsoft Visual Studio',
    'D:\\Program Files (x86)\\Microsoft Visual Studio',
  ];

  for (const root of roots) {
    const v145 = path.join(root, '18', 'Community', 'MSBuild', 'Microsoft', 'VC', 'v180', 'Platforms', 'x64', 'PlatformToolsets', 'v145');
    const v143 = path.join(root, '18', 'Community', 'MSBuild', 'Microsoft', 'VC', 'v180', 'Platforms', 'x64', 'PlatformToolsets', 'v143');
    if (hasPath(v145) && !hasPath(v143)) {
      return { root, v145, v143 };
    }
  }

  return null;
}

function hasSpectreLibsInstalled() {
  const roots = [
    'C:\\Program Files\\Microsoft Visual Studio',
    'C:\\Program Files (x86)\\Microsoft Visual Studio',
    'D:\\Program Files\\Microsoft Visual Studio',
    'D:\\Program Files (x86)\\Microsoft Visual Studio',
  ];
  const spectreSuffixes = [
    ['lib', 'x64', 'spectre'],
    ['lib', 'x86', 'spectre'],
    ['lib', 'spectre', 'x64'],
    ['lib', 'spectre', 'x86'],
  ];

  for (const root of roots) {
    const msvcRoot = path.join(root, '18', 'Community', 'VC', 'Tools', 'MSVC');
    if (!hasPath(msvcRoot)) {
      continue;
    }

    for (const version of fs.readdirSync(msvcRoot)) {
      for (const suffix of spectreSuffixes) {
        if (hasPath(path.join(msvcRoot, version, ...suffix))) {
          return true;
        }
      }
    }
  }

  return false;
}

function patchElectronNodeGypForV145() {
  const vsInfo = findVsOnlyV145Toolset();
  if (!vsInfo) {
    return false;
  }

  const findVisualStudioPath = path.join(projectRoot, 'node_modules', '@electron', 'node-gyp', 'lib', 'find-visualstudio.js');
  const msvsVersionPath = path.join(projectRoot, 'node_modules', '@electron', 'node-gyp', 'gyp', 'pylib', 'gyp', 'MSVSVersion.py');

  const patchedFindVisualStudio = patchFile(findVisualStudioPath, (content) =>
    content.replace(
      "    } else if (versionYear === 2022) {\n      return 'v143'\n    }\n",
      "    } else if (versionYear === 2022) {\n      return 'v145'\n    }\n",
    ),
  );

  const patchedMsvsVersion = patchFile(msvsVersionPath, (content) =>
    content.replace('default_toolset="v143"', 'default_toolset="v145"'),
  );

  if (patchedFindVisualStudio || patchedMsvsVersion) {
    console.log('[rebuild-native] Detected VS 18 + MSBuild v180 with only v145 registered; patched @electron/node-gyp to use v145.');
    return true;
  }

  return false;
}

function patchNodePtySpectreMitigation() {
  if (hasSpectreLibsInstalled()) {
    return false;
  }

  const patchTargets = [
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'binding.gyp'),
      transform: (content) =>
        content.replace(
          "        'msvs_configuration_attributes': {\n          'SpectreMitigation': 'Spectre'\n        },\n",
          "        'msvs_configuration_attributes': {},\n",
        ),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
      transform: (content) =>
        content.replaceAll(
          "            'msvs_configuration_attributes': {\n                'SpectreMitigation': 'Spectre'\n            },\n",
          "            'msvs_configuration_attributes': {},\n",
        ),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'build', 'conpty.vcxproj'),
      transform: (content) =>
        content.replace(/^\s*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/m, ''),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'build', 'pty.vcxproj'),
      transform: (content) =>
        content.replace(/^\s*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/m, ''),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'build', 'conpty_console_list.vcxproj'),
      transform: (content) =>
        content.replace(/^\s*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/m, ''),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'build', 'deps', 'winpty', 'src', 'winpty.vcxproj'),
      transform: (content) =>
        content.replace(/^\s*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/m, ''),
    },
    {
      filePath: path.join(projectRoot, 'node_modules', 'node-pty', 'build', 'deps', 'winpty', 'src', 'winpty-agent.vcxproj'),
      transform: (content) =>
        content.replace(/^\s*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/m, ''),
    },
  ];

  let patchedAny = false;
  for (const { filePath, transform } of patchTargets) {
    patchedAny = patchFile(filePath, transform) || patchedAny;
  }
  if (patchedAny) {
    console.log('[rebuild-native] Spectre-mitigated MSVC libraries were not found; patched node-pty to build without SpectreMitigation.');
  }
  return patchedAny;
}

function runElectronRebuild() {
  const cliPath = require.resolve('@electron/rebuild/lib/cli.js', {
    paths: [projectRoot],
  });

  const result = spawnSync(process.execPath, [cliPath], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  if (result.error) {
    console.error(result.error);
  }
  process.exit(1);
}

if (process.platform === 'win32') {
  patchElectronNodeGypForV145();
  patchNodePtySpectreMitigation();
}

runElectronRebuild();
