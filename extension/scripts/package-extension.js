const fs = require('fs');
const path = require('path');
const { ZipFile } = require('yazl');

const root = __dirname + '/..';
const outPath = path.join(root, 'greenpay-extension.zip');
const fixedDate = new Date('2024-01-01T00:00:00.000Z');
const manifestFiles = ['manifest.json', 'popup.html', 'popup.css', 'settings.html'];

function ensureBuildOutput() {
  const distPath = path.join(root, 'dist');
  const required = ['background.js', 'content-script.js', 'popup.js', 'settings.js'];

  if (!fs.existsSync(distPath)) {
    throw new Error('Missing dist/ directory. Run `npm run build` before packaging.');
  }

  for (const file of required) {
    if (!fs.existsSync(path.join(distPath, file))) {
      throw new Error(`Missing dist/${file}. Run \'npm run build\' before packaging.`);
    }
  }
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      files.push(...listFiles(filePath));
    } else if (entry.isFile()) {
      if (entry.name === 'greenpay-extension.zip') continue;
      files.push(filePath);
    }
  }
  return files;
}

function addZipEntry(zip, filePath, zipPath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;
  zip.addFile(filePath, zipPath, {
    mtime: fixedDate,
    mode: 0o100644,
  });
}

function main() {
  ensureBuildOutput();

  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }

  const injectDir = path.join(root, 'inject');
  fs.mkdirSync(injectDir, { recursive: true });
  const sourceInjectCss = path.join(root, 'src', 'inject', 'overlay.css');
  const targetInjectCss = path.join(injectDir, 'overlay.css');
  if (fs.existsSync(sourceInjectCss)) {
    fs.copyFileSync(sourceInjectCss, targetInjectCss);
  }

  const zip = new ZipFile();
  const files = [];

  for (const rel of manifestFiles) {
    const filePath = path.join(root, rel);
    if (fs.existsSync(filePath)) files.push({ filePath, zipPath: rel });
  }

  files.push(...listFiles(path.join(root, 'dist')).map((filePath) => ({
    filePath,
    zipPath: path.relative(root, filePath).split(path.sep).join('/'),
  })));

  files.push(...listFiles(injectDir).map((filePath) => ({
    filePath,
    zipPath: path.relative(root, filePath).split(path.sep).join('/'),
  })));

  files
    .sort((a, b) => a.zipPath.localeCompare(b.zipPath))
    .forEach(({ filePath, zipPath }) => addZipEntry(zip, filePath, zipPath));

  const stream = fs.createWriteStream(outPath);
  zip.outputStream.pipe(stream);
  zip.outputStream.on('error', (error) => {
    throw error;
  });
  zip.outputStream.on('end', () => {
    console.log(`Created ${path.relative(root, outPath)}`);
  });
  zip.end();
}

main();
