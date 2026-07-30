/**
 * Raycast "Import Extension" expects compiled command executables next to
 * package.json (e.g. list-windows.js), same layout as Store packages.
 * `ray build -o dist` writes them under dist/ — copy to package root.
 */
import { copyFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

if (!existsSync(dist)) {
  console.error("dist/ missing — run ray build first");
  process.exit(1);
}

for (const name of readdirSync(dist)) {
  if (name.endsWith(".js") || name.endsWith(".js.map")) {
    copyFileSync(join(dist, name), join(root, name));
    console.log("synced", name);
  }
}

// Keep assets/icon in sync for root import path
const iconSrc = join(dist, "assets", "icon.png");
const iconDstDir = join(root, "assets");
if (existsSync(iconSrc)) {
  mkdirSync(iconDstDir, { recursive: true });
  copyFileSync(iconSrc, join(iconDstDir, "icon.png"));
}

console.log("Raycast executables ready at package root.");
