/**
 * components/admin/AdminRouteGuard.tsx — Route guard for admin pages
 *
 * Wraps protected admin pages. On mount it hydrates the admin session:
 * - `loading`       → full-screen spinner (no unauthorized flash)
 * - `unauthenticated` → redirect to /admin/login
 * - `expired`        → redirect to /admin/login with reason=expired
 * - `authenticated`  → render children
 *
 * Preserves the intended destination so the login page can redirect
 * back after successful authentication.
 */
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { getAuthState, initAuth, type AuthState } from "@/lib/adminAuth";

interface AdminRouteGuardProps {
  children: React.ReactNode;
}

export default function AdminRouteGuard({ children }: AdminRouteGuardProps) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>(() => getAuthState());

  useEffect(() => {
    let active = true;

    initAuth().then(() => {
      if (!active) return;
      setState(getAuthState());
    });

    return () => {
      active = false;
    };
  }, []);

  // Loading — show a full-screen spinner so we never flash "unauthorized"
  if (state === "loading") {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 rounded-full border-2 border-[var(--primary)] border-t-transparent animate-spin" />
          <p className="text-sm text-[var(--muted)] font-body">
            Verifying session…
          </p>
        </div>
      </div>
    );
  }

  // Unauthenticated or expired — redirect preserving the intended destination
  if (state === "unauthenticated" || state === "expired") {
    const redirect = encodeURIComponent(router.asPath);
    const reason = state === "expired" ? "&reason=expired" : "";
    router.replace(`/admin/login?redirect=${redirect}${reason}`);
    return null;
  }

  // Authenticated — render protected content
  return <>{children}</>;
}
