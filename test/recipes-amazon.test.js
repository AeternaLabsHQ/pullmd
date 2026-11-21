import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RecipeSchema } from '../lib/recipes.js';
import { extractHtml } from '../lib/web.js';

const recipes = JSON.parse(fs.readFileSync(new URL('../site-recipes.default.json', import.meta.url), 'utf8'))
  .map((r) => RecipeSchema.parse(r));

const PAGE_URL = 'https://www.amazon.de/dp/B000000000';
const BULLET = 'FILLER BULLET: Kompakter Wasserkocher mit Edelstahlgehäuse, abnehmbarem Kalkfilter und beleuchteter Wasserstandsanzeige für den täglichen Gebrauch in der Küche.';

// Skeleton of an amazon.de product page (DOM ids and classes as served in
// November 2026, prose replaced by filler). The price block carries every
// amount twice, once for screen readers and once visible; the product data
// table hides a price-feedback form in a popover; A+ images are lazy
// placeholders; the page is padded with recommendation and review rails.
const PRODUCT_PAGE = `<html><head><title>Amazon.de: FILLER Wasserkocher 1,7 l</title></head><body>
<header><nav>Navigation</nav></header>
<div id="dp" class="kitchen de_DE"><div id="dp-container">
  <div id="ppd">
    <div id="rightCol"><div id="desktop_buybox"><div id="desktop_qualifiedBuyBox">
      <div id="availabilityInsideBuyBox_feature_div"><div id="availability"><span>Auf Lager</span></div></div>
    </div></div></div>
    <div id="leftCol"><div id="imageBlock_feature_div"><h4>Bild nicht verfügbar</h4></div></div>
    <div id="centerCol">
      <div id="title_feature_div"><h1><span id="productTitle">FILLER Wasserkocher 1,7 l</span></h1></div>
      <div id="bylineInfo_feature_div"><a id="bylineInfo" href="/stores/Filler">Besuche den FILLER-Store</a></div>
      <div id="averageCustomerReviews_feature_div"><div id="averageCustomerReviews">
        <span id="acrPopover" title="4,3 von 5 Sternen"><a href="javascript:void(0)"><span>4,3</span><i class="a-icon-star"><span class="a-icon-alt">4,3 von 5 Sternen</span></i></a></span>
        <a href="#averageCustomerReviewsAnchor"><span id="acrCustomerReviewText" aria-label="11.577 Rezensionen">(11.577)</span></a>
      </div></div>
      <div id="apex_desktop">
        <div id="corePriceDisplay_desktop_feature_div">
          <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> 35,90&#160;€ mit 10 Prozent Einsparungen </span>
          <span class="apex-savings-container"><span aria-hidden="true" class="savingsPercentage">-10&#160;%</span></span>
          <span class="a-price priceToPay"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-whole">35<span class="a-price-decimal">,</span></span><span class="a-price-fraction">90</span><span class="a-price-symbol">€</span></span></span>
          <span class="apex-basisprice-feature"><span class="aok-offscreen apex-basisprice-offscreen-label">Statt: 39,99&#160;€</span><span aria-hidden="true" class="basisPrice"><span class="apex-basisprice-label">Statt:</span> <span class="a-price a-text-price"><span class="a-offscreen">39,99€</span><span aria-hidden="true">39,99€</span></span></span></span>
          <span class="basisPriceLegalMessage"><a href="#"><img role="img" aria-label="Weitere Informationen über Preise" src="https://m.media-amazon.com/images/S/sash/info.svg"></a>
            <div class="a-popover-preload"><span>LEGAL-POPOVER Der Statt-Preis ist der mittlere Verkaufspreis.</span></div></span>
        </div>
      </div>
      <div id="newerVersion_feature_div"><div id="newer-version"><div id="newerVersionFeature">
        <h4>Für diesen Artikel ist eine neuere Version vorhanden:</h4>
        <div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
          <div class="a-fixed-left-grid-col a-col-left"><a href="/dp/B000000009"><img alt="FILLER-THUMB Wasserkocher 2026" src="https://m.media-amazon.com/images/I/thumb.jpg"></a></div>
          <div class="a-fixed-left-grid-col a-col-right"><a href="/dp/B000000009">FILLER Wasserkocher 2026</a><br><span class="a-color-price">44,99&#160;€</span><br>
            <a aria-label="4,6 von 5 Sternen" class="a-link-normal reviewsLink" href="/product-reviews/B000000009"><i aria-hidden="true" class="a-icon a-icon-star"></i></a>
            <a aria-label="1.234 Kundenrezensionen für dieses Produkt" href="/product-reviews/B000000009">(1.234)</a></div>
        </div></div>
      </div></div></div>
      <div id="productOverview_feature_div"><table><tr><td>Marke</td><td>FILLER</td></tr><tr><td>Kapazität</td><td>1,7 Liter</td></tr></table></div>
      <div id="featurebullets_feature_div"><div id="feature-bullets"><h1>Info zu diesem Artikel</h1>
        <ul><li><span>${BULLET}</span></li><li><span>${BULLET}</span></li></ul>
        <div class="a-section aok-hidden"><span class="caretnext">&#155;</span> <a id="seeMoreDetailsLink" href="#productDetails">Weitere Produktdetails</a></div>
      </div></div>
    </div>
  </div>
  <div id="sims-simsContainer_feature_div_0"><h2>Empfehlungen und beliebte Artikel</h2><ol><li>RECOMMENDATION Toaster 36,00 €</li><li>RECOMMENDATION Kaffeemaschine 89,99 €</li></ol></div>
  <div id="Desktop-Detailed-Evaluation-Zone">
    <div id="productDetails_feature_div"><div id="prodDetails"><h2>Produktdaten</h2>
      <a href="javascript:void(0)" class="a-expander-header"><span>Artikelangaben</span></a>
      <table><tr><th>Modellnummer</th><td>0413020012</td></tr><tr><th>ASIN</th><td>B000000000</td></tr></table>
      <div class="a-section"><h3>Feedback</h3><div class="a-section table-padding"><div id="pricingFeedbackDiv">Möchtest du uns <a href="javascript:void(0)">über einen günstigeren Preis informieren?</a>
        <div class="a-popover-preload"><div id="feedbackForm"><h2>Wo haben Sie den günstigeren Preis gesehen?</h2><label>Website (Adresse) *:</label></div></div></div></div></div>
    </div></div>
    <div id="aplus_feature_div"><div id="aplus"><h2>Produktbeschreibung des Herstellers</h2>
      <img alt="Der Text lautet „ELEGANZ FÜR IHRE KÜCHE“." src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/grey-pixel.gif" data-src="https://m.media-amazon.com/images/S/aplus-media/real.jpg">
      <img alt="aplus content image" src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/grey-pixel.gif" data-src="https://m.media-amazon.com/images/S/aplus-media/other.jpg">
      <p>FILLER A-PLUS Prosa über das Gerät, die der Hersteller selbst geschrieben hat.</p>
      <a class="a-carousel-goto-prevpage" href="#">Previous page</a><a class="a-carousel-goto-nextpage" href="#">Next page</a>
    </div></div>
  </div>
  <div id="customer-reviews_feature_div"><h2>Kundenrezensionen</h2><p>REVIEW Brief content visible, double tap to read full content.</p></div>
</div></div>
<footer>Footer</footer>
</body></html>`;

describe('amazon.de product built-in recipe', () => {
  it('ships in the default recipe file', () => {
    const recipe = recipes.find((r) => r.name === 'amazon-de-product');
    assert.ok(recipe, 'amazon-de-product must ship in site-recipes.default.json');
    assert.deepEqual(recipe.host, ['www.amazon.de', 'amazon.de', 'amzn.eu', 'amzn.to']);
  });

  it('keeps the product content and drops the rails', async () => {
    const { markdown, source } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.equal(source, 'recipe-content');
    assert.match(markdown, /FILLER BULLET/);
    assert.match(markdown, /Modellnummer/);
    assert.match(markdown, /FILLER A-PLUS Prosa/);
    assert.match(markdown, /Auf Lager/);
    assert.doesNotMatch(markdown, /RECOMMENDATION/);
    assert.doesNotMatch(markdown, /REVIEW Brief content/);
  });

  it('shows the price once, with the reference price', async () => {
    const { markdown } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.match(markdown, /-10 % 35,90€/);
    assert.equal(markdown.match(/35,90/g).length, 1);
    assert.match(markdown, /Statt: 39,99€/);
    assert.equal(markdown.match(/39,99/g).length, 1);
    assert.doesNotMatch(markdown, /LEGAL-POPOVER/);
    assert.doesNotMatch(markdown, /sash\/info\.svg/);
  });

  it('keeps the notice about a newer version, without the thumbnail', async () => {
    const { markdown } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.match(markdown, /Für diesen Artikel ist eine neuere Version vorhanden:/);
    assert.match(markdown, /\[FILLER Wasserkocher 2026\]\(https:\/\/www\.amazon\.de\/dp\/B000000009\)/);
    assert.match(markdown, /44,99 €/);
    assert.match(markdown, /4,6 von 5 Sternen/);
    assert.doesNotMatch(markdown, /FILLER-THUMB/);
  });

  it('turns the star widget into text', async () => {
    const { markdown } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.match(markdown, /4,3 von 5 Sternen/);
    assert.match(markdown, /11\.577 Rezensionen/);
    assert.doesNotMatch(markdown, /javascript:/);
  });

  it('drops the price-feedback form and the carousel buttons', async () => {
    const { markdown } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.doesNotMatch(markdown, /günstigeren Preis/);
    assert.doesNotMatch(markdown, /Feedback/);
    assert.doesNotMatch(markdown, /Previous page|Next page/);
    assert.doesNotMatch(markdown, /Weitere Produktdetails/);
  });

  it('keeps a lazy A+ image as its description and drops placeholder pixels', async () => {
    const { markdown } = await extractHtml(PRODUCT_PAGE, { url: PAGE_URL, recipes });
    assert.match(markdown, /Der Text lautet „ELEGANZ FÜR IHRE KÜCHE“\./);
    assert.doesNotMatch(markdown, /grey-pixel/);
    assert.doesNotMatch(markdown, /aplus content image/);
  });

  it('leaves non-product pages on the host as they were', async () => {
    const search = `<html><head><title>Amazon.de: wasserkocher</title></head><body><div id="search">
      <h2>Ergebnisse</h2>
      <div class="s-result-item"><h2><a href="/dp/B000000001">FILLER Wasserkocher A</a></h2><p>${BULLET}</p></div>
      <div class="s-result-item"><h2><a href="/dp/B000000002">FILLER Wasserkocher B</a></h2><p>${BULLET}</p></div>
      <a href="javascript:void(0)">Mehr</a>
      <img alt="Sponsored" src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/grey-pixel.gif">
    </div></body></html>`;
    const url = 'https://www.amazon.de/s?k=wasserkocher';
    const withRecipe = await extractHtml(search, { url, recipes });
    const without = await extractHtml(search, { url, recipes: [] });
    assert.notEqual(withRecipe.source, 'recipe-content');
    assert.equal(withRecipe.markdown, without.markdown);
  });
});
