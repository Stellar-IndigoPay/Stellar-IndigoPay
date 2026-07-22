import type { Meta, StoryObj } from "@storybook/react";
import Tabs from "./Tabs";
import type { TabItem } from "./Tabs";

const sampleTabs: TabItem[] = [
  {
    id: "overview",
    label: "Overview",
    content: (
      <div className="p-4">
        <h3 className="font-semibold mb-2">Project Overview</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          This is the overview tab content. It shows the high-level summary of
          the project status and key metrics.
        </p>
      </div>
    ),
  },
  {
    id: "donations",
    label: (
      <>
        Donations
        <span className="px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
          12
        </span>
      </>
    ),
    content: (
      <div className="p-4">
        <h3 className="font-semibold mb-2">Recent Donations</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          List of recent donations would appear here.
        </p>
      </div>
    ),
  },
  {
    id: "updates",
    label: "Updates",
    content: (
      <div className="p-4">
        <h3 className="font-semibold mb-2">Project Updates</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Timeline of project milestones and updates.
        </p>
      </div>
    ),
  },
  {
    id: "impact",
    label: "Impact",
    content: (
      <div className="p-4">
        <h3 className="font-semibold mb-2">Environmental Impact</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          CO₂ offset metrics and environmental reports.
        </p>
      </div>
    ),
  },
];

const meta: Meta<typeof Tabs> = {
  title: "Components/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  args: {
    tabs: sampleTabs,
    ariaLabel: "Project details",
  },
};

export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {
  args: {
    defaultValue: "overview",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Standard tabs with the first tab selected by default. Includes tabs with inline badges in labels.",
      },
    },
  },
};

export const SecondTabSelected: Story = {
  args: {
    defaultValue: "donations",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Tabs with the second tab (Donations, with badge) selected by default.",
      },
    },
  },
};

export const Controlled: Story = {
  args: {
    value: "impact",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Tabs in controlled mode — the `value` prop determines the active tab and cannot be changed by clicking.",
      },
    },
  },
};

export const SingleTab: Story = {
  args: {
    tabs: [sampleTabs[0]],
    defaultValue: "overview",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge case: only one tab is present. The tab still renders with proper ARIA attributes.",
      },
    },
  },
};

export const EmptyTabs: Story = {
  args: {
    tabs: [],
    ariaLabel: "Empty tabs",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge case: no tabs provided. Nothing is rendered (empty fragment).",
      },
    },
  },
};
