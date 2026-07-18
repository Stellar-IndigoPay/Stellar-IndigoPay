/**
 * pages/verify.tsx
 *
 * Cross-chain donation attestation verifier (issue #125).
 *
 * Lets a donor or auditor paste a (source_chain, source_tx_hash) pair
 * (or a Soroban on-chain id, or a backend UUID) and read back the
 * corresponding attestation. Designed for "what did my bridge actually
 * do?" trust questions.
 *
 * The page is intentionally read-only — no auth required. The backend
 * already re-checks replay protection on POST; reads are open so anyone
 * can verify a public attestation.
 */
import { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";

import {
  fetchAttestationBySource,
  fetchAttestationStats,
  type AttestationStats,
  type CrossChainAttestation,
} from "@/lib/api";
import { shortenAddress } from "@/utils/format";

type LookupKey = "source" | "on-chain";

export default function VerifyAttestationPage() {
  const [sourceChain, setSourceChain] = useState("ethereum");
  const [sourceHash, setSourceHash] = useState("");
  const [onChainId, setOnChainId] = useState("");
  const [lookupMode, setLookupMode] = useState<LookupKey>("source");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CrossChainAttestation | null>(null);
  const [stats, setStats] = useState<AttestationStats | null>(null);

  useEffect(() => {
    fetchAttestationStats()
      .then((s: AttestationStats) =>
        setStats(s),
      )
      .catch(() => setStats(null));
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      if (lookupMode === "source") {
        if (!sourceHash.trim()) {
          throw new Error("Source tx hash is required");
        }
        const data = await fetchAttestationBySource(
          sourceChain.trim().toLowerCase(),
          sourceHash.trim(),
        );
        if (!data) {
          setError(
            "No attestation found yet. Either the bridge hasn't been observed, or the relayer hasn't submitted it.",
          );
          return;
        }
        setResult(data);
      } else {
        // on-chain id fallback: the backend exposes /by-id/:n but the
        // frontend doesn't have a typed helper yet. Use direct fetch so
        // the page still works for power users typing a numeric id.
        const id = parseInt(onChainId.trim(), 10);
        if (!Number.isFinite(id) || id < 0) {
          throw new Error("Invalid on-chain id");
        }
        const res = await fetch(`/api/attestations/by-id/${id}`, {
          credentials: "include",
        });
        if (res.status === 404) {
          setError("No attestation found for that on-chain id.");
          return;
        }
        if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
        const payload = await res.json();
        setResult(payload?.data ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Verify Cross-Chain Attestation | Stellar IndigoPay</title>
        <meta
          name="description"
          content="Look up a Stellar IndigoPay cross-chain donation attestation by source-chain tx hash or on-chain id."
        />
      </Head>

      <div className="min-h-screen bg-leaf">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
          <div className="mb-8">
            <h1 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
              Verify a Cross-Chain Attestation
            </h1>
            <p className="text-[#475569] dark:text-[#94A3B8] font-body">
              Paste the source-chain tx hash from your Ethereum/Polygon
              bridge, or a Stellar on-chain attestation id, and we&apos;ll
              show you the matching record on the IndigoPay ledger.
            </p>
          </div>

          {stats && (
            <div className="grid grid-cols-4 gap-3 mb-6">
              {(
                [
                  ["Total", stats.total],
                  ["Verified", stats.verified],
                  ["Pending", stats.pending],
                  ["Revoked", stats.revoked],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-[rgba(99,102,241,0.12)] dark:border-[rgba(129,140,248,0.16)] bg-white dark:bg-[#14142D] p-3 text-center"
                >
                  <p className="text-xs text-[#475569] dark:text-[#94A3B8] uppercase font-semibold">
                    {label}
                  </p>
                  <p className="text-2xl font-bold text-[#4F46E5] dark:text-[#818CF8]">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={onSubmit} className="card mb-6">
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={() => setLookupMode("source")}
                className={`px-3 py-2 rounded-xl text-sm font-semibold ${
                  lookupMode === "source"
                    ? "bg-[#4F46E5] text-white"
                    : "bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] text-[#475569]"
                }`}
              >
                By Source Tx
              </button>
              <button
                type="button"
                onClick={() => setLookupMode("on-chain")}
                className={`px-3 py-2 rounded-xl text-sm font-semibold ${
                  lookupMode === "on-chain"
                    ? "bg-[#4F46E5] text-white"
                    : "bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] text-[#475569]"
                }`}
              >
                By On-Chain Id
              </button>
            </div>

            {lookupMode === "source" ? (
              <>
                <label className="label">Source Chain</label>
                <select
                  value={sourceChain}
                  onChange={(e) => setSourceChain(e.target.value)}
                  className="w-full p-3 border border-forest-200 rounded-xl bg-white mb-3"
                >
                  <option value="ethereum">Ethereum</option>
                  <option value="polygon">Polygon</option>
                  <option value="arbitrum">Arbitrum</option>
                  <option value="base">Base</option>
                </select>

                <label className="label">Source Transaction Hash</label>
                <input
                  type="text"
                  value={sourceHash}
                  onChange={(e) => setSourceHash(e.target.value)}
                  placeholder="0x…"
                  className="input-field"
                />
              </>
            ) : (
              <>
                <label className="label">On-Chain Attestation Id</label>
                <input
                  type="number"
                  value={onChainId}
                  onChange={(e) => setOnChainId(e.target.value)}
                  placeholder="0, 1, 2, …"
                  className="input-field"
                />
              </>
            )}

            {error && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3 px-4 mt-4"
            >
              {loading ? "Looking up…" : "🔍 Verify"}
            </button>
          </form>

          {result && (
            <div className="card">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="label">Attestation</p>
                  <p className="font-mono text-xs text-[#475569] dark:text-[#94A3B8] break-all">
                    {result.id}
                  </p>
                </div>
                <span
                  className={`text-xs px-3 py-1 rounded-full font-semibold uppercase tracking-wider ${
                    result.status === "verified"
                      ? "bg-emerald-100 text-emerald-700"
                      : result.status === "pending"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-700"
                  }`}
                >
                  {result.status}
                </span>
              </div>

              <dl className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Stat label="Source chain" value={result.sourceChain} />
                <Stat
                  label="Source tx hash"
                  value={result.sourceTxHash}
                  mono
                />
                <Stat
                  label="On-chain id"
                  value={result.onChainId === null ? "—" : String(result.onChainId)}
                />
                <Stat
                  label="Donor (Stellar)"
                  value={
                    result.donorAddress
                      ? shortenAddress(result.donorAddress, 8)
                      : "—"
                  }
                  mono
                />
                <Stat
                  label="Amount (XLM eq.)"
                  value={result.amountXlm ?? "—"}
                />
                <Stat
                  label="Amount (USD eq.)"
                  value={result.amountUsd ?? "—"}
                />
                <Stat
                  label="Project"
                  value={result.projectId ?? "—"}
                  mono
                />
                <Stat
                  label="Created"
                  value={new Date(result.createdAt).toLocaleString()}
                />
                <Stat
                  label="Verified"
                  value={
                    result.verifiedAt
                      ? new Date(result.verifiedAt).toLocaleString()
                      : "—"
                  }
                />
              </dl>
            </div>
          )}

          <p className="text-xs text-center mt-8 text-[#475569] dark:text-[#94A3B8]">
            <Link href="/bridge" className="underline">
              ← Back to Bridge
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] p-3">
      <p className="text-xs uppercase tracking-wide text-[#475569] dark:text-[#94A3B8]">
        {label}
      </p>
      <p
        className={`text-sm ${mono ? "font-mono break-all" : ""} text-[#0F172A] dark:text-[#E2E8F0]`}
      >
        {value}
      </p>
    </div>
  );
}
