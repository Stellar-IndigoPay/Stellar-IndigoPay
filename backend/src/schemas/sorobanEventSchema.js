"use strict";

const { z } = require("zod");

const scValSchema = z.union([
  z.string(),
  z.object({
    _type: z.string().optional(),
    value: z.any().optional()
  }).passthrough(),
  z.any() // allowing broad structure initially
]);

const sorobanEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  ledger: z.number().or(z.string().transform(Number)),
  ledgerClosedAt: z.string(),
  contractId: z.string(),
  pagingToken: z.string(),
  topic: z.array(z.any()), // array of topics
  value: scValSchema,
  inSuccessfulContractCall: z.boolean().optional(),
  txHash: z.string().optional()
});

const fixtureMetadataSchema = z.object({
  provenance: z.object({
    sourceTxHash: z.string(),
    capturedAt: z.string(),
    schemaVersion: z.string()
  }),
  events: z.array(sorobanEventSchema)
});

module.exports = {
  sorobanEventSchema,
  fixtureMetadataSchema
};
