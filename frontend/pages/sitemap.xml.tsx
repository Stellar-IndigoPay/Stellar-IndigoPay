import type { GetServerSideProps } from "next";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";

const staticPages = [
  "",
  "/projects",
  "/impact",
  "/leaderboard",
  "/governance",
];

export default function SitemapXml() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const baseUrl = appUrl.replace(/\/$/, "");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticPages
    .map(
      (path) => `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${path === "" ? "1.0" : "0.8"}</priority>\n  </url>`,
    )
    .join("\n")}\n</urlset>\n`;

  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.write(xml);
  res.end();

  return { props: {} };
};
