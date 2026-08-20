/**
 * lib/priceContext.tsx — Global XLM/USD price context.
 * Fetches once on mount from the backend on-chain oracle; fails silently.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchXlmPrice } from "./oraclePrice";

interface PriceContextValue {
  xlmUsd: number | null;
}

const PriceContext = createContext<PriceContextValue>({ xlmUsd: null });

export function PriceProvider({ children }: { children: ReactNode }) {
  const [xlmUsd, setXlmUsd] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchXlmPrice(controller.signal)
      .then((price) => {
        if (price !== null) {
          setXlmUsd(price);
        }
      })
      .catch(() => {
        // Fail silently — USD equivalents simply won't render
      });

    return () => controller.abort();
  }, []);

  return (
    <PriceContext.Provider value={{ xlmUsd }}>{children}</PriceContext.Provider>
  );
}

export function useXlmPrice(): number | null {
  return useContext(PriceContext).xlmUsd;
}
