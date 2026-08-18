/**
 * pages/admin/login.tsx — Admin JWT login form
 *
 * Centered card with username/password fields. On success, stores the
 * JWT token and redirects to /admin/verification.
 *
 * Admins log in with a username and password (configured on the backend
 * via ADMIN_USERNAME / ADMIN_PASSWORD environment variables). This is
 * separate from wallet-based auth — admin privileges are granted by the
 * backend after verifying credentials and issuing a JWT.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { adminLogin } from "@/lib/adminAuth";
import ThemeToggle from "@/components/ThemeToggle";

export default function AdminLoginPage() {
  const router = useRouter();
  const { redirect, reason } = router.query;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }

    setLoading(true);
    try {
      await adminLogin(username.trim(), password);
      const destination =
        typeof redirect === "string" && redirect.length > 0
          ? decodeURIComponent(redirect)
          : "/admin/verification";
      router.replace(destination);
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Login failed. Please check your credentials.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Admin Login — Stellar-IndigoPay</title>
      </Head>
      <div className="min-h-screen bg-[var(--bg)] flex flex-col items-center justify-center px-4 py-12">
        {/* Theme toggle positioned top-right */}
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-sm">
          {/* Logo section */}
          <div className="text-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[rgba(79,70,229,0.25)]">
              <svg
                className="w-6 h-6 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </div>
            <h1 className="font-display text-2xl font-bold text-[var(--text)]">
              Admin Login
            </h1>
            <p className="text-sm text-[var(--text-secondary)] font-body mt-1">
              Sign in to manage verification requests
            </p>
          </div>

          {/* Session expiry banner */}
          {reason === "expired" && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 mb-4">
              <span className="text-amber-500 text-sm mt-0.5">⏳</span>
              <p className="text-sm text-amber-800 dark:text-amber-300 font-body">
                Your session has expired. Please log in again.
              </p>
            </div>
          )}

          {/* Login form */}
          <form
            onSubmit={handleSubmit}
            className="card space-y-5 shadow-lg"
          >
            {error && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                <span className="text-red-500 text-sm mt-0.5">⚠️</span>
                <p className="text-sm text-red-700 dark:text-red-300 font-body">
                  {error}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError(null);
                }}
                className="input-field"
                placeholder="Enter your username"
                disabled={loading}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                className="input-field"
                placeholder="Enter your password"
                disabled={loading}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Signing in…
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          {/* Back to home link */}
          <div className="text-center mt-6">
            <Link
              href="/"
              className="text-sm text-[var(--text-secondary)] hover:text-[var(--primary)] font-body transition-colors"
            >
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: {} };
};
