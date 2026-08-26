/**
 * components/AnimatedNumber.tsx
 * Animates a number from 0 to the target value on mount and re-animates
 * whenever the target value changes.
 *
 * Accessibility: when the user has `prefers-reduced-motion: reduce`, the
 * animation is skipped entirely and the final value is rendered immediately
 * (issue #1096, Workstream 1 — "respect prefers-reduced-motion").
 */
import { useEffect, useState, useRef } from "react";
import { formatNumber } from "@/utils/format";

interface AnimatedNumberProps {
  value: number | string;
  duration?: number;
  formatter?: (val: number) => string;
}

export default function AnimatedNumber({
  value,
  duration = 1500,
  formatter,
}: AnimatedNumberProps) {
  const numericValue =
    typeof value === "string" ? parseFloat(value.replace(/,/g, "")) : value;
  const [displayValue, setDisplayValue] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    // Respect the user's motion preference: no animation, show the final
    // value immediately (checked on every value change so a preference
    // change mid-session is honored too).
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplayValue(numericValue);
      return;
    }

    // Reset the clock so a changed value re-animates from the new target
    // instead of instantly snapping (or worse, starting from the old time).
    startTimeRef.current = null;
    let animationFrameId: number;

    const animate = (time: number) => {
      if (startTimeRef.current === null) startTimeRef.current = time;
      const progress = Math.min((time - startTimeRef.current) / duration, 1);

      const easedProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic
      setDisplayValue(easedProgress * numericValue);

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [numericValue, duration]);

  return (
    <>
      {formatter
        ? formatter(displayValue)
        : formatNumber(Math.floor(displayValue))}
    </>
  );
}
