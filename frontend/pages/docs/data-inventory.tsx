import PageMeta from "@/components/PageMeta";

export default function DataInventory() {
  return (
    <div className="min-h-screen bg-[#FAFAFE] dark:bg-[#0A0A1A] font-body text-[#0F172A] dark:text-[#E2E8F0] pb-20">
      <PageMeta title="Data Inventory | IndigoPay" description="Our data collection practices and inventory." />
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8 font-body">
        <h1 className="text-3xl font-bold mb-6">Data Collection Inventory</h1>
        <p className="mb-4">
          At IndigoPay, we believe in full transparency. This document outlines exactly what data we collect when you use our platform and consent to analytics.
        </p>
        
        <h2 className="text-2xl font-semibold mt-8 mb-4">Analytics (PostHog)</h2>
        <p className="mb-4">
          We use PostHog for product analytics to understand how the platform is used. This is completely optional and strictly gated by your consent.
        </p>

        <h3 className="text-xl font-semibold mt-6 mb-2">Events Collected</h3>
        <ul className="list-disc pl-6 mb-4 space-y-2">
          <li><strong>Page Views</strong>: Which pages are visited (e.g., project details, dashboard).</li>
          <li><strong>Donation Flow</strong>: Steps taken during the donation process (e.g., started, completed).</li>
          <li><strong>Feature Usage</strong>: Interactions with specific features (e.g., using the bridge, filtering projects).</li>
        </ul>

        <h3 className="text-xl font-semibold mt-6 mb-2">Properties Collected</h3>
        <p className="mb-2">When an event is tracked, the following non-PII properties may be attached:</p>
        <ul className="list-disc pl-6 mb-4 space-y-2">
          <li><strong>amountXLM</strong>: The donation amount, bucketed into ranges (e.g., 0-10, 11-50) to prevent fingerprinting.</li>
          <li><strong>projectId</strong>: The ID of the project being viewed or donated to.</li>
          <li><strong>currency</strong>: The currency selected (e.g., XLM, USDC).</li>
        </ul>

        <h3 className="text-xl font-semibold mt-6 mb-2">Strictly Prohibited Data</h3>
        <p className="mb-4">
          Our analytics implementation includes a strict client-side sanitizer that acts as a floor. We <strong>never</strong> collect or transmit the following to our analytics provider:
        </p>
        <ul className="list-disc pl-6 mb-4 space-y-2 text-red-600 dark:text-red-400">
          <li>Donor Wallet Addresses</li>
          <li>Transaction Hashes</li>
          <li>Email Addresses</li>
          <li>Exact Donation Amounts</li>
        </ul>

        <h2 className="text-2xl font-semibold mt-8 mb-4">Your Choices</h2>
        <p className="mb-4">
          You have full control over your analytics preferences. You can change your choice at any time from the settings menu or by clearing your browser data.
        </p>
        <p>
          If you decline, we do not initialize our analytics tools, no data is sent, and any previous in-memory sessions are cleared. We treat inaccessible storage (e.g., private browsing) as a denial by default.
        </p>
      </div>
    </div>
  );
}
