/**
 * frontend/scripts/check-locale-parity.js
 *
 * Locale health check for the i18n system. Two responsibilities:
 *
 *  1. Key parity (FAILURE GATE) — every locale JSON file must expose the
 *     exact same key set as en.json. CI fails when a key is present in
 *     en.json but missing (or extra) in another locale, so the language
 *     switcher can never fall back to English for a known key.
 *
 *  2. Translation coverage (METRIC) — for each non-English locale, report
 *     the percentage of keys whose value actually differs from the English
 *     value. Identical values are listed so reviewers can spot strings that
 *     were copied over but never translated; genuinely identical words
 *     (brand names, "Error", "XLM", …) are expected and only logged.
 *
 * Every `*.json` file in frontend/locales/ is discovered dynamically, so a
 * newly added locale (ar.json, he.json, …) is checked automatically instead
 * of requiring the hardcoded file list to be maintained.
 *
 * Output: a human summary plus a machine-readable `locale-coverage.json`
 * written to the frontend directory (uploaded as a CI artifact so the
 * coverage metric is visible on the dashboard).
 *
 * Exit code: 1 when key parity fails; 0 otherwise.
 */
const fs = require("fs");
const path = require("path");

const localesDir = path.join(__dirname, "..", "locales");
// Discover every locale file automatically — no hardcoded list to maintain.
const files = fs
  .readdirSync(localesDir)
  .filter((file) => file.endsWith(".json"))
  .sort();
const outputPath = path.join(__dirname, "..", "locale-coverage.json");

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

function getValueByKey(obj, key) {
  return key.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

const localeData = {};

for (const file of files) {
  const filePath = path.join(localesDir, file);
  if (!fs.existsSync(filePath)) {
    console.error(`Missing locale file: ${file}`);
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  localeData[file] = { content, keys: getKeys(content) };
}

const en = localeData["en.json"];
const enKeys = en.keys;
let hasError = false;

const coverage = {};

for (const file of files) {
  if (file === "en.json") continue;
  const current = localeData[file];
  const currentKeys = current.keys;
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

  // Translation coverage: keys whose value differs from the English value.
  // A MISSING key must never count as translated — the lookup returns
  // undefined, which would otherwise "differ" from the English string. Keys
  // missing from the locale are already a parity failure above and count as
  // untranslated here (they render English, i.e. fallback).
  const identical = enKeys.filter((k) => {
    const value = getValueByKey(current.content, k);
    return value !== undefined && value === getValueByKey(en.content, k);
  });
  const translated = enKeys.length - identical.length - missingInFile.length;
  const percent =
    enKeys.length === 0 ? 100 : ((translated / enKeys.length) * 100).toFixed(2);

  coverage[file] = {
    totalKeys: enKeys.length,
    translatedKeys: translated,
    identicalToEnglish: identical.length,
    missingKeys: missingInFile.length,
    coveragePercent: Number(percent),
  };

  console.log(`📊 ${file}: ${translated}/${enKeys.length} keys translated (${percent}% coverage)`);
  if (missingInFile.length > 0) {
    console.log(`   ⚠️  ${missingInFile.length} key(s) missing — these render English (fallback) and are NOT counted as translated`);
  }
  if (identical.length > 0) {
    console.log(`   ⚠️  ${identical.length} key(s) have the same value as en.json (may be intentional):\n   ${identical.join(", ")}`);
  }
}

// Machine-readable metric for the CI dashboard/artifact.
fs.writeFileSync(outputPath, JSON.stringify({ en: { totalKeys: enKeys.length }, ...coverage }, null, 2));
console.log(`✅ Coverage metric written to ${path.relative(path.join(__dirname, ".."), outputPath)}`);

if (hasError) {
  console.error("❌ Locale key parity check FAILED.");
  process.exit(1);
} else {
  console.log(`✅ Locale key parity check passed! All ${files.length} locale files match with ${enKeys.length} keys.`);
}
