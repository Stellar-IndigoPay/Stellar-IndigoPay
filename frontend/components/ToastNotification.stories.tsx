import type { Meta, StoryObj } from "@storybook/react";
import ToastNotification from "./ToastNotification";
import type { ToastItem } from "./ToastNotification";

const baseTime = Date.now();

function makeToast(
  id: string,
  title: string,
  description?: string,
  offsetSeconds = 0,
): ToastItem {
  return {
    id,
    title,
    description,
    createdAt: baseTime - offsetSeconds * 1000,
  };
}

const meta: Meta<typeof ToastNotification> = {
  title: "Components/ToastNotification",
  component: ToastNotification,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    onDismiss: { action: "dismissed" },
  },
};

export default meta;
type Story = StoryObj<typeof ToastNotification>;

export const Single: Story = {
  args: {
    toasts: [
      makeToast(
        "1",
        "Donation successful!",
        "You donated 25 XLM to Amazon Reforestation Initiative.",
      ),
    ],
    onDismiss: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "A single toast notification for a successful donation. Auto-dismisses after 4 seconds.",
      },
    },
  },
};

export const Multiple: Story = {
  args: {
    toasts: [
      makeToast("1", "Donation confirmed!", "50 XLM sent successfully.", 2),
      makeToast("2", "Badge earned!", "You reached Forest tier 🌲", 1),
      makeToast("3", "Welcome back!", "", 0),
    ],
    onDismiss: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Multiple toasts stacked in order of creation time (newest at bottom). Older toasts begin fading after 3.6s.",
      },
    },
  },
};

export const NoDescription: Story = {
  args: {
    toasts: [
      makeToast("1", "Transaction submitted"),
    ],
    onDismiss: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: "Edge case: toast with no description text — only the title is shown.",
      },
    },
  },
};

export const EmptyState: Story = {
  args: {
    toasts: [],
    onDismiss: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: "Edge case: no toasts — nothing is rendered.",
      },
    },
  },
};
