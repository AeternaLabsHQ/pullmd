import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata } from '../lib/metadata.js';

describe('extractMetadata', () => {
  it('extracts standard metadata from HTML', () => {
    const html = `
      <html lang="en">
      <head>
        <title>Test Article</title>
        <meta name="description" content="A test description">
        <meta name="author" content="Jane Doe">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Description">
        <meta property="og:image" content="https://example.com/img.jpg">
        <meta property="og:site_name" content="Example Site">
        <meta property="og:type" content="article">
        <meta property="article:published_time" content="2026-01-15T10:00:00Z">
        <meta property="article:modified_time" content="2026-01-16T12:00:00Z">
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="Twitter Title">
        <meta name="twitter:description" content="Twitter Desc">
        <meta name="twitter:image" content="https://example.com/tw.jpg">
        <link rel="canonical" href="https://example.com/article">
      </head>
      <body><p>Content</p></body>
      </html>
    `;
    const meta = extractMetadata(html);
    assert.equal(meta.title, 'Test Article');
    assert.equal(meta.description, 'A test description');
    assert.equal(meta.author, 'Jane Doe');
    assert.equal(meta.canonical, 'https://example.com/article');
    assert.equal(meta.publishedTime, '2026-01-15T10:00:00Z');
    assert.equal(meta.modifiedTime, '2026-01-16T12:00:00Z');
    assert.equal(meta.ogTitle, 'OG Title');
    assert.equal(meta.ogDescription, 'OG Description');
    assert.equal(meta.ogImage, 'https://example.com/img.jpg');
    assert.equal(meta.ogSiteName, 'Example Site');
    assert.equal(meta.ogType, 'article');
    assert.equal(meta.twitterCard, 'summary_large_image');
    assert.equal(meta.twitterTitle, 'Twitter Title');
    assert.equal(meta.twitterDescription, 'Twitter Desc');
    assert.equal(meta.twitterImage, 'https://example.com/tw.jpg');
    assert.equal(meta.language, 'en');
  });

  it('returns null for missing fields, never undefined', () => {
    const html = '<html><head><title>Minimal</title></head><body></body></html>';
    const meta = extractMetadata(html);
    assert.equal(meta.title, 'Minimal');
    assert.equal(meta.description, null);
    assert.equal(meta.author, null);
    assert.equal(meta.canonical, null);
    assert.equal(meta.publishedTime, null);
    assert.equal(meta.modifiedTime, null);
    assert.equal(meta.ogTitle, null);
    assert.equal(meta.ogDescription, null);
    assert.equal(meta.ogImage, null);
    assert.equal(meta.ogSiteName, null);
    assert.equal(meta.ogType, null);
    assert.equal(meta.twitterCard, null);
    assert.equal(meta.twitterTitle, null);
    assert.equal(meta.twitterDescription, null);
    assert.equal(meta.twitterImage, null);
    assert.equal(meta.language, null);
  });

  it('falls back to og:title when title tag is missing', () => {
    const html = '<html><head><meta property="og:title" content="Fallback Title"></head><body></body></html>';
    const meta = extractMetadata(html);
    assert.equal(meta.title, 'Fallback Title');
  });

  it('falls back to h1 when title and og:title are missing', () => {
    const html = '<html><head></head><body><h1>Heading Title</h1></body></html>';
    const meta = extractMetadata(html);
    assert.equal(meta.title, 'Heading Title');
  });
  it('ignores <title> elements inside inline SVGs', () => {
    const html = '<html><head><title>MHTML - Wikipedia</title></head><body><svg><title>PayPal Logo</title></svg><svg><title>Visa Logo</title></svg><p>x</p></body></html>';
    assert.equal(extractMetadata(html).title, 'MHTML - Wikipedia');
  });

  it('still finds a title outside <head> when that is all there is', () => {
    assert.equal(extractMetadata('<svg><title>Icon</title></svg><title>Seite</title><p>x</p>').title, 'Seite');
  });
});
