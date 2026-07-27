// components/VerificationTimeline.tsx
/**
 * Visual timeline component for verification request lifecycle.
 * Accepts an array of events with `label` and ISO `date` strings.
 * Renders a sleek vertical timeline with subtle hover animations.
 */
import React from "react";

interface Event {
  label: string;
  date: string; // ISO string
}

interface Props {
  events: Event[];
}

export default function VerificationTimeline({ events }: Props) {
  // Sort events chronologically just in case
  const sorted = [...events].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return (
    <div className="relative ml-4">
      {/* vertical line */}
      <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-gray-300 via-gray-200 to-gray-300 dark:from-gray-600 dark:via-gray-500 dark:to-gray-600"></div>
      <ul className="space-y-6">
        {sorted.map((event, idx) => (
          <li key={idx} className="flex items-start group">
            <div className="flex-shrink-0 w-4 h-4 mt-1 rounded-full bg-white border-2 border-indigo-500 dark:bg-gray-800 dark:border-indigo-400 transform transition-transform duration-200 group-hover:scale-110"></div>
            <div className="ml-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {event.label}
              </h3>
              <time
                className="text-sm text-gray-500 dark:text-gray-400"
                dateTime={event.date}
              >
                {new Date(event.date).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
