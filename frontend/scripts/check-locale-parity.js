/**
 * frontend/scripts/check-locale-parity.js
 * Verifies that all locale JSON files (en.json, fr.json, es.json) have identical key structures.
 */
const fs = require("fs");
const path = require("path");

const localesDir = path.join(__dirname, "..", "locales");
const files = ["en.json", "fr.json", "es.json"];

function getKeys(obj, prefix = "") {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys = keys.concat(getKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

const localeKeys = {};

for (const file of files) {
  const filePath = path.join(localesDir, file);
  if (!fs.existsSync(filePath)) {
    console.error(`Missing locale file: ${file}`);
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  localeKeys[file] = getKeys(content);
}

const enKeys = localeKeys["en.json"];
let hasError = false;

for (const file of files) {
  if (file === "en.json") continue;
  const currentKeys = localeKeys[file];
  const missingInFile = enKeys.filter((k) => !currentKeys.includes(k));
  const extraInFile = currentKeys.filter((k) => !enKeys.includes(k));

  if (missingInFile.length > 0) {
    console.error(`❌ ${file} is missing keys present in en.json:\n  ${missingInFile.join("\n  ")}`);
    hasError = true;
  }
  if (extraInFile.length > 0) {
    console.error(`❌ ${file} has extra keys not in en.json:\n  ${extraInFile.join("\n  ")}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.log(`✅ Locale key parity check passed! All ${files.length} locale files match with ${enKeys.length} keys.`);
}
