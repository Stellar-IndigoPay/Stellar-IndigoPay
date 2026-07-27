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
          "Default wallet connection card prompting users to connect with Freighter. Shows the Freighter install link and a brief explanation.",
      },
    },
  },
};
