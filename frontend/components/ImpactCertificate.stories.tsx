import type { Meta, StoryObj } from "@storybook/react";
import ImpactCertificate from "./ImpactCertificate";
import type { BadgeTier } from "@/utils/types";

const meta: Meta<typeof ImpactCertificate> = {
  title: "Components/ImpactCertificate",
  component: ImpactCertificate,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ImpactCertificate>;

const baseArgs = {
  donorAddress: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
  totalDonatedXLM: "12500.0000000",
  totalCO2OffsetKg: 166250,
  projectsSupported: [
    { id: "1", name: "Amazon Reforestation Initiative" },
    { id: "2", name: "Solar Schools Kenya" },
    { id: "3", name: "Ocean Cleanup Pacific" },
    { id: "4", name: "Wind Farm Rajasthan" },
  ],
};

export const Default: Story = {
  args: {
    ...baseArgs,
    donorName: "Jane Climate",
    badgeTier: "tree" as BadgeTier,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Impact certificate for a donor with a display name and Tree-tier badge. Shows total XLM donated, CO₂ offset, and 4 projects supported.",
      },
    },
  },
};

export const NoDisplayName: Story = {
  args: {
    ...baseArgs,
    donorName: null,
    badgeTier: "seedling" as BadgeTier,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Certificate where the donor has no display name set — their shortened public key is shown instead.",
      },
    },
  },
};

export const EarthGuardian: Story = {
  args: {
    ...baseArgs,
    donorName: "Big Green Donor",
    badgeTier: "earth" as BadgeTier,
    totalDonatedXLM: "500000.0000000",
    totalCO2OffsetKg: 6650000,
    projectsSupported: [
      { id: "1", name: "Amazon Reforestation Initiative" },
      { id: "2", name: "Solar Schools Kenya" },
      { id: "3", name: "Ocean Cleanup Pacific" },
      { id: "4", name: "Wind Farm Rajasthan" },
      { id: "5", name: "Mangrove Restoration" },
      { id: "6", name: "Clean Cookstoves Uganda" },
      { id: "7", name: "Coral Reef Revival" },
      { id: "8", name: "Urban Forests Europe" },
      { id: "9", name: "Hydropower Nepal" },
      { id: "10", name: "Peatland Protection" },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Earth Guardian (top tier) certificate with 10+ projects supported — shows '+2 more' truncation beyond 8 projects.",
      },
    },
  },
};

export const NoBadge: Story = {
  args: {
    ...baseArgs,
    donorName: "New Donor",
    badgeTier: null,
    totalDonatedXLM: "100.0000000",
    totalCO2OffsetKg: 1330,
    projectsSupported: [{ id: "1", name: "Amazon Reforestation Initiative" }],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge case: donor with no badge tier — defaults to 'Supporter' label and generic medal emoji.",
      },
    },
  },
};

export const NoProjects: Story = {
  args: {
    ...baseArgs,
    donorName: "Fresh Account",
    badgeTier: null,
    totalDonatedXLM: "0.0000000",
    totalCO2OffsetKg: 0,
    projectsSupported: [],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge case: donor with zero donations and no supported projects — shows 'Projects Supported' section empty message.",
      },
    },
  },
};
