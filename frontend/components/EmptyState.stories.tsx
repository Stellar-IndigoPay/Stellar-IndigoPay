import type { Meta, StoryObj } from "@storybook/react";
import EmptyState from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Components/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "radio",
      options: ["empty", "search", "error"],
    },
  },
};

export default meta;

export const Empty: StoryObj<typeof EmptyState> = {
  args: {
    variant: "empty",
    title: "No donations yet",
    description: "Be the first to support a climate project.",
  },
};

export const EmptyWithAction: StoryObj<typeof EmptyState> = {
  args: {
    variant: "empty",
    title: "No saved projects yet",
    description: "Save projects you're interested in to track their progress.",
    action: <button className="btn-primary text-sm">Explore Projects</button>,
  },
};

export const SearchNoResults: StoryObj<typeof EmptyState> = {
  args: {
    variant: "search",
    title: "No projects match your filters",
    description: "Try adjusting your search or filters.",
    action: (
      <button className="btn-secondary text-sm py-2 px-4">Clear filters</button>
    ),
  },
};

export const ErrorState: StoryObj<typeof EmptyState> = {
  args: {
    variant: "error",
    title: "Couldn't load donations",
    description: "Something went wrong while loading this data.",
    action: <button className="btn-primary text-sm">Try again</button>,
  },
};

export const CustomIcon: StoryObj<typeof EmptyState> = {
  args: {
    variant: "empty",
    icon: "❤️",
    title: "No favorites yet",
  },
};
