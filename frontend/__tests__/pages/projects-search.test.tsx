/**
 * __tests__/pages/projects-search.test.tsx
 *
 * Covers the search/filter experience on the projects browse page (GF-016):
 * debounced search-as-you-type, URL-synced filters (location, CO2 range),
 * facet counts, "Clear all filters", and empty-state rendering.
 *
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ProjectsPage from "@/pages/projects/index";
import type { ClimateProject } from "@/utils/types";
import type { ProjectFacets } from "@/lib/api";

let mockQuery: Record<string, string> = {};
const mockPush = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({
    query: mockQuery,
    pathname: "/projects",
    push: mockPush,
  }),
}));

const mockFetchProjects = jest.fn();
const mockFetchProjectFacets = jest.fn();
const mockFetchTagSuggestions = jest.fn().mockResolvedValue([]);

jest.mock("@/lib/api", () => ({
  fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
  fetchProjectFacets: (...args: unknown[]) => mockFetchProjectFacets(...args),
  fetchTagSuggestions: (...args: unknown[]) => mockFetchTagSuggestions(...args),
}));

const MOCK_PROJECT: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover across degraded rainforest land.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "10000",
  raisedXLM: "2500",
  donorCount: 42,
  co2OffsetKg: 1200,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["trees", "carbon"],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const MOCK_FACETS: ProjectFacets = {
  category: [{ value: "Reforestation", count: 12 }],
  location: [{ value: "Brazil", count: 5 }],
  status: [{ value: "active", count: 45 }],
};

describe("ProjectsPage search and filters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockQuery = {};
    mockFetchProjects.mockResolvedValue([MOCK_PROJECT]);
    mockFetchProjectFacets.mockResolvedValue(MOCK_FACETS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("initializes filters from the URL on load and fetches accordingly", async () => {
    mockQuery = { category: "Reforestation", verified: "true", status: "active" };

    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(mockFetchProjects).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "Reforestation",
          verified: true,
          status: "active",
        }),
        expect.anything(), // AbortSignal, added for request cancellation (#257)
      );
    });
  });

  test("debounces search input so the API is called once after 300ms", async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(1));
    mockFetchProjects.mockClear();

    const input = screen.getByLabelText("Search projects");
    fireEvent.change(input, { target: { value: "forest" } });

    // Not yet — debounce hasn't elapsed.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(mockFetchProjects).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await waitFor(() => {
      expect(mockFetchProjects).toHaveBeenCalledTimes(1);
      expect(mockFetchProjects).toHaveBeenCalledWith(
        expect.objectContaining({ search: "forest" }),
        expect.anything(), // AbortSignal, added for request cancellation (#257)
      );
    });
  });

  test("clicking a category filter updates the URL search params", async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());

    const categoryButtons = screen.getAllByRole("button", { name: /Reforestation/i });
    fireEvent.click(categoryButtons[0]);

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/projects",
        query: expect.objectContaining({ category: "Reforestation" }),
      }),
      undefined,
      { shallow: true },
    );
  });

  test("shows facet counts next to category filters", async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.getByText("(12)")).toBeTruthy();
    });
  });

  test("filters by location and CO2 range via the sidebar inputs", async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());

    fireEvent.blur(screen.getByPlaceholderText("e.g. Kenya"), {
      target: { value: "Kenya" },
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ location: "Kenya" }),
      }),
      undefined,
      { shallow: true },
    );

    fireEvent.blur(screen.getByPlaceholderText("Min"), { target: { value: "1000" } });
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ co2Min: "1000" }),
      }),
      undefined,
      { shallow: true },
    );
  });

  test('"Clear all filters" removes all query params', async () => {
    mockQuery = { category: "Reforestation", location: "Kenya", verified: "true" };

    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));

    expect(mockPush).toHaveBeenCalledWith(
      { pathname: "/projects", query: {} },
      undefined,
      { shallow: true },
    );
  });

  test('renders "No projects match your filters" empty state with filters active', async () => {
    mockQuery = { category: "Reforestation" };
    mockFetchProjects.mockResolvedValue([]);

    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.getByText("No projects match your filters")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  test('renders "No projects available yet" empty state without filters', async () => {
    mockFetchProjects.mockResolvedValue([]);

    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.getByText("No projects available yet")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  test("renders loading skeletons before results arrive", async () => {
    let resolveFetch: (value: ClimateProject[]) => void = () => {};
    mockFetchProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(screen.getByText("Loading...")).toBeTruthy();

    await act(async () => {
      resolveFetch([MOCK_PROJECT]);
      await Promise.resolve();
    });
  });

  test("announces the results count via an aria-live region", async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      const region = screen.getByText(/Showing 1 project/i);
      expect(region.getAttribute("aria-live")).toBe("polite");
    });
  });

  // ─── AbortController tests (#257) ──────────────────────────────────────────

  test("aborts the in-flight request when a newer search supersedes it", async () => {
    let firstSignal: AbortSignal | undefined;
    mockFetchProjects.mockImplementation((_params: unknown, signal?: AbortSignal) => {
      firstSignal = signal;
      return new Promise(() => {
        /* never resolves — simulates a slow first request */
      });
    });

    render(<ProjectsPage />);
    const input = screen.getByLabelText("Search projects");

    fireEvent.change(input, { target: { value: "reforestation" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(firstSignal?.aborted).toBe(false);

    // A second, different search value supersedes the first in-flight one.
    mockFetchProjects.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(input, { target: { value: "ocean cleanup" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(firstSignal?.aborted).toBe(true);
  });

  test('shows a "Searching..." indicator while a search request is in-flight, and hides it after resolving', async () => {
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(1));

    let resolveFetch: (value: ClimateProject[]) => void = () => {};
    mockFetchProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const input = screen.getByLabelText("Search projects");
    fireEvent.change(input, { target: { value: "solar" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(await screen.findByText(/searching/i)).toBeInTheDocument();

    await act(async () => {
      resolveFetch([MOCK_PROJECT]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText(/searching/i)).not.toBeInTheDocument();
    });
  });

  test("logs but does not crash on a non-abort search error", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    render(<ProjectsPage />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(1));

    mockFetchProjects.mockRejectedValue(new Error("Network down"));
    const input = screen.getByLabelText("Search projects");
    fireEvent.change(input, { target: { value: "wind" } });

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith("Search failed:", expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  test("does not log or act on an aborted request's own rejection", async () => {
    mockFetchProjects.mockImplementation((_params: unknown, signal?: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err: any = new Error("canceled");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    render(<ProjectsPage />);
    const input = screen.getByLabelText("Search projects");

    fireEvent.change(input, { target: { value: "first" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // Triggering a second search aborts the first in-flight request.
    fireEvent.change(input, { target: { value: "second" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // The AbortError from the superseded first request must never be
    // logged as a failure.
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      "Search failed:",
      expect.objectContaining({ name: "AbortError" }),
    );
    consoleErrorSpy.mockRestore();
  });
});
