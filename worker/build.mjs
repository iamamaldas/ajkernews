import fs from "node:fs";
import path from "node:path";

const root = path.resolve("..");
const worker = path.resolve(".");
const dist = path.join(worker, "dist");

function removeDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyFileIfExists(source, destination) {
  if (!fs.existsSync(source)) return;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectoryIfExists(source, destination) {
  if (!fs.existsSync(source)) return;

  fs.cpSync(source, destination, {
    recursive: true,
    force: true
  });
}

removeDirectory(dist);

fs.mkdirSync(dist, { recursive: true });

/*
 * Main website
 * The original index.html is copied without modifying its design.
 */
copyFileIfExists(
  path.join(root, "index.html"),
  path.join(dist, "index.html")
);

/*
 * Existing assets
 */
copyDirectoryIfExists(
  path.join(root, "assets"),
  path.join(dist, "assets")
);

/*
 * Existing legal/information pages
 */
copyDirectoryIfExists(
  path.join(root, "pages"),
  path.join(dist, "pages")
);

/*
 * Optional SEO/PWA files.
 * These will be added later.
 */
const optionalFiles = [
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  "news-sitemap.xml",
  "news-client.js"
];

for (const file of optionalFiles) {
  copyFileIfExists(
    path.join(root, file),
    path.join(dist, file)
  );
}

console.log("Static website build completed.");
console.log("Output:", dist);