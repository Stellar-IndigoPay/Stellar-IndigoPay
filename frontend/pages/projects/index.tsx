/**
 * pages/projects/index.tsx — Browse all climate projects
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import ProjectCard, { ProjectCardSkeleton } from "@/components/ProjectCard";
import ProjectComparison from "@/components/ProjectComparison";
import {
  fetchProjects,
  fetchProjectFacets,
  fetchTagSuggestions,
  type ProjectFacets,
} from "@/lib/api";
import { PROJECT_CATEGORIES, CATEGORY_ICONS } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import clsx from "clsx";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [facets, setFacets] = useState<ProjectFacets | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);

  const {
    query: search,
    setQuery: setSearch,
    results: autocompleteResults,
    isOpen: isAutocompleteOpen,
    setIsOpen: setIsAutocompleteOpen,
    activeIndex,
    handleKeyDown,
  } = useAutocomplete<string>(fetchTagSuggestions);

  const category = (router.query.category as string) || "";
  const status = (router.query.status as string) || "active";
  const verified = (router.query.verified as string) === "true";
  const searchQuery = (router.query.search as string) || "";
  const compareQuery = (router.query.compare as string) || "";
  const location = (router.query.location as string) || "";
  const co2Min = (router.query.co2Min as string) || "";
  const co2Max = (router.query.co2Max as string) || "";

  const hasActiveFilters = Boolean(
    category || status !== "active" || verified || search || location || co2Min || co2Max,
  );

  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedProjectIds.includes(project.id)),
    [projects, selectedProjectIds],
  );

  // Initialize search from URL query parameter
  useEffect(() => {
    if (searchQuery && !search) {
      setSearch(searchQuery);
    }
  }, [searchQuery, search, setSearch]);

  // Click outside listener for autocomplete
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsAutocompleteOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [setIsAutocompleteOpen]);

  // Debounced search effect
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      const filters = {
        category: category || undefined,
        status: status || undefined,
        verified: verified || undefined,
        search: search || undefined,
        location: location || undefined,
        co2Min: co2Min ? Number(co2Min) : undefined,
        co2Max: co2Max ? Number(co2Max) : undefined,
      };
      fetchProjects({ ...filters, limit: 50 })
        .then(setProjects)
        .catch(console.error)
        .finally(() => setLoading(false));
      fetchProjectFacets(filters)
        .then(setFacets)
        .catch(() => setFacets(null));
    }, 300);

    return () => clearTimeout(timer);
  }, [category, status, verified, search, location, co2Min, co2Max]);

  useEffect(() => {
    if (!compareQuery || projects.length === 0) return;
    const ids = compareQuery
      .split(",")
      .map((id) => id.trim())
      .filter((id) => projects.some((project) => project.id === id))
      .slice(0, 3);
    if (ids.length >= 2) {
      setSelectedProjectIds(ids);
      setShowComparison(true);
    }
  }, [compareQuery, projects]);

  const setFilter = (key: string, val: string) => {
    router.push(
      {
        pathname: "/projects",
        query: { ...router.query, [key]: val || undefined },
      },
      undefined,
      { shallow: true },
    );
  };

  const setFilters = (updates: Record<string, string>) => {
    router.push(
      {
        pathname: "/projects",
        query: {
          ...router.query,
          ...Object.fromEntries(
            Object.entries(updates).map(([key, val]) => [key, val || undefined]),
          ),
        },
      },
      undefined,
      { shallow: true },
    );
  };

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearch(value);

      // Update URL with search query (debounced would be better but keeping simple for now)
      const timer = setTimeout(() => {
        router.push(
          {
            pathname: "/projects",
            query: { ...router.query, search: value || undefined },
          },
          undefined,
          { shallow: true },
        );
      }, 500);
      return () => clearTimeout(timer);
    },
    [router, setSearch],
  );

  const handleSelectTag = (tag: string) => {
    setSearch(tag);
    setIsAutocompleteOpen(false);
    router.push(
      {
        pathname: "/projects",
        query: { ...router.query, search: tag },
      },
      undefined,
      { shallow: true },
    );
  };

  const toggleSelection = (projectId: string) => {
    setSelectedProjectIds((current) => {
      if (current.includes(projectId)) {
        return current.filter((id) => id !== projectId);
      }
      if (current.length >= 3) {
        return current;
      }
      return [...current, projectId];
    });
  };

  const clearAllFilters = () => {
    setSearch("");
    router.push(
      { pathname: "/projects", query: {} },
      undefined,
      { shallow: true },
    );
  };

  const facetCount = (
    group: keyof ProjectFacets,
    value: string,
  ): number | null => {
    const entry = facets?.[group]?.find((f) => f.value === value);
    return entry ? entry.count : null;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">
            Climate Projects
          </h1>
          <p
            className="text-[#5a7a5a] dark:text-[#8aaa8a] text-sm font-body"
            aria-live="polite"
          >
            {loading
              ? "Loading..."
              : `Showing ${projects.length} project${projects.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        {hasActiveFilters && (
          <button
            onClick={clearAllFilters}
            className="text-xs font-semibold text-forest-600 hover:text-forest-800 font-body underline self-start sm:self-auto"
          >
            Clear all filters
          </button>
        )}
      </div>

      {/* Filter chips (mobile-friendly) */}
      <div className="flex flex-wrap gap-2 mb-6 lg:hidden">
        <button
          onClick={() => setFilter("category", "")}
          className={clsx(
            "px-3 py-1.5 rounded-full text-sm font-medium border transition-all font-body",
            !category
              ? "bg-forest-500 text-white border-forest-500"
              : "bg-white text-forest-700 border-forest-200 hover:border-forest-400",
          )}
        >
          All
        </button>
        {PROJECT_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter("category", cat)}
            className={clsx(
              "px-3 py-1.5 rounded-full text-sm font-medium border transition-all font-body flex items-center gap-1.5",
              category === cat
                ? "bg-forest-500 text-white border-forest-500"
                : "bg-white text-forest-700 border-forest-200 hover:border-forest-400",
            )}
          >
            <span>{CATEGORY_ICONS[cat]}</span>
            {cat}
          </button>
        ))}
      </div>

      {/* Active filter summary */}
      {hasActiveFilters && (
        <div
          role="list"
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-2 mb-4"
        >
          <span className="text-xs text-[#8aaa8a] dark:text-forest-300 font-body">
            Active filters:
          </span>
          {category && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              {CATEGORY_ICONS[category]} {category}
              <button
                onClick={() => setFilter("category", "")}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
          {status !== "active" && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              {status || "All"} status
              <button
                onClick={() => setFilter("status", "active")}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
          {verified && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              ✓ Verified
              <button
                onClick={() => setFilter("verified", "")}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
          {search && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              🔍 {search}
              <button
                onClick={() => {
                  setSearch("");
                  setFilter("search", "");
                }}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
          {location && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              📍 {location}
              <button
                onClick={() => setFilter("location", "")}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
          {(co2Min || co2Max) && (
            <span role="listitem" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-forest-100 text-forest-700 text-xs font-body">
              CO₂ {co2Min || "0"}–{co2Max || "∞"} kg
              <button
                onClick={() => setFilters({ co2Min: "", co2Max: "" })}
                className="ml-1 hover:text-forest-900"
              >
                ✕
              </button>
            </span>
          )}
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6" ref={searchRef}>
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8aaa8a] dark:text-forest-300 z-10">
          🔍
        </span>
        <input
          type="text"
          value={search}
          onChange={handleSearchChange}
          onKeyDown={(e) => {
            handleKeyDown(e);
            if (e.key === "Enter" && activeIndex >= 0) {
              handleSelectTag(autocompleteResults[activeIndex]);
            }
          }}
          onFocus={() => search.length >= 2 && setIsAutocompleteOpen(true)}
          placeholder="Search projects by name, location, or tag..."
          aria-label="Search projects"
          role="combobox"
          aria-expanded={isAutocompleteOpen}
          aria-autocomplete="list"
          aria-controls="tag-autocomplete-list"
          className="input-field pl-10 relative z-10"
        />

        {/* Tag autocomplete dropdown */}
        {isAutocompleteOpen && (
          <ul
            id="tag-autocomplete-list"
            role="listbox"
            className="absolute top-full left-0 right-0 mt-2 bg-white border border-forest-200 rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in"
          >
            {autocompleteResults.map((tag, i) => (
              <li
                key={tag}
                role="option"
                aria-selected={i === activeIndex}
                onClick={() => handleSelectTag(tag)}
                className={clsx(
                  "flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-forest-50 last:border-0",
                  i === activeIndex ? "bg-forest-100" : "hover:bg-forest-50",
                )}
              >
                <div className="w-8 h-8 rounded-lg bg-forest-100 flex items-center justify-center text-sm font-semibold text-forest-700 flex-shrink-0">
                  #
                </div>
                <p className="text-sm font-semibold text-forest-900 truncate">
                  {tag}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-6">
        {/* Sidebar */}
        <aside className="hidden lg:block w-52 flex-shrink-0 space-y-6">
          <div>
            <p className="label">Status</p>
            <div className="space-y-1">
              {[
                ["active", "Active"],
                ["completed", "Completed"],
                ["", "All"],
              ].map(([val, lab]) => (
                <button
                  key={val}
                  onClick={() => setFilter("status", val)}
                  className={clsx(
                    "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors font-body",
                    status === val
                      ? "bg-forest-100 text-forest-700 font-semibold"
                      : "text-[#5a7a5a] dark:text-[#8aaa8a] hover:bg-forest-50 hover:text-forest-700",
                  )}
                >
                  {lab}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="label">Verification</p>
            <button
              onClick={() => setFilter("verified", verified ? "" : "true")}
              className={clsx(
                "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors font-body",
                verified
                  ? "bg-forest-100 text-forest-700"
                  : "text-[#5a7a5a] dark:text-[#8aaa8a] hover:bg-forest-50 hover:text-forest-700",
              )}
            >
              {/* Toggle Switch */}
              <div
                className={clsx(
                  "relative w-10 h-6 rounded-full transition-colors",
                  verified ? "bg-emerald-600" : "bg-[#d0d0d0]",
                )}
              >
                <div
                  className={clsx(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                    verified ? "right-1" : "left-1",
                  )}
                />
              </div>
              <span className="flex-1 text-left">
                ✓ Verified only{" "}
                <span className="text-xs text-[#8aaa8a] dark:text-forest-300">
                  ({projects.filter((p) => p.verified).length})
                </span>
              </span>
            </button>
          </div>

          <div>
            <p className="label">Category</p>
            <div className="space-y-1">
              <button
                onClick={() => setFilter("category", "")}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors font-body",
                  !category
                    ? "bg-forest-100 text-forest-700 font-semibold"
                    : "text-[#5a7a5a] dark:text-[#8aaa8a] hover:bg-forest-50 hover:text-forest-700",
                )}
              >
                All Categories
              </button>
              {PROJECT_CATEGORIES.map((cat) => {
                const count = facetCount("category", cat);
                return (
                  <button
                    key={cat}
                    onClick={() => setFilter("category", cat)}
                    className={clsx(
                      "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors font-body flex items-center gap-2",
                      category === cat
                        ? "bg-forest-100 text-forest-700 font-semibold"
                        : "text-[#5a7a5a] dark:text-[#8aaa8a] hover:bg-forest-50 hover:text-forest-700",
                    )}
                  >
                    <span>{CATEGORY_ICONS[cat]}</span>
                    <span className="flex-1">{cat}</span>
                    {count !== null && (
                      <span className="text-xs text-[#8aaa8a] dark:text-forest-300">
                        ({count})
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="location-filter" className="label">
              Location
            </label>
            <input
              id="location-filter"
              key={location}
              type="text"
              defaultValue={location}
              onBlur={(e) => setFilter("location", e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setFilter("location", (e.target as HTMLInputElement).value.trim());
                }
              }}
              placeholder="e.g. Kenya"
              className="input-field text-sm py-2 px-3 w-full"
            />
          </div>

          <div>
            <p className="label">CO₂ offset (kg)</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                key={`co2Min-${co2Min}`}
                defaultValue={co2Min}
                onBlur={(e) => setFilter("co2Min", e.target.value)}
                placeholder="Min"
                aria-label="Minimum CO2 offset in kilograms"
                className="input-field text-sm py-2 px-2 w-full"
              />
              <span className="text-[#8aaa8a]">–</span>
              <input
                type="number"
                min={0}
                key={`co2Max-${co2Max}`}
                defaultValue={co2Max}
                onBlur={(e) => setFilter("co2Max", e.target.value)}
                placeholder="Max"
                aria-label="Maximum CO2 offset in kilograms"
                className="input-field text-sm py-2 px-2 w-full"
              />
            </div>
          </div>
        </aside>

        {/* Grid */}
        <div className="flex-1">
          {selectedProjectIds.length >= 2 && (
            <div className="mb-4 flex items-center justify-between rounded-xl border border-forest-200 bg-forest-50 px-4 py-3">
              <p className="text-sm text-forest-800 font-body">
                {selectedProjectIds.length} selected for comparison
              </p>
              <button
                type="button"
                onClick={() => setShowComparison(true)}
                className="btn-primary text-sm py-2 px-4"
              >
                Compare selected
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="card text-center py-16">
              <p className="text-4xl mb-3">🌿</p>
              <p className="font-display text-xl text-forest-900 mb-2">
                {hasActiveFilters
                  ? "No projects match your filters"
                  : "No projects available yet"}
              </p>
              <p className="text-[#5a7a5a] dark:text-[#8aaa8a] text-sm font-body mb-4">
                {hasActiveFilters
                  ? "Try adjusting your search or filters."
                  : "Check back soon, or apply to list a project."}
              </p>
              {hasActiveFilters && (
                <button
                  onClick={clearAllFilters}
                  className="btn-secondary text-sm py-2 px-4"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => (
                <div key={p.id} className="relative">
                  <label
                    className={`absolute left-3 top-3 z-30 flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-body shadow-sm ${
                      selectedProjectIds.includes(p.id)
                        ? "bg-forest-700 text-white border-forest-700"
                        : "bg-white text-forest-700 border-forest-200"
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedProjectIds.includes(p.id)}
                      onChange={() => toggleSelection(p.id)}
                      disabled={
                        selectedProjectIds.length >= 3 &&
                        !selectedProjectIds.includes(p.id)
                      }
                    />
                    Compare
                  </label>
                  <ProjectCard project={p} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showComparison && selectedProjects.length >= 2 && (
        <ProjectComparison
          projects={selectedProjects}
          onClose={() => setShowComparison(false)}
        />
      )}
    </div>
  );
}
