// pages/verification/[id].tsx
/**
 * Verification Transparency Page – shows the lifecycle of a verification request.
 * Public view (no auth) – reviewer notes are omitted for privacy.
 */
import { GetServerSideProps } from "next";
import Head from "next/head";
import { useEffect, useState } from "react";
import PageMeta from "@/components/PageMeta";
import Timeline from "@/components/VerificationTimeline";
import type { VerificationRequest } from "@/utils/types";

export const getServerSideProps: GetServerSideProps = async (context) => {
  const { id } = context.params as { id: string };
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || ""}/api/verification-requests/${id}/public`,
  );
  if (!res.ok) {
    return { notFound: true };
  }
  const json = await res.json();
  const data: VerificationRequest = json.data;
  // The public API already redacts reviewerNotes, but we strip again for safety.
  const { reviewerNotes, ...publicData } = data;
  return { props: { verification: publicData } };
};

interface Props {
  verification: VerificationRequest;
}

export default function VerificationPage({ verification }: Props) {
  const [timeline, setTimeline] = useState<Array<any>>([]);

  useEffect(() => {
    const events: Array<any> = [];
    if (verification.submittedAt) {
      events.push({ label: "Submitted", date: verification.submittedAt });
    }
    if (verification.reviewedAt) {
      const label =
        verification.status === "approved"
          ? "Approved"
          : verification.status === "rejected"
            ? "Rejected"
            : "Reviewed";
      events.push({ label, date: verification.reviewedAt });
    }
    setTimeline(events);
  }, [verification]);

  return (
    <>
      <Head>
        <title>Verification #{verification.id} – Transparency</title>
        <meta
          name="description"
          content={`Verification request for project ${verification.projectName}`}
        />
      </Head>
      <PageMeta
        title={`Verification #${verification.id}`}
        description={verification.projectDescription ?? ""}
      />
      <section className="max-w-4xl mx-auto p-6">
        <h1 className="text-3xl font-bold mb-4">
          Verification Request – #{verification.id}
        </h1>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 mb-6">
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Project
              </dt>
              <dd className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
                {verification.projectName}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Status
              </dt>
              <dd className="mt-1">
                <span
                  className={`px-2 py-1 rounded-full text-sm font-medium ${verification.status === "approved" ? "bg-green-100 text-green-800" : verification.status === "rejected" ? "bg-red-100 text-red-800" : "bg-yellow-100 text-yellow-800"}`}
                >
                  {verification.status.replace("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Submitted By
              </dt>
              <dd className="mt-1 text-gray-900 dark:text-gray-100">
                {verification.walletAddress}
              </dd>
            </div>
            {verification.reviewedBy && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Reviewed By
                </dt>
                <dd className="mt-1 text-gray-900 dark:text-gray-100">
                  {verification.reviewedBy}
                </dd>
              </div>
            )}
          </dl>
        </div>
        <h2 className="text-2xl font-semibold mb-4">Timeline</h2>
        <Timeline events={timeline} />
      </section>
    </>
  );
}
