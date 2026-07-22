import type { Meta, StoryObj } from "@storybook/react";
import DonationModal from "./DonationModal";
import type { ClimateProject } from "@/utils/types";

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
