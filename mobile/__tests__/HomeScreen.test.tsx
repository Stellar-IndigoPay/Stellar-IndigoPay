/**
 * __tests__/HomeScreen.test.tsx
 * Unit tests for the Home screen component.
 *
 * Mocks: axios (API calls), expo-router (navigation), react-native
 * modules that require a native environment.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import axios from "axios";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));

jest.mock("../app/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#ffffff",
      text: "#000000",
      primary: "#008080",
      headerText: "#ffffff",
      secondaryText: "#666666",
      buttonText: "#ffffff",
      muted: "#999999",
    },
  }),
}));

import HomeScreen from "../app/index";

const MOCK_PROJECT = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Planting trees in the Amazon basin.",
  category: "Reforestation",
  goalXLM: "50000",
  raisedXLM: "18420",
  donorCount: 147,
};

const MOCK_STATS = {
  totalDonations: 320,
  totalXLMRaised: "45200",
};

describe("HomeScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows a loading indicator before data arrives", () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: { data: MOCK_PROJECT },
    });
    const { getByText } = render(<HomeScreen />);
    expect(getByText("Loading...")).toBeTruthy();
  });

  it("renders the app title", async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: { data: MOCK_PROJECT } })
      .mockResolvedValueOnce({ data: { data: MOCK_STATS } });

    const { getByText } = render(<HomeScreen />);
    await waitFor(() => expect(getByText("Stellar IndigoPay")).toBeTruthy());
  });

  it("fetches stats API after loading projects", async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: { data: MOCK_PROJECT } })
      .mockResolvedValueOnce({ data: { data: MOCK_STATS } });

    render(<HomeScreen />);

    // Wait for both API calls to resolve
    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  it("renders the featured project name after data loads", async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: { data: MOCK_PROJECT } })
      .mockResolvedValueOnce({ data: { data: MOCK_STATS } });

    const { getByText } = render(<HomeScreen />);
    await waitFor(() =>
      expect(getByText("Amazon Reforestation Initiative")).toBeTruthy(),
    );
  });

  it("renders the Browse All Projects button", async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: { data: MOCK_PROJECT } })
      .mockResolvedValueOnce({ data: { data: MOCK_STATS } });

    const { getByText } = render(<HomeScreen />);
    await waitFor(() => expect(getByText("Browse All Projects")).toBeTruthy());
  });

  it("still renders the title when the API call fails", async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error("network error"));

    const { getByText } = render(<HomeScreen />);
    await waitFor(() => expect(getByText("Stellar IndigoPay")).toBeTruthy());
  });
});
