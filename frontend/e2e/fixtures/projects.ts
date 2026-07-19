/**
 * e2e/fixtures/projects.ts — deterministic project fixtures mirroring the
 * shape of real testnet ClimateProject records, used by the API mock.
 */
import type { ClimateProject } from "@/utils/types";

// Deterministic Stellar addresses (Keypair.fromRawEd25519Seed with fixed
// seeds) so the same fixtures produce the same addresses on every run.
export const PROJECT_WALLETS = {
  reforestation: "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL",
  solar: "GBTL47RTFR5EKMZSXWOQU735WBK7LRPPDIDK3JTNTCZZ7NUBBRDTVSK2",
  ocean: "GAFVCOWZWSJEAFOKBEBO2B4QITJ2YXN6YIYG6BUURQINVDVW4OPS3OL6",
} as const;

export const FIXTURE_PROJECTS: ClimateProject[] = [
  {
    id: "e2e-amazon-reforestation",
    name: "Amazon Reforestation Initiative",
    description:
      "Restoring degraded rainforest land in the Amazon basin by planting native tree species and supporting local communities.",
    category: "Reforestation",
    location: "Brazil",
    walletAddress: PROJECT_WALLETS.reforestation,
    goalXLM: "100000.0000000",
    raisedXLM: "42000.0000000",
    donorCount: 128,
    co2OffsetKg: 15400,
    co2_per_xlm: 2.5,
    status: "active",
    verified: true,
    onChainVerified: true,
    tags: ["reforestation", "amazon", "biodiversity"],
    createdAt: "2026-01-10T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    followCount: 12,
    isFollowing: false,
  },
  {
    id: "e2e-solar-for-schools",
    name: "Solar Power for Rural Schools",
    description:
      "Installing solar micro-grids at rural schools to provide reliable, clean electricity for classrooms and computer labs.",
    category: "Solar Energy",
    location: "Kenya",
    walletAddress: PROJECT_WALLETS.solar,
    goalXLM: "50000.0000000",
    raisedXLM: "18500.0000000",
    donorCount: 64,
    co2OffsetKg: 6200,
    co2_per_xlm: 1.8,
    status: "active",
    verified: true,
    onChainVerified: false,
    tags: ["solar", "education", "renewable"],
    createdAt: "2026-02-15T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    followCount: 5,
    isFollowing: false,
  },
  {
    id: "e2e-ocean-cleanup",
    name: "Coastal Ocean Cleanup Program",
    description:
      "Removing plastic waste from coastal waters and shorelines while restoring damaged marine habitats.",
    category: "Ocean Conservation",
    location: "Philippines",
    walletAddress: PROJECT_WALLETS.ocean,
    goalXLM: "75000.0000000",
    raisedXLM: "75000.0000000",
    donorCount: 210,
    co2OffsetKg: 3100,
    co2_per_xlm: 0.9,
    status: "completed",
    verified: true,
    onChainVerified: true,
    tags: ["ocean", "plastic", "marine-life"],
    createdAt: "2025-11-01T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    followCount: 30,
    isFollowing: false,
  },
];

export const PRIMARY_PROJECT = FIXTURE_PROJECTS[0];
