import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import DonationModal from "./DonationModal";
import type { ClimateProject } from "@/utils/types";
import { within, userEvent, expect } from "@storybook/test";

const baseProject: ClimateProject = {
  id: "proj-001",
  name: "Amazon Reforestation Initiative",
  description:
    "Planting 1 million native trees across 5,000 hectares of deforested Amazon rainforest.",
  category: "Reforestation",
  location: "Brazil, Amazonas",
  walletAddress: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
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

const meta: Meta<typeof DonationModal> = {
  title: "Components/DonationModal",
  component: DonationModal,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    onClose: { action: "closed" },
    onSuccess: { action: "succeeded" },
  },
};

export default meta;
type Story = StoryObj<typeof DonationModal>;

export const Open: Story = {
  args: {
    project: baseProject,
    publicKey: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
    isOpen: true,
    onClose: () => {},
    onSuccess: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "The donation modal in its open state — semi-transparent backdrop, the donation form with close button, and focus trapped within the modal for accessibility.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    // The modal renders in a portal or fixed overlay, so we might need document.body instead of canvasElement if it's portal'd, but here it's just rendered directly.
    const canvas = within(canvasElement.parentElement || canvasElement);
    const closeBtn = canvas.getByRole("button", { name: /Close donation dialog/i });
    await expect(closeBtn).toBeInTheDocument();
    await userEvent.click(closeBtn);
  },
};

export const Closed: Story = {
  args: {
    project: baseProject,
    publicKey: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
    isOpen: false,
    onClose: () => {},
    onSuccess: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge case: modal when `isOpen` is false — nothing is rendered (null return).",
      },
    },
  },
};
