/**
 * utils/projectValidation.ts
 *
 * Resolves a scanned Stellar destination address against the backend project
 * registry so the Scan-to-Donate flow can confirm the project — and block
 * unknown or inactive destinations — before handing off to the donate screen.
 *
 * `resolveProjectByAddress` is a pure function so it can be unit-tested
 * independently of the network/registry fetch that supplies the project list.
 */

export interface RegistryProject {
  id: string;
  name: string;
  walletAddress: string;
  status?: string;
}

export type DestinationValidationResult =
  | { kind: "found"; project: RegistryProject }
  | { kind: "inactive"; project: RegistryProject }
  | { kind: "unknown" };

/** Only projects in this status may receive donations via a scanned QR. */
export const ACTIVE_PROJECT_STATUS = "active";

/**
 * Find the registered project whose wallet matches `address`.
 *
 * - `found` — the address matches a registered project that is currently
 *   `active` (safe to donate to).
 * - `inactive` — the address matches a registered project, but the project is
 *   not `active` (e.g. paused/completed/rejected); the donation must be
 *   blocked. A missing status is treated as inactive to fail closed.
 * - `unknown` — no registered project owns the address; the donation must be
 *   blocked.
 */
export function resolveProjectByAddress(
  projects: RegistryProject[],
  address: string,
): DestinationValidationResult {
  const project = projects.find((p) => p.walletAddress === address);
  if (!project) return { kind: "unknown" };
  if (project.status !== ACTIVE_PROJECT_STATUS) {
    return { kind: "inactive", project };
  }
  return { kind: "found", project };
}

/**
 * Find the registered project whose id matches `id` (#906).
 *
 * Same three-way result as `resolveProjectByAddress`, used by
 * `lib/linkRouter.ts` to confirm a project id from an inbound link/QR/
 * notification payload against the live registry before a screen renders
 * its (canonical) name — an inbound payload's own embedded name is never
 * trusted.
 */
export function resolveProjectById(
  projects: RegistryProject[],
  id: string,
): DestinationValidationResult {
  const project = projects.find((p) => p.id === id);
  if (!project) return { kind: "unknown" };
  if (project.status !== ACTIVE_PROJECT_STATUS) {
    return { kind: "inactive", project };
  }
  return { kind: "found", project };
}
