import * as cheerio from 'cheerio';

export function extractMetadata(html) {
  const $ = cheerio.load(html);

  const meta = (selector, attr = 'content') =>
    $(selector).attr(attr)?.trim() || null;

  const title =
    // The document title only: inline SVG icons carry their own <title>
    // elements, and $('title').text() would glue them all together.
    $('head > title').first().text().trim() ||
    $('title').not('svg title').first().text().trim() ||
    meta('meta[property="og:title"]') ||
    $('h1').first().text().trim() ||
    null;

  return {
    title,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    canonical: meta('link[rel="canonical"]', 'href'),
    author: meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    publishedTime: meta('meta[property="article:published_time"]'),
    modifiedTime: meta('meta[property="article:modified_time"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'),
    ogSiteName: meta('meta[property="og:site_name"]'),
    ogType: meta('meta[property="og:type"]'),
    twitterCard: meta('meta[name="twitter:card"]'),
    twitterTitle: meta('meta[name="twitter:title"]'),
    twitterDescription: meta('meta[name="twitter:description"]'),
    twitterImage: meta('meta[name="twitter:image"]'),
    language: $('html').attr('lang')?.trim() || meta('meta[property="og:locale"]'),
  };
}
