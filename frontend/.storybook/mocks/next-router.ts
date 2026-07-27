import { useCallback } from "react";

export function useRouter() {
  return {
    pathname: "/",
    route: "/",
    query: {},
    asPath: "/",
    push: useCallback(() => Promise.resolve(true), []),
    replace: useCallback(() => Promise.resolve(true), []),
    reload: () => {},
    back: () => {},
    prefetch: useCallback(() => Promise.resolve(), []),
    beforePopState: () => {},
    events: {
      on: () => {},
      off: () => {},
      emit: () => {},
    },
    isFallback: false,
    isReady: true,
    isPreview: false,
  };
}

export { useRouter as default };
