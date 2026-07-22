/**
 * components/ShareButton.tsx
 * Reusable social sharing buttons for Twitter, LinkedIn, and clipboard copy.
 * Displays icons with hover states and "Copied!" feedback for the copy action.
 */

import { useCallback, useState } from "react";

export interface ShareButtonProps {
  /** Full URL to share. */
  url: string;
  /** Pre-formatted share text (used by Twitter). */
  text?: string;
  /** Optional title attribute for the share. */
  title?: string;
  /** Additional CSS classes to merge onto the container. */
  className?: string;
}

/**
 * Preset share text for donor profiles. Builds a platform-formatted message
 * from the donor's impact stats.
 */
export function donorShareText(
  displayName: string,
  totalDonatedXLM: string,
  projectsSupported: number,
): string {
  const xlm = parseFloat(totalDonatedXLM);
  const formatted = isNaN(xlm)
    ? totalDonatedXLM
    : `${xlm.toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM`;
  return `${displayName} donated ${formatted} to ${projectsSupported} climate project${projectsSupported !== 1 ? "s" : ""} on @StellarIndigoPay! 🌍 Check out the impact:`;
}

/**
 * Social share buttons for Twitter/X and LinkedIn, plus a "Copy link" button.
 */
export default function ShareButton({
  url,
  text,
  title,
  className = "",
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const encodedUrl = encodeURIComponent(url);
  const encodedText = text ? encodeURIComponent(text) : "";

  const shareLinks = {
    twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
  };

  const handleCopyLink = useCallback(async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback for older browsers or non-HTTPS contexts
      try {
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      } catch {
        setCopyError(true);
        setTimeout(() => setCopyError(false), 2200);
      }
    }
  }, [url]);

  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${className}`}
      role="group"
      aria-label="Share this profile"
    >
      {/* Twitter / X */}
      <a
        href={shareLinks.twitter}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200 bg-[#1DA1F2]/10 text-[#1DA1F2] border border-[#1DA1F2]/20 hover:bg-[#1DA1F2] hover:text-white hover:border-[#1DA1F2] hover:shadow-md hover:shadow-[#1DA1F2]/20 active:scale-95"
        aria-label="Share on Twitter / X"
        title={title || "Share on Twitter / X"}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        <span className="hidden sm:inline">Twitter</span>
      </a>

      {/* LinkedIn */}
      <a
        href={shareLinks.linkedin}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200 bg-[#0A66C2]/10 text-[#0A66C2] border border-[#0A66C2]/20 hover:bg-[#0A66C2] hover:text-white hover:border-[#0A66C2] hover:shadow-md hover:shadow-[#0A66C2]/20 active:scale-95"
        aria-label="Share on LinkedIn"
        title={title || "Share on LinkedIn"}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
        </svg>
        <span className="hidden sm:inline">LinkedIn</span>
      </a>

      {/* Copy link */}
      <button
        onClick={handleCopyLink}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200 bg-[rgba(34,114,57,0.08)] text-[#227239] border border-[rgba(34,114,57,0.15)] hover:bg-[#227239] hover:text-white hover:border-[#227239] hover:shadow-md hover:shadow-[rgba(34,114,57,0.15)] active:scale-95"
        aria-label="Copy profile link to clipboard"
        title="Copy link"
      >
        {copied ? (
          <>
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Copied!</span>
          </>
        ) : copyError ? (
          <>
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>Error</span>
          </>
        ) : (
          <>
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span>Copy link</span>
          </>
        )}
      </button>
    </div>
  );
}
