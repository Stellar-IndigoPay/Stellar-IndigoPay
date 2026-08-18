import type { Meta, StoryObj } from "@storybook/react";
import Navbar from "./Navbar";

const meta: Meta<typeof Navbar> = {
  title: "Components/Navbar",
  component: Navbar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    onConnect: { action: "connected" },
    onDisconnect: { action: "disconnected" },
  },
};

export default meta;
type Story = StoryObj<typeof Navbar>;

export const Connected: Story = {
  args: {
    publicKey: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
    onConnect: () => {},
    onDisconnect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Navbar showing a connected wallet with the shortened address and disconnect button.",
      },
    },
  },
};

export const Disconnected: Story = {
  args: {
    publicKey: null,
    onConnect: () => {},
    onDisconnect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Navbar when no wallet is connected — shows the 'Connect Wallet' CTA button.",
      },
    },
  },
};

export const MobileMenuOpen: Story = {
  args: {
    publicKey: "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7",
    onConnect: () => {},
    onDisconnect: () => {},
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
    docs: {
      description: {
        story:
          "Mobile viewport (375px). The hamburger menu button is visible. Note: the menu is controlled internally by the Navbar component via useState and starts closed — use the hamburger button in the interactive Storybook to toggle it open.",
      },
    },
  },
};

export const Testnet: Story = {
  args: {
    publicKey: null,
    onConnect: () => {},
    onDisconnect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Navbar showing the testnet network badge (default when NEXT_PUBLIC_STELLAR_NETWORK is not set to mainnet).",
      },
    },
  },
};
