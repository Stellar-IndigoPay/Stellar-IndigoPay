import type { Meta, StoryObj } from "@storybook/react";
import DonationFeed from "./DonationFeed";

const meta: Meta<typeof DonationFeed> = {
  title: "Components/DonationFeed",
  component: DonationFeed,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof DonationFeed>;

export const Default: Story = {
  args: {
    projectId: "proj-001",
    walletAddress: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Donation feed with a wallet address (shows live listener indicator). The feed loads donations from the backend API on mount.",
      },
    },
  },
};

export const NoWalletAddress: Story = {
  args: {
    projectId: "proj-001",
    walletAddress: undefined,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Donation feed without a wallet address — live SSE listener is hidden.",
      },
    },
  },
};
