/** Shared donation request and validation boundary. */

import { StrKey } from "@stellar/stellar-sdk";
import {
  isValidDonationAmount,
  MIN_DONATION_XLM,
} from "./donationPresets";

export const MAX_MEMO_LENGTH = 28;

export function isValidStellarDestination(value: unknown): value is string {
  return (
    typeof value === "string" &&
    StrKey.isValidEd25519PublicKey(value.trim())
  );
}

/** Keep these messages aligned with the existing background validation. */
export function validateDonationRequest(
  destination: unknown,
  amount: unknown,
  memo: unknown = "",
): string | null {
  if (!isValidStellarDestination(destination)) {
    return "Invalid destination address";
  }
  if (!isValidDonationAmount(amount)) {
    return `Minimum donation is ${MIN_DONATION_XLM} XLM`;
  }
  if (typeof memo !== "string") {
    return "Memo must be 28 bytes or fewer";
  }
  if (new TextEncoder().encode(memo).length > MAX_MEMO_LENGTH) {
    return "Memo must be 28 bytes or fewer";
  }
  return null;
}

/** Validate the state required by the popup's Quick Donate action. */
export function validateQuickDonateState(
  walletPublicKey: unknown,
  destination: unknown,
  amount: unknown,
): string | null {
  if (!isValidStellarDestination(walletPublicKey)) {
    return "Connect your wallet before donating.";
  }
  return validateDonationRequest(destination, amount);
}

export interface DonationResponse {
  success?: boolean;
  error?: string;
  txHash?: string;
  degraded?: boolean;
}

/** Send a donation through the existing canonical background message path. */
export function submitDonationRequest(
  destination: string,
  amount: number,
  memo = "",
): Promise<void> {
  const validationError = validateDonationRequest(destination, amount, memo);
  if (validationError) return Promise.reject(new Error(validationError));

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "SUBMIT_DONATION",
        address: destination,
        amount,
        memo,
      },
      (response: DonationResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Donation failed"));
        } else if (response?.success) {
          resolve();
        } else {
          reject(new Error(response?.error || "Donation failed"));
        }
      },
    );
  });
}
