/**
 * pages/bridge.tsx
 * Bridge page for USDC from Ethereum to Stellar using Circle CCTP
 */
import { useState, useEffect } from "react";
import Head from "next/head";
import Link from "next/link";
import { getPublicKey } from "@stellar/freighter-api";
import { shortenAddress } from "@/utils/format";
import { fetchProjects, recordDonation, csrfFetch } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

const CIRCLE_BRIDGE_URL = "https://bridge.circle.com";

export default function BridgePage() {
  const [sourceChain, setSourceChain] = useState<"ethereum" | "polygon">(
    "ethereum",
  );
  const [destinationChain, setDestinationChain] =
    useState<"stellar">("stellar");
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);
  const [bridgeHistory, setBridgeHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [bridgeAmount, setBridgeAmount] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [lastBridgeTxHash, setLastBridgeTxHash] = useState<string | null>(null);

  useEffect(() => {
    loadStellarAddress();
    loadBridgeHistory();
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      const data = await fetchProjects({ status: "active", limit: 50 });
      setProjects(data);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  };

  const loadStellarAddress = async () => {
    try {
      const pk = await getPublicKey();
      setStellarAddress(pk);
    } catch (err) {
      console.log("Wallet not connected");
    }
  };

  const loadBridgeHistory = () => {
    // Load from localStorage
    const history = localStorage.getItem("bridge_history");
    if (history) {
      setBridgeHistory(JSON.parse(history));
    }
  };

  const connectMetaMask = async () => {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      alert("Please install MetaMask to use Ethereum features");
      return;
    }

    try {
      setLoading(true);
      const accounts = await (window as any).ethereum.request({
        method: "eth_requestAccounts",
      });

      if (accounts.length > 0) {
        // Get USDC balance (read-only)
        const usdcContractAddress =
          sourceChain === "ethereum"
            ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" // Ethereum USDC
            : "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC

        const balance = await (window as any).ethereum.request({
          method: "eth_call",
          params: [
            {
              to: usdcContractAddress,
              data: `0x70a08231000000000000000000000000${accounts[0].slice(2).padStart(64, "0")}`,
            },
            "latest",
          ],
        });

        // Convert hex to decimal (USDC has 6 decimals)
        const balanceWei = parseInt(balance, 16);
        const balanceUSDC = (balanceWei / 1e6).toFixed(2);
        setEthBalance(balanceUSDC);
      }
    } catch (error) {
      console.error("Error connecting MetaMask:", error);
      alert("Failed to connect to MetaMask");
    } finally {
      setLoading(false);
    }
  };

  const recordBridgeDonation = async () => {
    if (!selectedProject || !bridgeAmount || !stellarAddress) return;

    setRecording(true);
    setRecordError(null);

    try {
      const amount = parseFloat(bridgeAmount);
      if (isNaN(amount) || amount <= 0) {
        throw new Error("Invalid amount");
      }

      await recordDonation({
        projectId: selectedProject,
        donorAddress: stellarAddress,
        amount: amount.toFixed(2),
        currency: "USDC",
        message: "Donated via Circle CCTP bridge",
        transactionHash: `bridge-${Date.now()}`,
        idempotencyKey: crypto.randomUUID(),
      });

      // Update bridge history
      const newEntry = {
        id: Date.now(),
        sourceChain,
        destinationChain,
        stellarAddress,
        amount: bridgeAmount,
        projectId: selectedProject,
        timestamp: new Date().toISOString(),
        status: "completed",
        type: "donation",
        attestationId: null,
      };

      const updatedHistory = [newEntry, ...bridgeHistory];
      setBridgeHistory(updatedHistory);
      localStorage.setItem("bridge_history", JSON.stringify(updatedHistory));

      setBridgeAmount("");
      setSelectedProject("");
      alert("Bridge donation recorded successfully!");
    } catch (err) {
      setRecordError(
        err instanceof Error ? err.message : "Failed to record donation",
      );
    } finally {
      setRecording(false);
    }
  };

  /**
   * Record a cross-chain donation attestation. Called after the user has
   * completed the CCTP bridge and wants the backend to mint an
   * attestation id (linking the source-chain tx to their Stellar wallet
   * and the chosen IndigoPay project). Uses the new /api/attestations
   * endpoint family — see issue #125.
   *
   * Two-step flow:
   *   1. POST /api/attestations/build-proof — get a signed proof from the
   *      relayer (no relayer secret in the browser, so we use the proof
   *      endpoint to mint one with the relayer's HMAC secret).
   *   2. POST /api/attestations — submit the observation with the proof
   *      headers. The backend replays the same canonical hash and verifies
   *      the signature, then writes the attestation row.
   *   3. INSERT may race against another parallel submit; we treat the
   *      resulting 200 (created=false) as success rather than an error.
   */
  const recordCrossChainAttestation = async () => {
    if (!selectedProject || !bridgeAmount || !stellarAddress) return;
    if (!lastBridgeTxHash) {
      setRecordError(
        "Initiate a bridge first so we have a source-chain tx hash to attest.",
      );
      return;
    }

    setRecording(true);
    setRecordError(null);

    try {
      const amount = parseFloat(bridgeAmount);
      if (isNaN(amount) || amount <= 0) {
        throw new Error("Invalid amount");
      }

      // Step 1: build a signed proof. We deliberately go through the
      // shared `csrfFetch` helper instead of raw `fetch()` — the latter
      // would skip the axios X-CSRF-Token interceptor and the backend's
      // csurf middleware would reject the POST with a 403 in production.
      const proofRes = await csrfFetch("/api/attestations/build-proof", {
        method: "POST",
        body: JSON.stringify({
          source_chain: sourceChain,
          source_tx_hash: lastBridgeTxHash,
          donor_address: stellarAddress,
          project_id: selectedProject,
        }),
      });
      if (!proofRes.ok) {
        const text = await proofRes.text();
        throw new Error(`Attestation proof failed: ${proofRes.status} ${text}`);
      }
      const proofPayload = await proofRes.json();
      const proof = proofPayload?.data ?? proofPayload;

      // Step 2: submit the attestation with the proof headers. We omit
      // `amount_xlm` entirely so the relayer can quote it during the
      // next step; storing a "guess XLM" on the backend before the
      // relayer runs would leak incorrect numbers to indexers on
      // mainnet.
      // on_chain_id is `0` here — the relayer awards the real Soroban
      // id when it replays this observation on-chain; the backend stores
      // 0 as a placeholder until the relayer's adapter upserts the
      // final monotonic id. This is intentional: the off-chain record
      // is provisional, the on-chain record is canonical.
      const recordRes = await csrfFetch("/api/attestations", {
        method: "POST",
        body: JSON.stringify({
          source_chain: sourceChain,
          source_tx_hash: lastBridgeTxHash,
          donor_address: stellarAddress,
          project_id: selectedProject,
          amount_usd: amount,
          message_hash: 0,
          on_chain_id: 0,
          status: "pending",
        }),
        headers: {
          "x-attestation-signature": proof.signature,
          "x-attestation-timestamp": String(proof.timestamp),
          "x-relayer-address": "frontend-bridge-user",
        },
      });
      if (!recordRes.ok && recordRes.status !== 200) {
        const text = await recordRes.text();
        throw new Error(`Attestation submit failed: ${recordRes.status} ${text}`);
      }
      const recordPayload = await recordRes.json();
      const attestationId =
        recordPayload?.data?.id ??
        (proof.timestamp
          ? `${lastBridgeTxHash.slice(0, 10)}@${proof.timestamp}`
          : lastBridgeTxHash);

      const newEntry = {
        id: Date.now(),
        sourceChain,
        destinationChain,
        stellarAddress,
        amount: bridgeAmount,
        projectId: selectedProject,
        sourceTxHash: lastBridgeTxHash,
        attestationId,
        timestamp: new Date().toISOString(),
        status: "attested",
        type: "attestation",
      };

      const updatedHistory = [newEntry, ...bridgeHistory];
      setBridgeHistory(updatedHistory);
      localStorage.setItem("bridge_history", JSON.stringify(updatedHistory));

      setBridgeAmount("");
      setSelectedProject("");
      setLastBridgeTxHash(null);
    } catch (err) {
      setRecordError(
        err instanceof Error ? err.message : "Failed to record attestation",
      );
    } finally {
      setRecording(false);
    }
  };

  const openCircleBridge = () => {
    if (!stellarAddress) {
      alert("Please connect your Stellar wallet first");
      return;
    }

    // Pre-fill Circle bridge with destination address
    const bridgeUrl = `${CIRCLE_BRIDGE_URL}?destination=${encodeURIComponent(stellarAddress)}&sourceChain=${sourceChain}&destinationChain=stellar&token=USDC`;
    window.open(bridgeUrl, "_blank");

    // Record bridge attempt in history
    const newEntry = {
      id: Date.now(),
      sourceChain,
      destinationChain,
      stellarAddress,
      amount: ethBalance || "0",
      timestamp: new Date().toISOString(),
      status: "initiated",
    };

    const updatedHistory = [newEntry, ...bridgeHistory];
    setBridgeHistory(updatedHistory);
    localStorage.setItem("bridge_history", JSON.stringify(updatedHistory));
  };

  /**
   * Capture the source-chain tx hash from the user after the CCTP bridge
   * completes. The user pastes it manually because Circle CCTP fires
   * the burn tx off-platform and our extension can't observe it from the
   * browser — this preserves the trust-minimised model where the
   * donor is responsible for quoting the source transaction.
   */
  const captureSourceTxHash = () => {
    const value = window.prompt(
      "Paste the source-chain transaction hash (the burn tx on Ethereum / Polygon):",
    );
    if (!value) return;
    setLastBridgeTxHash(value.trim());
  };

  const steps = [
    {
      number: 1,
      title: "Connect Ethereum Wallet",
      description: "Connect MetaMask to view your Ethereum USDC balance",
    },
    {
      number: 2,
      title: "Connect Stellar Wallet",
      description: "Connect Freighter to set your Stellar destination address",
    },
    {
      number: 3,
      title: "Open Circle Bridge",
      description:
        "Click the button to open Circle's CCTP bridge with pre-filled parameters",
    },
    {
      number: 4,
      title: "Complete Transfer",
      description: "Follow Circle's instructions to complete the USDC transfer",
    },
  ];

  return (
    <>
      <Head>
        <title>Bridge USDC | Stellar IndigoPay</title>
        <meta
          name="description"
          content="Bridge USDC from Ethereum to Stellar using Circle CCTP"
        />
      </Head>

      <div className="min-h-screen bg-leaf">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <div className="mb-8">
            <h1 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
              Bridge USDC to Stellar
            </h1>
            <p className="text-[#475569] dark:text-[#94A3B8] font-body">
              Transfer your Ethereum-based USDC to Stellar using Circle&apos;s
              Cross-Chain Transfer Protocol (CCTP)
            </p>
          </div>

          {/* Chain Selection */}
          <div className="card mb-6">
            <h2 className="label mb-4">Select Networks</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 block">
                  Source (Ethereum)
                </label>
                <select
                  value={sourceChain}
                  onChange={(e) =>
                    setSourceChain(e.target.value as "ethereum" | "polygon")
                  }
                  className="w-full p-3 border border-forest-200 rounded-xl bg-white"
                >
                  <option value="ethereum">Ethereum Mainnet</option>
                  <option value="polygon">Polygon</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 block">
                  Destination (Stellar)
                </label>
                <select
                  value={destinationChain}
                  onChange={(e) =>
                    setDestinationChain(e.target.value as "stellar")
                  }
                  className="w-full p-3 border border-forest-200 rounded-xl bg-white"
                  disabled
                >
                  <option value="stellar">Stellar</option>
                </select>
              </div>
            </div>
          </div>

          {/* Wallet Connections */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {/* Ethereum Wallet */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
                  Ethereum Wallet
                </h3>
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full font-semibold">
                  {sourceChain === "ethereum" ? "ETH" : "MATIC"}
                </span>
              </div>
              {ethBalance !== null ? (
                <div className="space-y-3">
                  <div className="p-3 bg-blue-50 rounded-xl">
                    <p className="text-xs text-blue-600 font-semibold mb-1">
                      USDC Balance
                    </p>
                    <p className="text-2xl font-bold text-blue-900">
                      ${ethBalance} USDC
                    </p>
                  </div>
                  <button
                    onClick={connectMetaMask}
                    className="w-full py-2 px-4 bg-blue-100 text-blue-700 rounded-xl font-semibold text-sm hover:bg-blue-200 transition-colors"
                  >
                    Refresh Balance
                  </button>
                </div>
              ) : (
                <button
                  onClick={connectMetaMask}
                  disabled={loading}
                  className="w-full py-3 px-4 bg-blue-500 text-white rounded-xl font-semibold hover:bg-blue-600 transition-colors disabled:opacity-50"
                >
                  {loading ? "Connecting..." : "Connect MetaMask"}
                </button>
              )}
            </div>

            {/* Stellar Wallet */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
                  Stellar Wallet
                </h3>
                <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full font-semibold">
                  XLM
                </span>
              </div>
              {stellarAddress ? (
                <div className="space-y-3">
                  <div className="p-3 bg-emerald-50 rounded-xl">
                    <p className="text-xs text-emerald-600 font-semibold mb-1">
                      Destination Address
                    </p>
                    <p className="text-sm font-mono text-emerald-900 break-all">
                      {shortenAddress(stellarAddress, 8)}
                    </p>
                  </div>
                  <button
                    onClick={loadStellarAddress}
                    className="w-full py-2 px-4 bg-emerald-100 text-emerald-700 rounded-xl font-semibold text-sm hover:bg-emerald-200 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              ) : (
                <button
                  onClick={loadStellarAddress}
                  className="w-full py-3 px-4 bg-emerald-500 text-white rounded-xl font-semibold hover:bg-emerald-600 transition-colors"
                >
                  Connect Freighter
                </button>
              )}
            </div>
          </div>

          {/* Step-by-Step Instructions */}
          <div className="card mb-6">
            <h2 className="label mb-4">How to Bridge</h2>
            <div className="space-y-4">
              {steps.map((s) => (
                <div
                  key={s.number}
                  className={`flex gap-4 p-4 rounded-xl border-2 transition-all ${
                    step === s.number
                      ? "border-[#4F46E5] dark:border-[#818CF8] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)]"
                      : "border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] bg-white dark:bg-[#14142D]"
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                      step === s.number
                        ? "btn-primary text-white"
                        : "bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] text-[#4F46E5] dark:text-[#818CF8]"
                    }`}
                  >
                    {s.number}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-1">
                      {s.title}
                    </h3>
                    <p className="text-sm text-[#475569] dark:text-[#94A3B8]">
                      {s.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bridge Button */}
          <div className="card mb-6">
            <button
              onClick={openCircleBridge}
              disabled={!stellarAddress}
              className="w-full py-4 px-6 bg-gradient-to-r from-blue-500 to-emerald-500 text-white rounded-xl font-bold text-lg hover:from-blue-600 hover:to-emerald-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              🌉 Open Circle Bridge
            </button>
            {!stellarAddress && (
              <p className="text-center text-xs text-amber-600 mt-2">
                Connect your Stellar wallet first
              </p>
            )}
          </div>

          {/* Record Bridge Donation */}
          {stellarAddress && projects.length > 0 && (
            <div className="card mb-6">
              <h2 className="label mb-4">🌱 Record as Project Donation</h2>
              <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body mb-4">
                After bridging USDC, record it as a donation to a climate
                project.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="label">Select Project</label>
                  <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    className="w-full p-3 border border-forest-200 rounded-xl bg-white"
                  >
                    <option value="">Choose a project...</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.category}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="label">Amount (USDC)</label>
                  <input
                    type="number"
                    value={bridgeAmount}
                    onChange={(e) => setBridgeAmount(e.target.value)}
                    placeholder="Enter amount bridged..."
                    min="1"
                    step="0.01"
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="label">Source-Chain Tx Hash</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={lastBridgeTxHash ?? ""}
                      onChange={(e) => setLastBridgeTxHash(e.target.value)}
                      placeholder="0x… (paste the burn tx from Circle)"
                      className="input-field flex-1"
                    />
                    <button
                      type="button"
                      onClick={captureSourceTxHash}
                      className="btn-ghost py-2 px-3 text-sm whitespace-nowrap"
                    >
                      Paste
                    </button>
                  </div>
                  <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-1">
                    Required for the on-chain attestation. Circle&apos;s burn tx
                    hash goes here.
                  </p>
                </div>

                {recordError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
                    {recordError}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    onClick={recordBridgeDonation}
                    disabled={!selectedProject || !bridgeAmount || recording}
                    className="btn-primary py-3 px-4"
                  >
                    {recording ? "Recording..." : "🎯 Record Donation"}
                  </button>
                  <button
                    onClick={recordCrossChainAttestation}
                    disabled={
                      !selectedProject ||
                      !bridgeAmount ||
                      !lastBridgeTxHash ||
                      recording
                    }
                    className="bg-gradient-to-r from-blue-500 to-emerald-500 text-white py-3 px-4 rounded-xl font-semibold hover:from-blue-600 hover:to-emerald-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {recording ? "Attesting..." : "🔗 Mint Cross-Chain Attestation"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bridge History */}
          {bridgeHistory.length > 0 && (
            <div className="card">
              <h2 className="label mb-4">Bridge History</h2>
              <div className="space-y-3">
                {bridgeHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between p-3 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] rounded-xl"
                  >
                    <div>
                      <p className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
                        {entry.sourceChain} → Stellar
                      </p>
                      <p className="text-xs text-[#475569] dark:text-[#94A3B8]">
                        {new Date(entry.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-[#4F46E5] dark:text-[#818CF8]">
                        ${entry.amount} USDC
                      </p>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          entry.status === "completed"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {entry.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Info Section */}
          <div className="mt-8 p-6 bg-blue-50 border border-blue-200 rounded-xl">
            <h3 className="font-display font-semibold text-blue-900 mb-2">
              ℹ️ About Circle CCTP
            </h3>
            <p className="text-sm text-blue-800 leading-relaxed">
              Circle&apos;s Cross-Chain Transfer Protocol (CCTP) is a
              permissionless on-chain messaging protocol that allows USDC to
              move between blockchains without wrapping or liquidity pools. Your
              USDC is burned on the source chain and minted on the destination
              chain, maintaining a 1:1 peg. Learn more at{" "}
              <a
                href="https://developers.circle.com/stablecoins/cctp-getting-started"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold"
              >
                Circle&apos;s documentation
              </a>
              .
            </p>
          </div>

          <div className="mt-6 text-center">
            <Link href="/projects" className="btn-ghost text-sm">
              ← Back to Projects
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
