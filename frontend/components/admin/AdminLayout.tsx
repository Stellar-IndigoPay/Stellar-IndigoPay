/**
 * components/admin/AdminLayout.tsx — Shared admin navigation layout
 *
 * Wraps admin pages with a top navigation bar that includes links to the
 * verification queue, projects (placeholder), and logout. Checks admin
 * auth and redirects to /admin/login when no token is present.
 */
import { useRouter } from "next/router";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isAdminAuthenticated, adminLogout } from "@/lib/adminAuth";
import ThemeToggle from "@/components/ThemeToggle";
import clsx from "clsx";

interface AdminLayoutProps {
  children: React.ReactNode;
}

const NAV_LINKS = [
  { href: "/admin/verification", label: "Verification Queue" },
  { href: "/admin", label: "Projects" },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const authed = isAdminAuthenticated();
    setAuthed(authed);
    setLoading(false);
    if (!authed) {
      router.replace("/admin/login");
    }
  }, [router]);

  const handleLogout = () => {
    adminLogout();
    router.replace("/admin/login");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 rounded-full border-2 border-[var(--primary)] border-t-transparent animate-spin" />
          <p className="text-sm text-[var(--muted)] font-body">Checking auth…</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return null; // Will redirect via the useEffect above
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Admin nav bar */}
      <nav className="sticky top-0 z-50 bg-white/80 dark:bg-[#0A0A1A]/80 backdrop-blur-xl border-b border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] shadow-sm dark:shadow-none">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Left: logo + links */}
          <div className="flex items-center gap-6">
            <Link
              href="/admin/verification"
              className="flex items-center gap-2 group"
            >
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center shadow-md">
                <svg
                  className="w-4 h-4 text-white"
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
              <span className="font-display font-bold text-sm text-[#0F172A] dark:text-[#E2E8F0]">
                Admin
              </span>
            </Link>

            <div className="flex items-center gap-1">
              {NAV_LINKS.map((l) => {
                const isActive = router.pathname === l.href || router.pathname.startsWith(l.href + "/");
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={clsx(
                      "px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 font-body",
                      isActive
                        ? "bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8]"
                        : "text-[#64748B] dark:text-[#94A3B8] hover:text-[#4F46E5] dark:hover:text-[#818CF8] hover:bg-[rgba(79,70,229,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)]",
                    )}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Right: theme toggle + logout */}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-[#64748B] dark:text-[#94A3B8] hover:text-[#F43F5E] dark:hover:text-[#FB7185] hover:bg-[rgba(244,63,94,0.06)] dark:hover:bg-[rgba(251,113,133,0.06)] transition-all duration-150 font-body"
            >
              <span className="flex items-center gap-1.5">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                Logout
              </span>
            </button>
          </div>
        </div>
      </nav>

      {/* Page content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fade-in">
        {children}
      </main>
    </div>
  );
}
