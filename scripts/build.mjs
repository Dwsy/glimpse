import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || process.platform;
const root = join(__dirname, '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, extraOptions = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...extraOptions });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasCargo() {
  const result = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/** Build macOS .app bundle so Dock shows icon + "Glimpse" name. */
function packageMacApp() {
  const binary = join(root, 'src', 'glimpse');
  const app = join(root, 'src', 'Glimpse.app');
  const contents = join(app, 'Contents');
  const macosDir = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');

  rmSync(app, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resources, { recursive: true });

  copyFileSync(binary, join(macosDir, 'glimpse'));
  // Keep executable bit
  spawnSync('chmod', ['+x', join(macosDir, 'glimpse')]);

  const plistSrc = join(root, 'assets', 'Info.plist');
  const icnsSrc = join(root, 'assets', 'AppIcon.icns');
  const pngSrc = join(root, 'assets', 'AppIcon-1024.png');

  if (!existsSync(plistSrc)) fail(`Missing ${plistSrc}`);
  copyFileSync(plistSrc, join(contents, 'Info.plist'));

  if (existsSync(icnsSrc)) {
    copyFileSync(icnsSrc, join(resources, 'AppIcon.icns'));
  }
  if (existsSync(pngSrc)) {
    copyFileSync(pngSrc, join(resources, 'AppIcon-1024.png'));
  }

  // Sign the complete bundle, not only the linker-produced Mach-O. This binds
  // Info.plist/resources to CFBundleIdentifier so macOS services such as
  // UserNotifications recognize the process as the app bundle.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  console.log('Packaged and ad-hoc signed src/Glimpse.app (Dock icon + multi-window host)');
}

switch (target) {
  case 'darwin':
    run('swiftc', ['-O', 'src/glimpse.swift', '-o', 'src/glimpse']);
    packageMacApp();
    break;

  case 'linux': {
    const pkgCheck = spawnSync('pkg-config', ['--exists', 'webkitgtk-6.0', 'gtk4', 'gtk4-layer-shell-0'], { stdio: 'pipe' });
    if (pkgCheck.status !== 0) {
      fail([
        'Missing system dependencies. Install with:',
        '  Fedora:  dnf install gtk4-devel webkitgtk6.0-devel gtk4-layer-shell-devel',
        '  Ubuntu:  apt install libgtk-4-dev libwebkitgtk-6.0-dev libgtk4-layer-shell-dev',
        '  Arch:    pacman -S gtk4 webkitgtk-6.0 gtk4-layer-shell',
      ].join('\n'));
    }
    const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe' });
    if (cargoCheck.error || cargoCheck.status !== 0) {
      fail('Rust toolchain not found. Install from https://rustup.rs');
    }
    const rustDir = join(__dirname, '..', 'src', 'linux');
    run('cargo', ['build', '--release'], { cwd: rustDir });
    const src = join(rustDir, 'target', 'release', 'glimpse');
    const dest = join(__dirname, '..', 'src', 'glimpse');
    copyFileSync(src, dest);
    console.log('Binary installed to src/glimpse');
    break;
  }

  case 'win32': {
    if (!hasCargo()) {
      fail('Rust toolchain not found. Install from https://rustup.rs');
    }
    const rustDir = join(__dirname, '..', 'src', 'windows');
    run('cargo', ['build', '--release'], { cwd: rustDir });
    const src = join(rustDir, 'target', 'release', 'glimpse.exe');
    const dest = join(__dirname, '..', 'src', 'glimpse.exe');
    copyFileSync(src, dest);
    console.log('Binary installed to src/glimpse.exe');
    break;
  }

  default:
    fail(`Unsupported build target: ${target}`);
}
