/**
 * pages/governance.tsx
 * Governance — Proposal voting for badge holders.
 */
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import PageMeta from "@/components/PageMeta";
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  rpcServer,
  server,
  getDonorStats,
  getVoterWeight,
  submitTransaction,
  formatTransactionError,
} from "@/lib/stellar";
import {
  getConnectedPublicKey,
  connectWallet,
  signTransactionWithWallet,
} from "@/lib/wallet";
import { fetchProjects } from "@/lib/api";
import { shortenAddress } from "@/utils/format";
import { SkeletonBox } from "@/components/Skeleton";
import {
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
  scValToNative,
  Account,
} from "@stellar/stellar-sdk";

// Stellat ledger ≈ 5 s — approximate deadline display from ledger offset.
const LEDGERS_PER_DAY = 17280;
const QUORUM_THRESHOLD = 15;

interface Proposal {
  projectId: string;
  projectName: string;
  votesFor: number;
  votesAgainst: number;
  deadlineLedger: number;
  resolved: boolean;
  currentLedger: number;
}

async function fetchProposal(
  projectId: string,
  currentLedger: number,
): Promise<Proposal | null> {
  try {
    const contract = new Contract(CONTRACT_ID);
    const dummyAccount = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "-1",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "get_proposal",
          nativeToScVal(projectId, { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result)) return null;

    const raw = scValToNative(result.result!.retval) as {
      project_id: string;
      votes_for: number;
      votes_against: number;
      deadline_ledger: number;
      resolved: boolean;
    };

    return {
      projectId,
      projectName: "",
      votesFor: Number(raw.votes_for),
      votesAgainst: Number(raw.votes_against),
      deadlineLedger: Number(raw.deadline_ledger),
      resolved: Boolean(raw.resolved),
      currentLedger,
    };
  } catch {
    return null;
  }
}

async function buildVoteTransaction(
  voter: string,
  projectId: string,
  approve: boolean,
) {
  const contract = new Contract(CONTRACT_ID);
  const source = await server.loadAccount(voter);
  const tx = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "vote_verify_project",
        new Address(voter).toScVal(),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(approve, { type: "bool" }),
      ),
    )
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  }
  throw new Error(`Simulation failed: ${JSON.stringify(simulated)}`);
}

function ledgersToDays(ledgers: number): string {
  const days = (ledgers / LEDGERS_PER_DAY).toFixed(1);
  return Number(days) < 0 ? "expired" : `~${days}d`;
}

export default function GovernancePage() {
  const router = useRouter();
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isBadgeHolder, setIsBadgeHolder] = useState(false);
  const [votingWeight, setVotingWeight] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [votingId, setVotingId] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [projects, statusResult] = await Promise.all([
        fetchProjects(),
        rpcServer.getLatestLedger(),
      ]);
      const currentLedger = statusResult.sequence;

      const settled = await Promise.allSettled(
        projects.map((p) =>
          fetchProposal(p.id, currentLedger).then((proposal) => {
            if (proposal) proposal.projectName = p.name;
            return proposal;
          }),
        ),
      );

      const active = settled
        .filter(
          (r): r is PromiseFulfilledResult<Proposal> =>
            r.status === "fulfilled" && r.value !== null,
        )
        .map((r) => r.value)
        .filter((p) => !p.resolved && p.deadlineLedger > currentLedger);

      setProposals(active);
    } catch (err) {
      setError(
        "Failed to load proposals. Make sure the Soroban RPC is reachable.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const pk = await getConnectedPublicKey();
      if (!mounted) return;
      setPublicKey(pk);

      if (pk) {
        try {
          const stats = await getDonorStats(pk);
          if (mounted && stats && stats.badge !== "None") {
            setIsBadgeHolder(true);
            const weight = await getVoterWeight(pk);
            if (mounted) setVotingWeight(weight);
          }
        } catch {
          // not a badge holder yet
        }
      }

      loadProposals();
    }

    init();
    return () => {
      mounted = false;
    };
  }, [loadProposals]);

  async function handleConnect() {
    const { publicKey: pk, error: err } = await connectWallet();
    if (err) {
      setError(err);
      return;
    }
    setPublicKey(pk);
    if (pk) {
      try {
        const stats = await getDonorStats(pk);
        if (stats && stats.badge !== "None") {
          setIsBadgeHolder(true);
          const weight = await getVoterWeight(pk);
          setVotingWeight(weight);
        }
      } catch {
        /* not a badge holder */
      }
    }
  }

  async function castVote(projectId: string, approve: boolean) {
    if (!publicKey) return;
    setVotingId(projectId);
    setTxStatus((prev) => ({ ...prev, [projectId]: "Building transaction…" }));
    try {
      const tx = await buildVoteTransaction(publicKey, projectId, approve);
      setTxStatus((prev) => ({ ...prev, [projectId]: "Sign in Freighter…" }));
      const { signedXDR, error: signErr } = await signTransactionWithWallet(
        tx.toXDR(),
      );
      if (signErr || !signedXDR) throw new Error(signErr || "Signing failed");
      setTxStatus((prev) => ({ ...prev, [projectId]: "Submitting…" }));
      await submitTransaction(signedXDR);
      setTxStatus((prev) => ({
        ...prev,
        [projectId]: approve ? "Voted: Approve ✓" : "Voted: Reject ✓",
      }));
      loadProposals();
    } catch (err) {
      setTxStatus((prev) => ({
        ...prev,
        [projectId]: `Error: ${formatTransactionError(err)}`,
      }));
    } finally {
      setVotingId(null);
    }
  }

  const totalVotes = (p: Proposal) => p.votesFor + p.votesAgainst;
  const passPercent = (p: Proposal) =>
    totalVotes(p) === 0 ? 0 : Math.round((p.votesFor / totalVotes(p)) * 100);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";
  const canonicalUrl = `${appUrl}${router.asPath.split("?")[0]}`;
  const governanceJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Governance | Stellar IndigoPay",
    url: canonicalUrl,
    description:
      "Vote on project verification proposals with your impact badge on Stellar IndigoPay.",
  };

  return (
    <div className="min-h-screen bg-[#fcfdfc] font-body text-forest-900 pb-20">
      <PageMeta
        title="Governance | Stellar IndigoPay"
        description="Vote on project verification proposals with your impact badge."
        canonicalUrl={canonicalUrl}
        jsonLd={governanceJsonLd}
      />

      <main className="max-w-3xl mx-auto px-4 py-12 sm:px-6">
        <div className="mb-10">
          <h1 className="text-4xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] tracking-tight">
            Community <span className="text-gradient">Governance</span>
          </h1>
          <p className="mt-3 text-[#475569] dark:text-[#94A3B8]">
            Badge holders vote to verify new climate projects. You need at least
            a <span className="font-semibold">Seedling badge</span> (≥ 10 XLM
            donated) to cast a vote.
          </p>
        </div>

        {/* Wallet + badge status */}
        <div className="card mb-8 rounded-2xl p-5">
          {publicKey ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm text-[#64748B]">Connected as</p>
                <p className="font-mono text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0]">
                  {shortenAddress(publicKey)}
                </p>
              </div>
              <div className="flex gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    isBadgeHolder
                      ? "bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8]"
                      : "bg-zinc-100 text-zinc-500"
                  }`}
                >
                  {isBadgeHolder ? "Eligible to vote" : "No badge yet"}
                </span>
                {isBadgeHolder && (
                  <span className="rounded-full px-3 py-1 text-xs font-semibold bg-[rgba(16,185,129,0.08)] text-[#059669] dark:bg-[rgba(52,211,153,0.1)] dark:text-[#34D399]">
                    Weight: {votingWeight}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-[#64748B]">
                Connect your Freighter wallet to vote.
              </p>
              <button
                onClick={handleConnect}
                className="btn-primary rounded-full px-4 py-2 text-sm"
              >
                Connect wallet
              </button>
            </div>
          )}
        </div>

        {/* Quorum notice */}
        <div className="mb-6 rounded-xl bg-[rgba(245,158,11,0.06)] border border-[rgba(245,158,11,0.20)] px-4 py-3 text-sm text-[#B45309] dark:text-[#FBBF24]">
          Quorum threshold: <strong>{QUORUM_THRESHOLD} weighted votes</strong>. A
          proposal passes when votes&nbsp;for &gt; votes&nbsp;against and the
          deadline passes.
        </div>

        <div className="mb-6 flex flex-wrap gap-3 text-xs text-[#64748B] dark:text-[#94A3B8]">
          <span><strong>Weights:</strong></span>
          <span>🌱 Seedling = 1</span>
          <span>🌳 Tree = 3</span>
          <span>🌲 Forest = 10</span>
          <span>🌍 Earth Guardian = 25</span>
        </div>

        {error && (
          <div className="mb-6 rounded-xl bg-[rgba(244,63,94,0.06)] border border-[rgba(244,63,94,0.20)] px-4 py-3 text-sm text-[#E11D48]">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4 py-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card rounded-2xl p-5 animate-pulse pointer-events-none">
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div className="flex-1 space-y-2">
                    <SkeletonBox className="h-5 rounded w-2/3" palette="indigo" />
                    <SkeletonBox className="h-3 rounded w-1/3" palette="indigo" />
                  </div>
                  <SkeletonBox className="h-6 rounded-full w-16" palette="indigo" />
                </div>
                <SkeletonBox className="h-2 rounded-full w-full mb-4" palette="indigo" />
                <div className="flex gap-2">
                  <SkeletonBox className="h-10 rounded-xl flex-1" palette="indigo" />
                  <SkeletonBox className="h-10 rounded-xl flex-1" palette="indigo" />
                </div>
              </div>
            ))}
          </div>
        ) : proposals.length === 0 ? (
          <div className="card rounded-2xl p-12 text-center">
            <p className="text-[#64748B] dark:text-[#94A3B8]">
              No open proposals at the moment.
            </p>
            <p className="mt-1 text-sm text-[#94A3B8]">
              Admins create proposals via{" "}
              <code className="text-xs">create_proposal</code> on the contract.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {proposals.map((proposal) => {
              const ledgersLeft =
                proposal.deadlineLedger - proposal.currentLedger;
              const votes = totalVotes(proposal);
              const pct = passPercent(proposal);
              const status = txStatus[proposal.projectId];
              const isVoting = votingId === proposal.projectId;
              const quorumMet = votes >= QUORUM_THRESHOLD;

              return (
                <article
                  key={proposal.projectId}
                  className="card rounded-2xl p-5"
                >
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <h2 className="text-base font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
                        {proposal.projectName || proposal.projectId}
                      </h2>
                      <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-0.5">
                        Project ID:{" "}
                        <code className="font-mono">{proposal.projectId}</code>
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="rounded-full bg-blue-50 text-blue-700 px-2.5 py-0.5 text-xs font-medium">
                        {ledgersToDays(ledgersLeft)} left
                      </span>
                      {quorumMet && (
                        <span className="rounded-full bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8] px-2.5 py-0.5 text-xs font-medium">
                          Quorum met
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Tally bar */}
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-[#64748B] dark:text-[#94A3B8] mb-1">
                      <span>
                        For:{" "}
                        <strong className="text-[#4F46E5] dark:text-[#818CF8]">
                          {proposal.votesFor}
                        </strong>
                      </span>
                      <span>
                        <strong>{votes}</strong> total weighted votes
                      </span>
                      <span>
                        Against:{" "}
                        <strong className="text-[#E11D48]">
                          {proposal.votesAgainst}
                        </strong>
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-1 text-right">
                      {pct}% approval
                    </p>
                  </div>

                  {/* Vote buttons */}
                  {isBadgeHolder && !status?.startsWith("Voted") ? (
                    <div className="flex gap-2">
                      <button
                        disabled={isVoting}
                        onClick={() => castVote(proposal.projectId, true)}
                        className="flex-1 btn-primary py-2 text-sm disabled:opacity-50 rounded-xl"
                      >
                        {isVoting ? "…" : "Approve"}
                      </button>
                      <button
                        disabled={isVoting}
                        onClick={() => castVote(proposal.projectId, false)}
                        className="flex-1 rounded-xl border border-red-300 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        {isVoting ? "…" : "Reject"}
                      </button>
                    </div>
                  ) : null}

                  {status && (
                    <p className="mt-3 text-xs text-[#64748B] dark:text-[#94A3B8] text-center">
                      {status}
                    </p>
                  )}

                  {!publicKey && (
                    <p className="mt-2 text-xs text-[#94A3B8] text-center">
                      Connect wallet to vote.
                    </p>
                  )}
                  {publicKey && !isBadgeHolder && (
                    <p className="mt-2 text-xs text-[#94A3B8] text-center">
                      You need at least a Seedling badge to vote. Donate ≥ 10
                      XLM to earn one.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
