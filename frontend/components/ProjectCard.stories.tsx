import type { Meta, StoryObj } from "@storybook/react";
import ProjectCard from "./ProjectCard";
import type { ClimateProject } from "@/utils/types";

const baseProject: ClimateProject = {
  id: "proj-001",
  name: "Amazon Reforestation Initiative",
  description:
    "Planting 1 million native trees across 5,000 hectares of deforested Amazon rainforest. Local communities lead the planting and long-term stewardship, creating sustainable livelihoods while restoring critical biodiversity corridors.",
  category: "Reforestation",
  location: "Brazil, Amazonas",
  imageUrl: undefined,
  walletAddress: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
  goalXLM: "50000.0000000",
  raisedXLM: "18420.0000000",
  donorCount: 147,
  co2OffsetKg: 245000,
  co2_per_xlm: 13.3,
  status: "active",
  verified: true,
  onChainVerified: true,
  tags: ["reforestation", "community-led", "biodiversity"],
  createdAt: "2024-01-15T00:00:00Z",
  updatedAt: "2024-06-20T00:00:00Z",
  averageRating: 4.8,
  ratingCount: 89,
};

const meta: Meta<typeof ProjectCard> = {
  title: "Components/ProjectCard",
  component: ProjectCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ProjectCard>;

export const Default: Story = {
  args: {
    project: baseProject,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Standard project card showing 36.8% funding progress with verified and on-chain verification badges.",
      },
    },
  },
};

export const FullyFunded: Story = {
  args: {
    project: {
      ...baseProject,
      raisedXLM: "50000.0000000",
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Project that has reached 100% of its funding goal — shows the 'Fully Funded' badge and green progress bar.",
      },
    },
  },
};

export const Unverified: Story = {
  args: {
    project: {
      ...baseProject,
      verified: false,
      onChainVerified: false,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Project that has not yet been verified — no verification badge is shown.",
      },
    },
  },
};

export const NoGoalSet: Story = {
  args: {
    project: {
      ...baseProject,
      goalXLM: "0.0000000",
      raisedXLM: "5000.0000000",
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Project with no fundraising goal set — displays 'No goal set' instead of progress bar.",
      },
    },
  },
};

export const JustStarted: Story = {
  args: {
    project: {
      ...baseProject,
      raisedXLM: "250.0000000",
      donorCount: 3,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Newly listed project with very low funding (0.5%) and few donors.",
      },
    },
  },
};
