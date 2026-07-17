import { render, act } from "@testing-library/react";
import VirtualList from "../VirtualList";

if (!("ResizeObserver" in window)) {
  class ResizeObserverMock {
    callback: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.callback = cb;
    }
    observe(target: Element) {
      const entry: Partial<ResizeObserverEntry> = {
        target,
        borderBoxSize: [
          { inlineSize: 600, blockSize: 600 } as ResizeObserverSize,
        ],
        contentRect: {
          width: 600,
          height: 600,
          x: 0,
          y: 0,
          top: 0,
          right: 600,
          bottom: 600,
          left: 0,
        } as DOMRectReadOnly,
      };
      this.callback([entry as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver = ResizeObserverMock;
}

async function flushEffects() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
}

describe("VirtualList", () => {
  it("renders items after mount", async () => {
    const items = Array.from({ length: 10 }, (_, i) => `Item ${i}`);
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    const listItems = container.querySelectorAll('[role="listitem"]');
    expect(listItems.length).toBeGreaterThan(0);
    expect(container).toHaveTextContent("Item 0");
  });

  it("renders all items when count fits in viewport", async () => {
    const items = ["Apple", "Banana", "Cherry"];
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    items.forEach((item) => {
      expect(container).toHaveTextContent(item);
    });
  });

  it("renders empty state when no items", async () => {
    const { container } = render(
      <VirtualList
        items={[]}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();
    expect(container.querySelector('[role="listitem"]')).toBeNull();
  });

  it("applies custom class names to scroll container", () => {
    const { container } = render(
      <VirtualList
        items={["a"]}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        className="custom-scroll"
        scrollStyle={{ height: "600px" }}
      />,
    );
    const scrollEl = container.querySelector('[role="list"]') as HTMLElement;
    expect(scrollEl.className).toContain("custom-scroll");
  });

  it("uses correct accessibility roles by default", async () => {
    const items = Array.from({ length: 3 }, (_, i) => `Item ${i}`);
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    const list = container.querySelector('[role="list"]');
    expect(list).toBeInTheDocument();
    const listItems = container.querySelectorAll('[role="listitem"]');
    expect(listItems.length).toBe(3);
  });

  it("renders fewer virtual items than total for large lists", async () => {
    const items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        overscan={0}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    const listItems = container.querySelectorAll('[role="listitem"]');
    expect(listItems.length).toBeLessThan(100);
    expect(listItems.length).toBeGreaterThan(0);
  });

  it("renders items respecting overscan", async () => {
    const items = Array.from({ length: 200 }, (_, i) => `Item ${i}`);
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        overscan={5}
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    const listItems = container.querySelectorAll('[role="listitem"]');
    expect(listItems.length).toBeGreaterThanOrEqual(6);
    expect(listItems.length).toBeLessThan(200);
  });

  it("supports custom accessibility roles", async () => {
    const items = ["A", "B"];
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item: string) => <div>{item}</div>}
        estimateSize={() => 50}
        role="listbox"
        itemRole="option"
        scrollStyle={{ height: "600px" }}
      />,
    );

    await flushEffects();

    expect(container.querySelector('[role="listbox"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="option"]').length).toBe(2);
  });
});
