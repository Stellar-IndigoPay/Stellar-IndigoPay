"use strict";
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "monitoring", "grafana", "dashboards");
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
if (!files.length) throw new Error("No dashboard JSON files found");
for (const file of files) {
  const dashboard = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const key of ["title", "uid", "schemaVersion", "panels"]) {
    if (dashboard[key] === undefined) throw new Error(`${file}: missing ${key}`);
  }
  if (!Array.isArray(dashboard.panels)) throw new Error(`${file}: panels must be an array`);
  const ids = dashboard.panels.map((panel) => panel.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error(`${file}: duplicate panel id`);
  for (const panel of dashboard.panels) {
    if (!panel.title || !panel.type || !panel.gridPos) throw new Error(`${file}: invalid panel ${panel.id}`);
  }
}
console.log(`Validated ${files.length} Grafana dashboard(s)`);
