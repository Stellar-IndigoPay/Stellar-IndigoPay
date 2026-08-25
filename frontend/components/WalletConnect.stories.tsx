import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "@storybook/test";
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    
    // Attempt to click the first wallet connect button if it exists, otherwise click the Install Freighter link
    const connectButtons = canvas.queryAllByTestId("wallet-connect-button");
    if (connectButtons.length > 0) {
      await userEvent.click(connectButtons[0]);
    } else {
      const installLink = canvas.queryByRole("link", { name: /Install Freighter/i });
      if (installLink) {
        await expect(installLink).toBeVisible();
      }
    }
  }
};
