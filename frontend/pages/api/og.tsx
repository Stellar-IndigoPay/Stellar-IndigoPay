import { ImageResponse } from "@vercel/og";
import type { NextRequest } from "next/server";

export const config = {
  runtime: "edge",
};

export default function handler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title") || "Stellar IndigoPay";
  const subtitle =
    searchParams.get("subtitle") ||
    "Fund the planet. One XLM at a time.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "linear-gradient(135deg, #0f172a 0%, #312e81 50%, #0f766e 100%)",
          color: "white",
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        <div style={{ fontSize: 28, opacity: 0.85, marginBottom: 20 }}>
          Stellar IndigoPay
        </div>
        <div style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.1 }}>
          {title}
        </div>
        <div style={{ fontSize: 30, marginTop: 24, opacity: 0.9 }}>{subtitle}</div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
