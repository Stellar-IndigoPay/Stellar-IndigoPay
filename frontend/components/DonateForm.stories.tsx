import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import DonateForm from "./DonateForm";
import type { ClimateProject } from "@/utils/types";

const MOCK_WALLET_ADDRESS =
  "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7";

const baseProject: ClimateProject = {
  id: "proj-001",
  name: "Amazon Reforestation Initiative",
  description:
    "Planting 1 million native trees across 5,000 hectares of deforested Amazon rainforest.",
  category: "Reforestation",
  location: "Brazil, Amazonas",
  walletAddress: MOCK_WALLET_ADDRESS,
  goalXLM: "50000.0000000",
  raisedXLM: "18420.0000000",
  donorCount: 147,
  co2OffsetKg: 245000,
  co2_per_xlm: 13.3,
  status: "active",
  verified: true,
  tags: ["reforestation", "community-led"],
  createdAt: "2024-01-15T00:00:00Z",
  updatedAt: "2024-06-20T00:00:00Z",
};

const meta: Meta<typeof DonateForm> = {
  title: "Components/DonateForm",
  component: DonateForm,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-md mx-auto">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    onSuccess: { action: "succeeded" },
  },
};

export default meta;
type Story = StoryObj<typeof DonateForm>;

export const Default: Story = {
  args: {
    project: baseProject,
    publicKey: MOCK_WALLET_ADDRESS,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Standard donation form in idle state with XLM currency, preset amount buttons, custom input, and message field.",
      },
    },
  },
};

export const WithPresetAmount: Story = {
  args: {
    project: baseProject,
    publicKey: MOCK_WALLET_ADDRESS,
    initialAmount: "100",
    initialMessage: "For the trees! 🌳",
  },
};

export const MessageNearLimit: Story = {
  args: {
    project: baseProject,
    publicKey: MOCK_WALLET_ADDRESS,
    initialAmount: "10",
    initialMessage:
      "This is a message that is getting close to the hundred character limit for donation messages on the feed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Character counter turns amber (>80 chars) as the message approaches the 100-character limit.",
      },
    },
  },
};
