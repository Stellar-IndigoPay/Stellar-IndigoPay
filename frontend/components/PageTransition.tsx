/**
 * components/PageTransition.tsx
 *
 * Reusable page-level transition used by pages/_app.tsx to animate
 * route changes with Framer Motion.
 *
 * Behaviour:
 *  - Fade + ~10px vertical offset, ~150ms ease-out.
 *  - Honours `prefers-reduced-motion`: when reduced, movement and duration
 *    are removed (only an instant opacity cross-fade remains).
 *  - Moves keyboard focus to the new page container once it finishes
 *    entering, so screen-reader / keyboard users land on the fresh content
 *    after a client-side navigation.
 *  - `initial={false}` on the parent <AnimatePresence> suppresses the very
 *    first (SSR) mount animation.
 */
import { useEffect, useRef } from "react";
import {
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import type { ReactNode } from "react";

const ENTER_DURATION = 0.15;
const EXIT_DURATION = 0.15;
const Y_OFFSET = 10;

interface PageTransitionProps {
  children: ReactNode;
}

export default function PageTransition({ children }: PageTransitionProps) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);

  // Reduced motion: no vertical movement, no timing.
  const variants: Variants = {
    initial: reduceMotion
      ? { opacity: 0 }
      : { opacity: 0, y: Y_OFFSET },
    animate: reduceMotion
      ? { opacity: 1, transition: { duration: 0 } }
      : {
          opacity: 1,
          y: 0,
          transition: { duration: ENTER_DURATION, ease: "easeOut" },
        },
    exit: reduceMotion
      ? { opacity: 0, transition: { duration: 0 } }
      : {
          opacity: 0,
          y: Y_OFFSET,
          transition: { duration: EXIT_DURATION, ease: "easeOut" },
        },
  };

  // Move focus to the new page once it has entered the DOM.  A page may mark
  // a descendant with `data-page-focus` (e.g. its h1) to become the focus
  // target instead of the outer container — used by the donate page so
  // onAnimationComplete leaves its heading focused rather than the motion
  // div.  Reduced motion skips the CONTAINER focus (to avoid surprising
  // focus jumps) but still honours an explicit page-level focus target,
  // which is the same behaviour the donate page had before the move.
  const handleEntered = () => {
    const pageFocusTarget =
      containerRef.current?.querySelector<HTMLElement>("[data-page-focus]");
    if (pageFocusTarget) {
      pageFocusTarget.focus({ preventScroll: true });
      return;
    }
    if (reduceMotion) return;
    containerRef.current?.focus({ preventScroll: true });
  };

  // Ensure the container is reachable by programmatic focus.
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.setAttribute("tabindex", "-1");
  }, []);

  return (
    <motion.div
      ref={containerRef}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      onAnimationComplete={handleEntered}
      style={{ outline: "none" }}
    >
      {children}
    </motion.div>
  );
}
