"use strict";

const redis = require("./redis");

async function invalidatePatterns(patterns) {
  const uniquePatterns = [...new Set(patterns.filter(Boolean))];
  await Promise.all(
    uniquePatterns.map((pattern) => redis.deletePattern(pattern).catch(() => {})),
  );
}

async function invalidateProjectRelatedCache(projectId) {
  const patterns = [
    "rsp:*",
    "projects:list:*",
    "projects:milestones:*",
    "stats:*",
    "leaderboard:*",
  ];

  if (projectId) {
    patterns.push(`projects:milestones:${projectId}`);
  }

  await invalidatePatterns(patterns);
}

async function clearAllCaches() {
  await invalidatePatterns(["rsp:*", "projects:*", "stats:*", "leaderboard:*"]);
}

module.exports = {
  invalidatePatterns,
  invalidateProjectRelatedCache,
  clearAllCaches,
};
