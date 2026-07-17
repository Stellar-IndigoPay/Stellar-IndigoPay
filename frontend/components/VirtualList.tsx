import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  estimateSize: (index: number) => number;
  overscan?: number;
  className?: string;
  itemClassName?: string;
  innerClassName?: string;
  scrollStyle?: React.CSSProperties;
  role?: string;
  itemRole?: string;
}

export default function VirtualList<T>({
  items,
  renderItem,
  estimateSize,
  overscan = 3,
  className = "",
  itemClassName = "",
  innerClassName = "",
  scrollStyle,
  role = "list",
  itemRole = "listitem",
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan,
  });

  return (
    <div
      ref={scrollRef}
      className={`overflow-auto ${className}`}
      style={scrollStyle}
      role={role}
    >
      <div
        className={innerClassName}
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            role={itemRole}
            className={itemClassName}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderItem(items[virtualItem.index], virtualItem.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
