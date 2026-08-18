import type { Meta, StoryObj } from "@storybook/react";
import WalletConnect from "./WalletConnect";

const meta: Meta<typeof WalletConnect> = {
  title: "Components/WalletConnect",
  component: WalletConnect,
  tags: ["autodocs"],
  argTypes: {
    onConnect: { action: "connected" },
  },
};

export default meta;
type Story = StoryObj<typeof WalletConnect>;

export const Default: Story = {
  args: {
    onConnect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Wallet connection card with multi-wallet support. Auto-detects installed Stellar wallets (Freighter, Albedo, xBull, Rabet) and shows a picker when multiple are available. Falls back to an install prompt when none are detected.",
      },
    },
  },
};
