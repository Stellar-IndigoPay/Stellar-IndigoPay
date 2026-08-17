import { render, screen, fireEvent, act } from "@testing-library/react";
import ProjectMap from "../ProjectMap";

// Mock ProjectMapMarker to avoid deep Leaflet module dependencies
jest.mock("../ProjectMapMarker", () => {
  return function MockProjectMapMarker() {
    return <div data-testid="mock-marker" />;
  };
});

const mockTileErrorFire = jest.fn();

jest.mock("react-leaflet", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = jest.requireActual("react");

  return {
    MapContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="map-container">{children}</div>
    ),
    TileLayer: ({
      eventHandlers,
    }: {
      eventHandlers?: { tileerror: () => void };
    }) => {
      React.useEffect(() => {
        if (eventHandlers?.tileerror) {
          mockTileErrorFire.mockImplementation(() => {
            eventHandlers.tileerror();
          });
        }
      }, [eventHandlers]);
      return <div data-testid="tile-layer" />;
    },
    ZoomControl: () => <div data-testid="zoom-control" />,
  };
});

describe("ProjectMap tile load error handling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockTileErrorFire.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("shows error overlay after retries are exhausted", () => {
    render(<ProjectMap projects={[]} />);

    expect(
      screen.queryByText(/Map tiles unavailable/i)
    ).not.toBeInTheDocument();

    // Fire error 1 (triggers retry 1, 1s backoff)
    act(() => {
      mockTileErrorFire();
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      screen.queryByText(/Map tiles unavailable/i)
    ).not.toBeInTheDocument();

    // Fire error 2 (triggers retry 2, 2s backoff)
    act(() => {
      mockTileErrorFire();
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(
      screen.queryByText(/Map tiles unavailable/i)
    ).not.toBeInTheDocument();

    // Fire error 3 (triggers retry 3, 4s backoff)
    act(() => {
      mockTileErrorFire();
    });
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(
      screen.queryByText(/Map tiles unavailable/i)
    ).not.toBeInTheDocument();

    // Fire error 4 (retries exhausted -> show error)
    act(() => {
      mockTileErrorFire();
    });
    expect(screen.getByText(/Map tiles unavailable/i)).toBeInTheDocument();

    // Click Retry Connection Button
    const retryBtn = screen.getByRole("button", {
      name: /Retry Connection/i,
    });
    act(() => {
      fireEvent.click(retryBtn);
    });

    // Overlay should be removed
    expect(
      screen.queryByText(/Map tiles unavailable/i)
    ).not.toBeInTheDocument();
  });
});
