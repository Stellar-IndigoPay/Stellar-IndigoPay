import React from 'react';
import type { Meta, StoryObj } from "@storybook/react";
import ThemeToggle from "./ThemeToggle";
import { within, userEvent, expect } from "@storybook/test";

const meta: Meta<typeof ThemeToggle> = {
  title: "Components/ThemeToggle",
  component: ThemeToggle,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="flex justify-start">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ThemeToggle>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button");
    await expect(button).toBeInTheDocument();
    await userEvent.click(button);
    await expect(document.documentElement).toHaveClass("dark");
  },
};
