import type { Meta, StoryObj } from "@storybook/react";
import {
  SkeletonBox,
  SkeletonText,
  SkeletonAvatar,
  SkeletonBadge,
  SkeletonCard,
  SkeletonStatCard,
  SkeletonList,
  SkeletonProgressBar,
  SkeletonTableRow,
  SkeletonPageHeader,
  SkeletonDonationRow,
  SkeletonDonationList,
} from "./Skeleton";

const meta: Meta<typeof SkeletonBox> = {
  title: "Components/Skeleton",
  component: SkeletonBox,
  tags: ["autodocs"],
  argTypes: {
    palette: {
      control: "radio",
      options: ["forest", "indigo"],
    },
  },
};

export default meta;

// ── Primitives ──────────────────────────────────────────────────────────

export const Box: StoryObj<typeof SkeletonBox> = {
  args: {
    className: "w-32 h-8 rounded-xl",
    palette: "indigo",
  },
};

export const Text: StoryObj<typeof SkeletonText> = {
  render: () => <SkeletonText lines={4} palette="indigo" />,
};

export const Avatar: StoryObj<typeof SkeletonAvatar> = {
  render: (args) => (
    <div className="flex items-center gap-4">
      <SkeletonAvatar size="sm" {...args} />
      <SkeletonAvatar size="md" {...args} />
      <SkeletonAvatar size="lg" {...args} />
    </div>
  ),
  args: {
    palette: "indigo",
  },
};

export const Badge: StoryObj<typeof SkeletonBadge> = {
  render: () => <SkeletonBadge palette="indigo" />,
};

export const ProgressBar: StoryObj<typeof SkeletonProgressBar> = {
  render: () => (
    <div className="w-80">
      <SkeletonProgressBar palette="indigo" />
    </div>
  ),
};

// ── Composites ──────────────────────────────────────────────────────────

export const Card: StoryObj<typeof SkeletonCard> = {
  render: () => (
    <div className="max-w-sm">
      <SkeletonCard palette="indigo" />
    </div>
  ),
};

export const StatCard: StoryObj<typeof SkeletonStatCard> = {
  render: () => (
    <div className="max-w-xs">
      <SkeletonStatCard palette="indigo" />
    </div>
  ),
};

export const TableRow: StoryObj<typeof SkeletonTableRow> = {
  render: () => (
    <div className="max-w-md">
      <SkeletonTableRow withAvatar palette="indigo" />
    </div>
  ),
};

export const List: StoryObj<typeof SkeletonList> = {
  render: () => (
    <div className="max-w-md">
      <SkeletonList rows={5} withAvatar palette="indigo" />
    </div>
  ),
};

export const PageHeader: StoryObj<typeof SkeletonPageHeader> = {
  render: () => (
    <div className="max-w-lg">
      <SkeletonPageHeader palette="indigo" />
    </div>
  ),
};

export const DonationRow: StoryObj<typeof SkeletonDonationRow> = {
  render: () => (
    <div className="max-w-md">
      <SkeletonDonationRow palette="indigo" />
    </div>
  ),
};

export const DonationList: StoryObj<typeof SkeletonDonationList> = {
  render: () => (
    <div className="max-w-md">
      <SkeletonDonationList rows={4} palette="indigo" />
    </div>
  ),
};
