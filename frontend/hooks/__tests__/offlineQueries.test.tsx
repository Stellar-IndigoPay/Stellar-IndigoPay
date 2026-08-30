/** @jest-environment jsdom */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useProject, useProjects, queryKeys } from "@/hooks/queries";
import { fetchProject, fetchProjects } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

jest.mock("@/lib/api", () => ({
  fetchProject: jest.fn(),
  fetchProjects: jest.fn(),
}));

const mockedFetchProject = fetchProject as jest.Mock;
const mockedFetchProjects = fetchProjects as jest.Mock;
const cachedProject = { id: "cached-project", name: "Cached project" } as ClimateProject;

describe("React Query offline cache behavior", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
    jest.clearAllMocks();
  });

  it("keeps cached project data visible offline and refetches on reconnect", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.projects(), [cachedProject]);
    mockedFetchProjects.mockResolvedValue([{ ...cachedProject, name: "Fresh project" }]);
    onlineManager.setOnline(false);

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useProjects(), { wrapper: Wrapper });
    expect(result.current.data).toEqual([cachedProject]);
    expect(result.current.isLoading).toBe(false);
    expect(mockedFetchProjects).not.toHaveBeenCalled();

    await queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    expect(mockedFetchProjects).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await waitFor(() => expect(result.current.data?.[0].name).toBe("Fresh project"));
    expect(mockedFetchProjects).toHaveBeenCalledTimes(1);
  });

  it("renders a previously cached project immediately when returning to its route", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.project("cached-project"), cachedProject);

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useProject("cached-project"), {
      wrapper: Wrapper,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(cachedProject);
    expect(mockedFetchProject).not.toHaveBeenCalled();
  });
});
