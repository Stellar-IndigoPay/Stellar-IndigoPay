/**
 * components/Navbar.tsx — Premium indigo-themed navigation
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { fetchUnreadNotificationCount } from "@/lib/api";
import { shortenAddress } from "@/utils/format";
import { useI18n } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ThemeToggle from "@/components/ThemeToggle";
import clsx from "clsx";

interface NavbarProps {
  publicKey: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function Navbar({
  publicKey,
  onConnect,
  onDisconnect,
}: NavbarProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const network = (
    process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet"
  ).toLowerCase();
  const isMainnet = network === "mainnet";
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const token =
      typeof window !== "undefined"
        ? window.localStorage.getItem("stellar-indigopay:deviceToken")
        : null;
    const lastSeen =
      typeof window !== "undefined"
        ? window.localStorage.getItem(
            "stellar-indigopay:notifications:lastSeen",
          ) || undefined
        : undefined;

    if (!token) {
      setUnreadCount(0);
      return;
    }

    let cancelled = false;
    fetchUnreadNotificationCount({ token, lastSeen })
      .then((count) => {
        if (!cancelled) setUnreadCount(count);
      })
      .catch(() => {
        if (!cancelled) setUnreadCount(0);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const links = [
    { href: "/", label: t("nav.home") },
    { href: "/projects", label: t("nav.projects") },
    { href: "/map", label: t("nav.map") },
    { href: "/impact", label: t("nav.impact") },
    { href: "/leaderboard", label: t("nav.leaderboard") },
    { href: "/dashboard", label: t("nav.myImpact") },
    { href: "/apply", label: t("nav.apply") },
    { href: "/bridge", label: t("nav.bridge") },
    { href: "/transparency", label: t("nav.transparency") },
    { href: "/governance", label: t("nav.governance") },
  ];

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [router.pathname]);

  return (
    <nav className="sticky top-0 z-50 bg-white/80 dark:bg-[#0A0A1A]/80 backdrop-blur-xl border-b border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] shadow-sm dark:shadow-none">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center shadow-lg shadow-[rgba(79,70,229,0.25)] group-hover:shadow-[rgba(79,70,229,0.35)] transition-shadow">
              <svg
                className="w-5 h-5 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                />
              </svg>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-base tracking-tight">
                Stellar
                <span className="text-[#4F46E5] dark:text-[#818CF8]">
                  IndigoPay
                </span>
              </span>
              <span className="text-[10px] font-medium text-[#94A3B8] dark:text-[#64748B] tracking-wider uppercase">
                {t("nav.tagline")}
              </span>
            </div>
          </Link>
          <span
            className={`hidden md:inline-flex text-[11px] font-semibold px-2.5 py-1 rounded-full ${
              isMainnet
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40"
                : "bg-gold-50 text-gold-700 border border-gold-200 dark:bg-gold-900/30 dark:text-gold-300 dark:border-gold-700/40"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full mr-1.5 ${isMainnet ? "bg-emerald-500" : "bg-gold-500"} animate-pulse`}
            />
            {isMainnet ? t("nav.mainnet") : t("nav.testnet")}
          </span>
        </div>

        {/* Desktop nav links */}
        <div className="hidden md:flex items-center gap-1">
          {links.map((l) => {
            const isActive =
              router.pathname === l.href ||
              (router.pathname.startsWith(l.href + "/") && l.href !== "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  "px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 font-body",
                  "relative",
                  isActive
                    ? "bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8]"
                    : "text-[#64748B] dark:text-[#94A3B8] hover:text-[#4F46E5] dark:hover:text-[#818CF8] hover:bg-[rgba(79,70,229,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)]",
                )}
              >
                {l.label}
                {isActive && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#4F46E5] dark:bg-[#818CF8]" />
                )}
              </Link>
            );
          })}
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LanguageSwitcher />

          {unreadCount > 0 && (
            <span
              aria-label={t("nav.unreadNotifications", { count: unreadCount })}
              className="min-w-5 h-5 px-1.5 rounded-full bg-gradient-to-r from-[#F43F5E] to-[#FB7185] text-white text-xs font-bold flex items-center justify-center shadow-sm"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}

          {publicKey ? (
            <>
              <div className="hidden sm:flex items-center gap-2 address-tag">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50" />
                <span className="text-[11px] font-medium">
                  {shortenAddress(publicKey)}
                </span>
              </div>
              <button onClick={onDisconnect} className="btn-ghost text-xs">
                {t("nav.disconnect")}
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              className="btn-primary text-sm py-2 px-4 shadow-md"
            >
              <svg
                className="w-4 h-4 mr-1.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
                />
              </svg>
              {t("nav.connectWallet")}
            </button>
          )}

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden inline-flex items-center justify-center h-10 w-10 rounded-xl hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-colors"
            aria-label="Toggle navigation menu"
          >
            <svg
              className="w-5 h-5 text-[#64748B] dark:text-[#A5B4FC]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              {mobileMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <div
        className={clsx(
          "md:hidden overflow-hidden transition-all duration-300 ease-in-out",
          mobileMenuOpen ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="px-4 pb-4 space-y-1 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.08)] pt-2">
          {links.map((l) => {
            const isActive =
              router.pathname === l.href ||
              (router.pathname.startsWith(l.href + "/") && l.href !== "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  "block px-4 py-2.5 rounded-xl text-sm font-medium transition-all font-body",
                  isActive
                    ? "bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8]"
                    : "text-[#64748B] dark:text-[#94A3B8] hover:text-[#4F46E5] dark:hover:text-[#818CF8] hover:bg-[rgba(79,70,229,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)]",
                )}
              >
                {l.label}
              </Link>
            );
          })}
          {publicKey && (
            <div className="px-4 py-2">
              <div className="address-tag w-fit">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {shortenAddress(publicKey)}
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
