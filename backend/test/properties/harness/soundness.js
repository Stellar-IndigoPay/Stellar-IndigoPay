"use strict";

/**
 * backend/test/properties/harness/soundness.js
 *
 * The invariant predicates for the three core financial-integrity components.
 * Each function takes a generated case, runs the PRODUCTION implementation
 * (never a reimplementation) and throws on the first violated invariant.
 *
 * The *.properties.test.js files feed randomized cases into these predicates
 * through checkProperty; mutation-canary.test.js feeds deliberately broken
 * wrappers through the same predicates to prove they would catch regressions.
 */

const {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
} = require("../../../src/services/merkleTree");
const {
  GENESIS_PREV_HASH,
  canonicalize,
  computeRowHash,
  verifyChain,
} = require("../../../src/services/auditChain");
const {
  PROJECTION_NAMES,
  co2OffsetForDonation,
  computeImpactScore,
  projections,
  scaledToDecimalString,
  toDecimalString,
  toScaledInt,
} = require("../../../src/services/projectionEngine");

const { createProjectionDb } = require("./projectionTestDb");
const { sumScaled, toScaled } = require("./exactDecimal");

// ─── shared helpers ─────────────────────────────────────────────────--------

/**
 * Flip one bit in a Buffer copy.
 *
 * @param {Buffer} buf
 * @param {number} byteIndex
 * @param {number} bitIndex
 * @returns {Buffer}
 */
function flipBit(buf, byteIndex, bitIndex) {
  const copy = Buffer.from(buf);
  copy[byteIndex % copy.length] ^= 1 << (bitIndex % 8);
  return copy;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Drive one event through ALL production handlers in engine order, mirroring
 * processEvent/rebuildAllProjections (which iterate PROJECTION_NAMES).
 */
async function applyEvent(db, event, opts = {}) {
  const ctx = {
    client: db.client,
    pool: {},
    bulkProjectionBuild: Boolean(opts.bulk),
    seenDonors: opts.seenDonors,
  };
  for (const name of PROJECTION_NAMES) {
    await projections[name].handler(event, ctx);
  }
}

function runIncremental(events) {
  return (async () => {
    const db = createProjectionDb();
    for (const event of events) await applyEvent(db, event);
    return db;
  })();
}

/**
 * Full replay into fresh staging-equivalent state + the rebuild-only final
 * donor_count aggregate — mirrors rebuildAllProjections.
 */
function runBulkReplay(events) {
  return (async () => {
    const db = createProjectionDb();
    const seenDonors = new Set();
    for (const event of events) {
      await applyEvent(db, event, { bulk: true, seenDonors });
    }
    db.finalizeDonorCounts();
    return db;
  })();
}

/** Group amounts by key with an optional filter (oracle side). */
function groupSum(events, keyFn, filterFn) {
  const groups = new Map();
  for (const e of events) {
    if (filterFn && !filterFn(e)) continue;
    const key = keyFn(e);
    const cur = groups.get(key) || { amount: 0n, co2: 0n, count: 0 };
    cur.amount += toScaled(e.event_data.amountXLM, 7);
    cur.co2 += toScaled(e.event_data.co2OffsetKg, 4);
    cur.count += 1;
    groups.set(key, cur);
  }
  return groups;
}

// ─── projection properties ──────────────────────────────────────────────────

/**
 * Invariants: totals decompose per donor / per project / globally, counts are
 * consistent, history rows match events one-for-one, every stored numeric is
 * a non-negative BigInt, and everything is exact past 2^53.
 */
async function projectionTotalsDecomposeProperty(input) {
  const { events } = input;
  const db = await runIncremental(events);

  // Global aggregates.
  assert(
    db.globalStats.totalXlmRaised ===
      sumScaled(events.map((e) => e.event_data.amountXLM), 7),
    `global total_xlm_raised ${db.globalStats.totalXlmRaised} != exact sum of donation amounts`,
  );
  assert(
    db.globalStats.totalCo2OffsetKg ===
      sumScaled(events.map((e) => e.event_data.co2OffsetKg), 4),
    "global total_co2_offset_kg != exact sum of donation CO2",
  );
  assert(
    db.globalStats.totalDonations === events.length,
    "global total_donations != number of DonationRecorded events",
  );

  // Anonymous donations still count towards global/project aggregates.
  const allDonors = new Set(events.map((e) => e.event_data.donorAddress));
  assert(
    db.globalStats.totalDonors === allDonors.size,
    "global total_donors != distinct donors",
  );

  // Per-donor decomposition (leaderboard excludes anonymous donations).
  const byDonor = groupSum(
    events,
    (e) => e.event_data.donorAddress,
    (e) => !e.event_data.anonymous,
  );
  assert(
    db.leaderboard.size === byDonor.size,
    "leaderboard cardinality != distinct non-anonymous donors",
  );
  for (const [donor, agg] of byDonor) {
    /* eslint-disable security/detect-object-injection -- keyed by generated donor id */
    const row = db.leaderboard.get(donor);
    assert(row, `missing leaderboard row for donor ${donor}`);
    assert(row.totalDonated === agg.amount, `total_donated mismatch for ${donor}`);
    assert(row.totalCo2Offset === agg.co2, `total_co2_offset mismatch for ${donor}`);
    assert(row.donationCount === agg.count, `donation_count mismatch for ${donor}`);
    /* eslint-enable security/detect-object-injection */
  }

  // Per-project decomposition.
  const byProject = groupSum(events, (e) => e.aggregate_id);
  assert(db.projectStats.size === byProject.size, "project stats cardinality mismatch");
  for (const [projectId, agg] of byProject) {
    /* eslint-disable security/detect-object-injection -- keyed by generated project id */
    const row = db.projectStats.get(projectId);
    assert(row, `missing project_stats row for ${projectId}`);
    assert(row.raisedXlm === agg.amount, `raised_xlm mismatch for ${projectId}`);
    assert(row.co2OffsetKg === agg.co2, `co2_offset_kg mismatch for ${projectId}`);
    assert(row.donationCount === agg.count, `donation_count mismatch for ${projectId}`);
    const projectDonors = new Set(
      events
        .filter((e) => e.aggregate_id === projectId)
        .map((e) => e.event_data.donorAddress),
    );
    assert(
      row.donorCount === projectDonors.size,
      `donor_count mismatch for ${projectId}`,
    );
    /* eslint-enable security/detect-object-injection */
  }

  // History rows mirror events exactly (unique transaction hash index).
  assert(db.history.size === events.length, "history cardinality != event count");
  for (const e of events) {
    const txHash = e.transaction_hash;
    /* eslint-disable security/detect-object-injection -- keyed by generated tx hash */
    const row = db.history.get(txHash);
    assert(row, `missing history row for tx ${txHash}`);
    assert(
      row.amountXlm === toScaled(e.event_data.amountXLM, 7),
      `history amount mismatch for tx ${txHash}`,
    );
    assert(
      row.co2OffsetKg === toScaled(e.event_data.co2OffsetKg, 4),
      `history CO2 mismatch for tx ${txHash}`,
    );
    assert(row.donorAddress === e.event_data.donorAddress, "history donor mismatch");
    assert(row.projectId === e.aggregate_id, "history project mismatch");
    /* eslint-enable security/detect-object-injection */
  }

  // Non-negativity of every stored numeric.
  for (const [donor, row] of db.leaderboard) {
    for (const [field, v] of Object.entries(row)) {
      if (typeof v === "bigint") {
        assert(v >= 0n, `negative ${field} for donor ${donor}`);
      }
    }
  }
  for (const [project, row] of db.projectStats) {
    for (const [field, v] of Object.entries(row)) {
      if (typeof v === "bigint") {
        assert(v >= 0n, `negative ${field} for project ${project}`);
      }
    }
  }
  for (const [field, v] of Object.entries(db.globalStats)) {
    if (typeof v === "bigint") assert(v >= 0n, `negative global ${field}`);
  }
}

/**
 * Invariant: appending donations never decreases any accumulated total or
 * counter (monotonicity under input changes).
 */
async function projectionMonotonicityProperty(input) {
  const { events } = input;
  const db = createProjectionDb();

  let prevGlobal = { ...db.globalStats };
  let prevLeaderboard = new Map();
  let prevProject = new Map();

  for (let i = 0; i < events.length; i += 1) {
    /* eslint-disable-next-line no-await-in-loop -- sequential replay */
    await applyEvent(db, events[i]);
    const currentDonor = events[i].event_data.donorAddress;
    const currentProject = events[i].aggregate_id;
    const donorVisible = !events[i].event_data.anonymous;

    assert(
      db.globalStats.totalXlmRaised >= prevGlobal.totalXlmRaised,
      `total_xlm_raised decreased after event ${i}`,
    );
    assert(
      db.globalStats.totalCo2OffsetKg >= prevGlobal.totalCo2OffsetKg,
      `total_co2_offset_kg decreased after event ${i}`,
    );
    assert(
      db.globalStats.totalDonations > prevGlobal.totalDonations,
      `total_donations did not advance after event ${i}`,
    );

    for (const [donor, row] of db.leaderboard) {
      const before = prevLeaderboard.get(donor);
      if (!before) continue;
      assert(row.totalDonated >= before.totalDonated, `total_donated decreased for ${donor}`);
      assert(row.totalCo2Offset >= before.totalCo2Offset, `CO2 total decreased for ${donor}`);
      // Only the just-processed visible donation advances its own row.
      if (donor === currentDonor && donorVisible) {
        assert(row.donationCount > before.donationCount, `count did not advance for ${donor}`);
      }
    }
    for (const [projectId, row] of db.projectStats) {
      const before = prevProject.get(projectId);
      if (!before) continue;
      assert(row.raisedXlm >= before.raisedXlm, `raised_xlm decreased for ${projectId}`);
      assert(row.co2OffsetKg >= before.co2OffsetKg, `project CO2 decreased for ${projectId}`);
      if (projectId === currentProject) {
        assert(row.donationCount > before.donationCount, `project count stalled for ${projectId}`);
      }
    }

    prevGlobal = { ...db.globalStats };
    prevLeaderboard = new Map(
      [...db.leaderboard].map(([k, v]) => [k, { ...v }]),
    );
    prevProject = new Map([...db.projectStats].map(([k, v]) => [k, { ...v }]));
  }
}

/**
 * Invariant: the projection state is a pure function of the event sequence —
 * incremental processing and a from-scratch bulk replay agree, and replaying
 * the unchanged stream again reproduces the identical state (idempotent
 * re-projection).
 */
async function projectionReplayParityProperty(input) {
  const { events } = input;
  const incremental = await runIncremental(events);
  const bulk = await runBulkReplay(events);
  const bulkAgain = await runBulkReplay(events);

  const snap = (db) =>
    JSON.stringify(
      require("./projectionTestDb").snapshot(db),
      (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
    );

  assert(
    snap(incremental) === snap(bulk),
    "bulk rebuild state != incremental projection state",
  );
  assert(
    snap(bulk) === snap(bulkAgain),
    "re-projection of unchanged inputs is not idempotent",
  );
}

/**
 * Invariants of the exported decimal helpers (BigInt exactness):
 *   - toDecimalString never emits exponent notation;
 *   - scaledToDecimalString(toScaledInt(v)) round-trips exactly;
 *   - digits beyond the target scale truncate without float drift;
 *   - amounts far above Number.MAX_SAFE_INTEGER stay exact.
 */
async function decimalExactnessProperty(input) {
  const { values, hugeValues, overScaleValue } = input;

  for (const v of values) {
    const dec = toDecimalString(v);
    assert(dec !== null, `toDecimalString rejected valid input ${JSON.stringify(v)}`);
    assert(!/[eE]/.test(dec), `exponent notation leaked: ${dec}`);
    const roundTrip = scaledToDecimalString(toScaledInt(dec, 7), 7);
    assert(
      roundTrip === stripTrailingZeros(dec),
      `round-trip drifted: ${JSON.stringify(v)} -> ${dec} -> ${roundTrip}`,
    );
  }

  for (const huge of hugeValues) {
    // Independent oracle parse (exactDecimal.js) vs production conversion.
    const expected = toScaled(huge, 7);
    const actual = toScaledInt(huge, 7);
    assert(
      actual === expected,
      `precision lost above 2^53: ${huge} -> ${actual} != ${expected}`,
    );
  }

  // Fractional digits beyond the scale truncate (floor for positives).
  const truncated = toScaledInt(overScaleValue.value, overScaleValue.scale);
  const kept = overScaleValue.value.slice(
    0,
    overScaleValue.value.indexOf(".") + 1 + overScaleValue.scale,
  );
  assert(
    truncated === toScaled(kept, overScaleValue.scale),
    `truncation beyond scale incorrect for ${overScaleValue.value}`,
  );
}

function stripTrailingZeros(dec) {
  if (!dec.includes(".")) return dec;
  const trimmed = dec.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/**
 * Impact-score invariants: deterministic, non-negative, and monotone
 * non-decreasing in each argument (BigInt floor division preserves order).
 */
async function impactScoreInvariantProperty(input) {
  const { xlmLow, xlmHigh, co2Low, co2High } = input;

  const base = computeImpactScore(xlmLow, co2Low);
  assert(base === computeImpactScore(xlmLow, co2Low), "impact score not deterministic");
  assert(toScaled(base, 4) >= 0n, "impact score negative for non-negative inputs");
  assert(
    toScaled(computeImpactScore(xlmHigh, co2Low), 4) >= toScaled(base, 4),
    "impact score decreased when XLM total increased",
  );
  assert(
    toScaled(computeImpactScore(xlmLow, co2High), 4) >= toScaled(base, 4),
    "impact score decreased when CO2 total increased",
  );
}

/**
 * CO2-distribution invariants: zero-fallback rule, monotonicity in the
 * donation amount, scale-invariance under common multipliers, non-negativity,
 * and exact agreement with the documented proportional formula.
 */
async function co2DistributionInvariantProperty(input) {
  const { amountLow, amountHigh, raised, co2, multiplier } = input;

  const lowOut = co2OffsetForDonation(amountLow, raised, co2);
  const highOut = co2OffsetForDonation(amountHigh, raised, co2);

  assert(toScaled(lowOut, 4) >= 0n, "negative CO2 offset");

  if (toScaled(raised, 7) <= 0n || toScaled(co2, 4) <= 0n) {
    assert(lowOut === "0", "non-zero CO2 offset when project has no CO2 or no raised");
  } else {
    // Documented formula: floor(amount_stroops * co2_decigrams / raised_stroops).
    const expected =
      (toScaled(amountHigh, 7) * toScaled(co2, 4)) / toScaled(raised, 7);
    assert(
      toScaled(highOut, 4) === expected,
      `proportional CO2 drift: ${highOut} != ${scaledToDecimalString(expected, 4)}`,
    );
    assert(
      toScaled(highOut, 4) >= toScaled(lowOut, 4),
      "CO2 offset decreased when donation amount increased",
    );

    // Scaling amount and raised by the same integer factor preserves the result.
    const scaledAmount = mulDecimalString(amountHigh, multiplier);
    const scaledRaised = mulDecimalString(raised, multiplier);
    assert(
      co2OffsetForDonation(scaledAmount, scaledRaised, co2) === highOut,
      "CO2 proportion not scale-invariant",
    );
  }
}

/** Exact decimal-string × single-digit integer multiplication. */
function mulDecimalString(dec, digit) {
  const factor = BigInt(digit);
  if (factor === 1n) return dec;
  const neg = dec.startsWith("-");
  const unsigned = neg ? dec.slice(1) : dec;
  const [intPart, fracPart = ""] = unsigned.split(".");
  const scaled = (BigInt(intPart) * 10n ** BigInt(fracPart.length) + BigInt(fracPart || "0")) * factor;
  const out = scaledToDecimalStringLocal(scaled, fracPart.length);
  return neg ? `-${out}` : out;
}

function scaledToDecimalStringLocal(scaled, scale) {
  const whole = scaled / 10n ** BigInt(scale);
  const frac = scaled % 10n ** BigInt(scale);
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(scale, "0").replace(/0+$/, "")}`;
}

// ─── Merkle properties ──────────────────────────────────────────────────────

/** Defined tree shape: repeated ceil-halving down to a single root. */
function expectedLevelSizes(leafCount) {
  const sizes = [leafCount];
  while (sizes[sizes.length - 1] > 1) {
    sizes.push(Math.ceil(sizes[sizes.length - 1] / 2));
  }
  return sizes;
}

/**
 * Proof soundness: structure matches the defined semantics, every valid proof
 * verifies, and any single-bit corruption of a leaf or any sibling hash —
 * plus wrong leaf-count bindings — is rejected.
 */
async function merkleProofSoundnessProperty(input) {
  const { entries, leafIndex, leafByte, leafBit, stepIndex, stepByte, stepBit } = input;

  const { root, tree, leafCount, height } = buildMerkleTree(entries);

  // Structural invariants under the tree's defined odd-leaf semantics.
  const sizes = expectedLevelSizes(entries.length);
  assert(tree.length === sizes.length, "tree level count != ceil-halving depth");
  assert(height === sizes.length - 1, "reported height != levels - 1");
  assert(leafCount === entries.length, "leafCount != entries length");
  tree.forEach((level, idx) => {
    assert(level.length === sizes[idx], `level ${idx} size != ceil-halving size`);
  });

  const { leaf, proof, height: proofMetaHeight } = generateMerkleProof(tree, leafIndex);
  assert(proof.length === height, "proof length != tree height");
  assert(proofMetaHeight === height, "proof metadata height != tree height");
  assert(verifyMerkleProof(leaf, proof, root, leafCount), "valid proof rejected");

  // Flipping any bit of the leaf breaks verification.
  const tamperedLeaf = flipBit(leaf, leafByte, leafBit);
  assert(
    !verifyMerkleProof(tamperedLeaf, proof, root, leafCount),
    `tampered leaf accepted (bit ${leafBit} of byte ${leafByte % 32})`,
  );

  // Flipping any bit of any sibling hash in the proof breaks verification.
  // (A single-leaf tree has an empty proof — nothing to tamper.)
  if (proof.length > 0) {
    const targetStepIdx = stepIndex % proof.length;
    const targetStep = proof[targetStepIdx];
    const tamperedProof = proof.map((step, i) =>
      i === targetStepIdx
        ? { position: step.position, hash: flipBit(step.hash, stepByte, stepBit) }
        : step,
    );
    assert(
      !verifyMerkleProof(leaf, tamperedProof, root, leafCount),
      `tampered proof accepted (bit flipped in step ${targetStepIdx}: ${targetStep.hash.subarray(0, 4).toString("hex")}…)`,
    );
  }

  // The leaf-count commitment binds the tree shape.
  if (leafCount > 1) {
    assert(!verifyMerkleProof(leaf, proof, root, leafCount - 1), "wrong (smaller) leafCount accepted");
    assert(!verifyMerkleProof(leaf, proof, root, leafCount + 1), "wrong (larger) leafCount accepted");
  }
}

/**
 * Determinism: identical inputs produce identical trees; a permutation of a
 * set of distinct leaves produces a different root; appending a duplicate of
 * the last leaf (the odd-node ambiguity trap) always changes the root.
 */
async function merkleDeterminismProperty(input) {
  const { entries, permutation } = input;

  const first = buildMerkleTree(entries);
  const second = buildMerkleTree(entries);
  assert(first.root.equals(second.root), "root not deterministic for fixed input");
  first.tree.forEach((level, i) => {
    level.forEach((node, j) => {
      assert(node.equals(second.tree[i][j]), `tree[${i}][${j}] not deterministic`);
    });
  });

  const permutedEntries = permutation.map((i) => entries[i]);
  const isIdentity = permutation.every((v, i) => v === i);
  if (!isIdentity) {
    const permuted = buildMerkleTree(permutedEntries);
    assert(
      !permuted.root.equals(first.root),
      "permuting distinct leaves left the root unchanged",
    );
  }

  const duplicated = buildMerkleTree([...entries, entries[entries.length - 1]]);
  assert(
    !duplicated.root.equals(first.root),
    "appending a duplicate last leaf did not change the committed root",
  );
}

// ─── audit-chain properties ─────────────────────────────────────────────────

const TAMPERABLE_FIELDS = [
  "actor",
  "action",
  "target_type",
  "target_id",
  "ip_address",
  "metadata",
];

/**
 * Build a linked chain exactly the way audit.js appends rows: each row's
 * prev_hash is the previous row's row_hash (genesis '0'), row_hash comes from
 * the production computeRowHash. Rows are shaped like real pg results
 * (snake_case columns) because that is what verifyChain SELECTs.
 */
function buildValidChain(specs) {
  const rows = [];
  let prevHash = GENESIS_PREV_HASH;
  specs.forEach((spec, i) => {
    const prev_hash = i === 0 ? GENESIS_PREV_HASH : prevHash;
    const row_hash = computeRowHash({ ...spec, prev_hash });
    rows.push({
      id: spec.id,
      actor: spec.actor,
      action: spec.action,
      target_type: spec.targetType,
      target_id: spec.targetId,
      metadata: spec.metadata,
      ip_address: spec.ipAddress,
      created_at: spec.created_at,
      prev_hash,
      row_hash,
    });
    prevHash = row_hash;
  });
  return rows;
}

/** Fake pg client routing anchor vs log queries, log ordered like the SQL. */
function chainClient(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return {
    async query(text) {
      if (text.includes("audit_chain_anchor")) return { rows: [], rowCount: 0 };
      return { rows: sorted, rowCount: sorted.length };
    },
  };
}

/**
 * Append/verify round-trip + tamper detection: N appends verify cleanly;
 * mutating any single stored field of any row is detected at that row.
 */
async function auditChainIntegrityProperty(input) {
  const { specs, tamper } = input;

  const clean = buildValidChain(specs);
  if (clean.length === 0) return; // degenerate shrink state: nothing to tamper

  const cleanResult = await verifyChain(chainClient(clean));
  assert(cleanResult.valid === true, "clean chain failed verification");
  assert(cleanResult.checked === specs.length, "verified row count != appended count");
  assert(cleanResult.firstInvalidId === undefined, "spurious firstInvalidId on clean chain");

  // Tamper: replace one stored field of one row with a guaranteed-different value.
  const rowIndex = tamper.rowIndex % clean.length;
  const field = tamper.field;
  const original = clean[rowIndex][field];
  let mutated = original;
  if (field === "metadata") {
    const obj =
      typeof original === "string" ? JSON.parse(original || "{}") : original || {};
    mutated = `${JSON.stringify(obj)}|tampered`;
  } else {
    mutated = `${String(original ?? "")}|tampered`;
  }
  assert(mutated !== original, `tamper produced identical value for ${field}`);

  const tamperedRows = clean.map((row, i) =>
    i === rowIndex ? { ...row, [field]: mutated } : row,
  );
  const badResult = await verifyChain(chainClient(tamperedRows));
  assert(badResult.valid === false, `tampering "${field}" of row ${rowIndex} was NOT detected`);
  assert(
    badResult.firstInvalidId === tamperedRows[rowIndex].id,
    `firstInvalidId ${badResult.firstInvalidId} != tampered row id ${tamperedRows[rowIndex].id}`,
  );
}

/**
 * Canonicalization injectivity for the field set: two DIFFERENT field tuples
 * whose naive pipe-join would collide (and other near-miss mutations) must
 * canonicalize differently and therefore hash differently. Regression net for
 * the pipe-delimiter collision class.
 */
async function canonicalizationInjectivityProperty(input) {
  const { fields, mutateIndex, mode, pipeSegment } = input;

  const tupleA = fields.slice();
  const tupleB = fields.slice();
  if (tupleA.length === 0) return; // degenerate shrink state: nothing to test
  const j = mutateIndex % tupleA.length;

  if (mode === "pipeShift" && j + 1 < tupleB.length) {
    // Classic delimiter collision: ("p|q","r") vs ("p","q|r").
    const seg = pipeSegment;
    tupleA[j] = `p${seg}q`;
    tupleA[j + 1] = "r";
    tupleB[j] = "p";
    tupleB[j + 1] = `q${seg}r`;
  } else if (mode === "append") {
    tupleB[j] = `${tupleB[j]}|`;
  } else {
    // Swap two adjacent characters; fall back to appending when the swap is
    // a no-op ("aa") or the field is too short.
    const s = tupleB[j];
    const swapped = s.length >= 2 ? s[1] + s[0] + s.slice(2) : s;
    tupleB[j] = swapped !== s ? swapped : `${s}x`;
  }

  const differAsTuples = tupleA.some((v, i) => v !== tupleB[i]);
  assert(differAsTuples, "generator produced identical tuples");

  const canonA = canonicalize(rowsFromTuple(tupleA));
  const canonB = canonicalize(rowsFromTuple(tupleB));
  assert(canonA !== canonB, `canonicalization collision:\n  A=${canonA}\n  B=${canonB}`);

  const hashA = computeRowHash(rowsFromTuple(tupleA));
  const hashB = computeRowHash(rowsFromTuple(tupleB));
  assert(hashA !== hashB, "distinct tuples produced identical row hashes");
}

function rowsFromTuple(tuple) {
  const [
    id,
    actor,
    action,
    targetType,
    targetId,
    metadata,
    ipAddress,
    created_at,
    prev_hash,
  ] = tuple;
  return {
    id,
    actor,
    action,
    targetType,
    targetId,
    metadata,
    ipAddress,
    created_at,
    prev_hash,
  };
}

/**
 * Documented normalization equivalences must hold for arbitrary inputs:
 * null ≡ undefined ≡ "" for nullable fields, Date ≡ ISO string for
 * created_at, and metadata object ≡ its JSON serialization.
 */
async function auditNormalizationEquivalenceProperty(input) {
  const { fields, nullableField, metadataObject, dateMs } = input;

  const base = rowsFromTuple(fields);

  const nullableVariants = [null, undefined, ""].map((v) => ({
    ...base,
    [nullableField]: v,
  }));
  const hashes = nullableVariants.map((r) => computeRowHash(r));
  assert(
    new Set(hashes).size === 1,
    `null/undefined/"" not equivalent for field ${nullableField}`,
  );

  const iso = new Date(dateMs).toISOString();
  const fromDate = computeRowHash({ ...base, created_at: new Date(dateMs) });
  const fromIso = computeRowHash({ ...base, created_at: iso });
  assert(fromDate === fromIso, "Date and ISO-string created_at hash differently");

  const fromObj = computeRowHash({ ...base, metadata: metadataObject });
  const fromJson = computeRowHash({
    ...base,
    metadata: JSON.stringify(metadataObject),
  });
  assert(fromObj === fromJson, "metadata object and JSON string hash differently");
}

/**
 * Chain state is deterministic from the entry sequence: building the same
 * sequence twice yields identical hashes; changing any field changes the head.
 */
async function auditChainDeterminismProperty(input) {
  const { specs, mutateIndex, mutateDelta } = input;

  const first = buildValidChain(specs);
  const second = buildValidChain(specs);
  assert(
    first.map((r) => r.row_hash).join("") === second.map((r) => r.row_hash).join(""),
    "chain hashes not deterministic for fixed sequence",
  );
  assert(
    first.map((r) => r.prev_hash).join("") === second.map((r) => r.prev_hash).join(""),
    "chain links not deterministic for fixed sequence",
  );

  const idx = mutateIndex % specs.length;
  const perturbedSpecs = specs.map((s, i) =>
    i === idx ? { ...s, actor: `${s.actor}${mutateDelta}` } : s,
  );
  const perturbed = buildValidChain(perturbedSpecs);
  assert(
    perturbed[perturbed.length - 1].row_hash !== first[first.length - 1].row_hash,
    "changing an entry left the chain head unchanged",
  );
}

module.exports = {
  TAMPERABLE_FIELDS,
  applyEvent,
  auditChainDeterminismProperty,
  auditChainIntegrityProperty,
  auditNormalizationEquivalenceProperty,
  buildValidChain,
  canonicalizationInjectivityProperty,
  chainClient,
  co2DistributionInvariantProperty,
  decimalExactnessProperty,
  flipBit,
  impactScoreInvariantProperty,
  merkleDeterminismProperty,
  merkleProofSoundnessProperty,
  projectionMonotonicityProperty,
  projectionReplayParityProperty,
  projectionTotalsDecomposeProperty,
  runBulkReplay,
  runIncremental,
};
