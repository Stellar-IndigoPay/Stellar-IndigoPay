import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { fetchProjects } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

interface GlobalSearchModalProps {
  onClose: () => void;
}

export default function GlobalSearchModal({ onClose }: GlobalSearchModalProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClimateProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, []);

  useEffect(() => {
    return () => {
      if (previousFocusRef.current) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const delayDebounceFn = setTimeout(async () => {
      setLoading(true);
      try {
        const projects = await fetchProjects({ limit: 10 });
        const filtered = projects.filter((p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.description.toLowerCase().includes(query.toLowerCase()) ||
          p.category.toLowerCase().includes(query.toLowerCase())
        );
        setResults(filtered);
        setSelectedIndex(0);
      } catch (err) {
        console.error("Search failed:", err);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(delayDebounceFn);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          results.length > 0 ? (prev + 1) % results.length : 0
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          results.length > 0 ? (prev - 1 + results.length) % results.length : 0
        );
      } else if (e.key === "Enter") {
        if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
          e.preventDefault();
          router.push(`/projects/${results[selectedIndex].id}`);
          onClose();
        }
      }
    },
    [results, selectedIndex, router, onClose]
  );

  const handleFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Tab" || !modalRef.current) return;
    const focusableElements = modalRef.current.querySelectorAll(
      'input, button, a, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length === 0) return;
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleFocusTrap);
    return () => document.removeEventListener("keydown", handleFocusTrap);
  }, [handleFocusTrap]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg mx-4 bg-[#0A0A1A]/95 dark:bg-[#050510]/95 border border-[rgba(99,102,241,0.20)] rounded-2xl shadow-2xl overflow-hidden animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="p-4 border-b border-[rgba(99,102,241,0.15)] flex items-center gap-3">
          <svg
            className="w-5 h-5 text-[#818CF8]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search verified climate projects..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-white font-body text-base outline-none placeholder-[#94A3B8]"
            aria-label="Search projects"
          />
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs font-semibold text-[#818CF8] bg-[rgba(99,102,241,0.12)] rounded-lg hover:bg-[rgba(99,102,241,0.20)] transition-colors"
          >
            ESC
          </button>
        </div>

        <div className="max-h-[300px] overflow-y-auto p-2">
          {loading ? (
            <div className="py-8 text-center text-[#94A3B8] font-body text-sm">
              Searching...
            </div>
          ) : results.length > 0 ? (
            <ul role="listbox" aria-label="Search results" className="space-y-1">
              {results.map((project, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <li
                    key={project.id}
                    role="option"
                    aria-selected={isSelected}
                    className={`rounded-xl transition-all ${
                      isSelected
                        ? "bg-[rgba(99,102,241,0.15)] text-white border border-[rgba(99,102,241,0.30)]"
                        : "text-[#94A3B8] hover:text-white hover:bg-[rgba(99,102,241,0.06)]"
                    }`}
                  >
                    <Link
                      href={`/projects/${project.id}`}
                      onClick={onClose}
                      className="block px-4 py-3 outline-none"
                    >
                      <div className="flex justify-between items-center gap-2">
                        <span className="font-display font-medium text-sm">
                          {project.name}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[rgba(99,102,241,0.08)] border border-[rgba(99,102,241,0.12)] text-[#818CF8]">
                          {project.category}
                        </span>
                      </div>
                      <p className="text-xs text-[#64748B] line-clamp-1 mt-1 font-body">
                        {project.description}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : query.trim() ? (
            <div className="py-8 text-center text-[#94A3B8] font-body text-sm">
              No projects found for &ldquo;{query}&rdquo;
            </div>
          ) : (
            <div className="py-6 text-center text-[#64748B] font-body text-xs">
              Type to search by name or category...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
