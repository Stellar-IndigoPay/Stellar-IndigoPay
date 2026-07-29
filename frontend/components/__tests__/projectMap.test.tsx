import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import ProjectMap from "@/components/ProjectMap";
import type { ClimateProject } from "@/utils/types";
import { useMap } from "react-leaflet";

jest.mock("next/link", () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

const mockProjects: ClimateProject[] = [
  {
    id: "proj-1",
    name: "Amazon Reforestation",
    description: "Restoring rainforest cover.",
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
    tags: ["trees"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: "proj-2",
    name: "Amazon Conservation",
    description: "Saving trees in Brazil.",
    category: "Reforestation",
    location: "Brazil",
    walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    goalXLM: "20000",
    raisedXLM: "5000",
    donorCount: 24,
    co2OffsetKg: 2000,
    status: "active",
    verified: true,
    onChainVerified: false,
    tags: ["trees"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: "proj-3",
    name: "Kenya Solar Grid",
    description: "Solar panels.",
    category: "Solar Energy",
    location: "Kenya",
    walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    goalXLM: "30000",
    raisedXLM: "15000",
    donorCount: 88,
    co2OffsetKg: 5000,
    status: "active",
    verified: true,
    onChainVerified: false,
    tags: ["solar"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  }
];

describe("ProjectMap Clustering", () => {
  it("renders clusters for nearby markers and single markers for far away ones", () => {
    const map = useMap();
    const fitBoundsSpy = jest.fn();
    map.onFitBounds = fitBoundsSpy;

    const { container } = render(<ProjectMap projects={mockProjects} />);

    const clusterElement = container.querySelector(".cluster-marker-mock");
    expect(clusterElement).toBeInTheDocument();
    expect(clusterElement?.textContent?.trim()).toBe("2");

    expect(screen.getByText("Kenya Solar Grid")).toBeInTheDocument();
    expect(screen.getByText("Solar Energy · Kenya")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Donate →" })).toHaveAttribute(
      "href",
      "/donate?project=proj-3"
    );

    // Click cluster to test zoom and expanding behavior
    fireEvent.click(clusterElement!);
    expect(fitBoundsSpy).toHaveBeenCalled();
  });
});
