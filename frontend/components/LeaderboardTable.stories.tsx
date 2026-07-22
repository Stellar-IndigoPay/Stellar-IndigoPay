import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import LeaderboardTable from "./LeaderboardTable";

const meta: Meta<typeof LeaderboardTable> = {
  title: "Components/LeaderboardTable",
  component: LeaderboardTable,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof LeaderboardTable>;

export const Default: Story = {
  args: {
    limit: 20,
    period: "all",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Standard leaderboard with top donors. Uses react-query to fetch data from the backend API.",
      },
    },
  },
};

export const MonthlyPeriod: Story = {
  args: {
    limit: 10,
    period: "month",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Leaderboard filtered to the current month period.",
      },
    },
  },
};
