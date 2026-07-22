import type { Meta, StoryObj } from "@storybook/react";
import ShareButton from "./ShareButton";

const meta: Meta<typeof ShareButton> = {
  title: "Components/ShareButton",
  component: ShareButton,
  tags: ["autodocs"],
  args: {
    url: "https://indigopay.example/donors/GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
    text: "Check out my climate impact on Stellar IndigoPay! 🌍 I've donated 1,250 XLM to 5 projects.",
    title: "Share my climate impact profile",
  },
};

export default meta;
type Story = StoryObj<typeof ShareButton>;

export const Default: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          "Default share button group with Twitter/X, LinkedIn, and Copy Link buttons.",
      },
    },
  },
};

export const NoText: Story = {
  args: {
    text: undefined,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Share buttons without pre-formatted Twitter text — URL-only sharing.",
      },
    },
  },
};

export const LongUrl: Story = {
  args: {
    url: "https://indigopay.example/donors/GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7?ref=leaderboard&utm_source=web&utm_campaign=share",
    text: "I just topped the leaderboard on Stellar IndigoPay! 🏆",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Share button with a longer URL containing query parameters — properly encoded in share links.",
      },
    },
  },
};

export const Minimal: Story = {
  args: {
    url: "https://indigopay.example/projects/1",
    text: "",
    title: "",
  },
  parameters: {
    docs: {
      description: {
        story: "Minimal share button with only the URL — no title or pre-formatted text.",
      },
    },
  },
};
