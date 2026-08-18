import Head from "next/head";

interface PageMetaProps {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  ogType?: string;
  ogImage?: string;
  twitterCard?: string;
  siteName?: string;
  locale?: string;
  noindex?: boolean;
  robots?: string;
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
}

export default function PageMeta({
  title,
  description,
  canonicalUrl,
  ogType,
  ogImage,
  twitterCard,
  siteName,
  locale,
  noindex,
  robots,
  jsonLd,
}: PageMetaProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";
  const resolvedTitle = title || "Stellar IndigoPay";
  const resolvedDescription =
    description ||
    "Donate directly to verified climate projects on Stellar. 100% on-chain, zero fees, maximum impact.";
  const resolvedCanonicalUrl = canonicalUrl || `${appUrl}/`;
  const resolvedOgImage = ogImage || `${appUrl}/og-default.svg`;
  const resolvedTwitterCard = twitterCard || "summary_large_image";
  const resolvedSiteName = siteName || "Stellar IndigoPay";
  const resolvedLocale = locale || "en_US";
  const resolvedRobots = robots || (noindex ? "noindex,nofollow" : "index,follow");

  return (
    <Head>
      <title>{resolvedTitle}</title>
      <meta name="description" content={resolvedDescription} />
      <link rel="canonical" href={resolvedCanonicalUrl} />
      <meta property="og:title" content={resolvedTitle} />
      <meta property="og:description" content={resolvedDescription} />
      <meta property="og:type" content={ogType || "website"} />
      <meta property="og:url" content={resolvedCanonicalUrl} />
      <meta property="og:image" content={resolvedOgImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:site_name" content={resolvedSiteName} />
      <meta property="og:locale" content={resolvedLocale} />
      <meta name="twitter:card" content={resolvedTwitterCard} />
      <meta name="twitter:title" content={resolvedTitle} />
      <meta name="twitter:description" content={resolvedDescription} />
      <meta name="twitter:image" content={resolvedOgImage} />
      <meta name="robots" content={resolvedRobots} />
      {noindex ? <meta name="googlebot" content={resolvedRobots} /> : null}
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      ) : null}
    </Head>
  );
}
