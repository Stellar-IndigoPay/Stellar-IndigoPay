/**
 * components/SkipToContent.tsx
 *
 * Renders a "Skip to content" link that is visually hidden until it receives
 * keyboard focus. Satisfies WCAG 2.4.1 (Bypass Blocks) by letting keyboard
 * and screen-reader users jump straight past the navbar to the page's main
 * content, avoiding the need to tab through every nav link on every page
 * load.
 *
 * The link targets an element with id="main-content" (rendered by _app.tsx).
 * Falls back gracefully if the target is absent.
 */
export default function SkipToContent() {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById("main-content");
    if (!target) return;
    event.preventDefault();
    // Move focus into the main region so screen-reader virtual cursors land
    // on the new content rather than the previous tab stop.
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: false });
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <a
      href="#main-content"
      className="skip-to-content sr-only focus:not-sr-only"
      onClick={handleClick}
    >
      Skip to main content
    </a>
  );
}
