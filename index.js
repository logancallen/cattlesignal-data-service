/**
 * CattleSignal Market Data Service v2.1
 * Railway: fetches 15-min delayed futures quotes from Yahoo Finance
 * Serves latest prices as JSON for the Netlify Function to consume
 *
 * Markets: GF (Feeder Cattle), LE (Live Cattle), HE (Lean Hogs),
 *          ZC (Corn), ZS (Soybeans), CL (Crude Oil), ZM (Soybean Meal), ZW (Wheat)
 *
 * Yahoo Finance: no API key, ~15-min delayed, unofficial endpoint
 * Disclaimer required on frontend: "Prices delayed, for informational purposes only"
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Yahoo Finance futures symbols (front-month continuous)
const SYMBOLS = {
  'GF=F': { name: 'Feeder Cattle', code: 'GF', unit: '¢/lb', multiplier: 500 },
  'LE=F': { name: 'Live Cattle',   code: 'LE', unit: '¢/lb', multiplier: 400 },
  'HE=F': { name: 'Lean Hogs',     code: 'HE', unit: '¢/lb', multiplier: 400 },
  'ZC=F': { name: 'Corn',          code: 'ZC', unit: '¢/bu', multiplier: 50 },
  'ZS=F': { name: 'Soybeans',      code: 'ZS', unit: '¢/bu', multiplier: 50 },
  'CL=F': { name: 'Crude Oil',     code: 'CL', unit: '$/bbl', multiplier: 1000 },
  'ZM=F': { name: 'Soybean Meal',  code: 'ZM', unit: '$/ton', multiplier: 100 },
  'ZW=F': { name: 'Wheat',         code: 'ZW', unit: '¢/bu', multiplier: 50 },
};

let priceCache = {
  lastUpdated: null,
  lastAttempt: null,
  prices: {},
  errors: [],
  source: 'yahoo',
};

/**
 * Fetch quote from Yahoo Finance v8 chart API
 */
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo returned ${res.status} for ${symbol}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);

  const meta = result.meta;
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close?.filter(v => v !== null) || [];
  const highs = quote?.high?.filter(v => v !== null) || [];
  const lows = quote?.low?.filter(v => v !== null) || [];
  const opens = quote?.open?.filter(v => v !== null) || [];
  const volumes = quote?.volume?.filter(v => v !== null) || [];

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;

  return {
    price,
    previousClose: prevClose,
    open: opens.length > 0 ? opens[0] : null,
    high: highs.length > 0 ? Math.max(...highs) : null,
    low: lows.length > 0 ? Math.min(...lows) : null,
    volume: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null,
    change: price - prevClose,
    changePct: (((price - prevClose) / prevClose) * 100).toFixed(2),
    marketState: meta.currentTradingPeriod?.regular ? 'regular' : 'closed',
  };
}

/**
 * Refresh all market prices
 */
async function refreshPrices() {
  console.log(`[${new Date().toISOString()}] Refreshing prices via Yahoo Finance...`);
  const errors = [];
  const prices = {};

  for (const [symbol, info] of Object.entries(SYMBOLS)) {
    try {
      const quote = await fetchYahooQuote(symbol);
      prices[info.code] = {
        ...info,
        ...quote,
        symbol,
        fetchedAt: new Date().toISOString(),
      };
      console.log(`  ✅ ${info.code} (${info.name}): ${quote.price} (${quote.changePct}%)`);
    } catch (err) {
      errors.push({ symbol, code: info.code, error: err.message });
      console.error(`  ❌ ${info.code}: ${err.message}`);
      if (priceCache.prices[info.code]) {
        prices[info.code] = { ...priceCache.prices[info.code], stale: true };
      }
    }
    // 500ms between requests to avoid throttling
    await new Promise(r => setTimeout(r, 500));
  }

  priceCache = {
    lastUpdated: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
    prices,
    errors,
    marketsCount: Object.keys(prices).length,
    errorsCount: errors.length,
    source: 'yahoo',
  };

  console.log(`[${new Date().toISOString()}] Done: ${Object.keys(prices).length} markets, ${errors.length} errors`);
  return priceCache;
}

/**
 * System prompt snippet for Claude AI injection
 */
function generateSystemPromptSnippet() {
  if (!priceCache.lastUpdated) {
    return '⚠️ No market data available. Use recent knowledge for price context.';
  }

  const lines = ['═══ MARKET DATA (delayed ~15 min) ═══'];
  lines.push(`Last updated: ${priceCache.lastUpdated}`);
  lines.push('');

  for (const [code, data] of Object.entries(priceCache.prices)) {
    if (!data.price) continue;
    const dir = data.change >= 0 ? '▲' : '▼';
    const staleTag = data.stale ? ' [STALE]' : '';
    lines.push(`${data.name} (${code}): ${data.price.toFixed(2)} ${data.unit} ${dir} ${Math.abs(data.change).toFixed(2)} (${data.changePct}%)${staleTag}`);
    if (data.high && data.low) {
      lines.push(`  Range: ${data.low.toFixed(2)}-${data.high.toFixed(2)} | Vol: ${(data.volume || 0).toLocaleString()}`);
    }
  }

  lines.push('');
  lines.push('Use these prices for entry/target/stop recommendations. Prices are delayed ~15 min.');
  return lines.join('\n');
}

// ─── ROUTES ───

app.get('/', (req, res) => {
  res.json({
    service: 'CattleSignal Market Data',
    version: '2.1.0',
    source: 'yahoo',
    status: priceCache.lastUpdated ? 'ok' : 'no_data',
    lastUpdated: priceCache.lastUpdated,
    marketsLoaded: Object.keys(priceCache.prices).length,
    errors: priceCache.errorsCount || 0,
  });
});

app.get('/prices', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(priceCache);
});

app.get('/prompt-snippet', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Content-Type', 'text/plain');
  res.send(generateSystemPromptSnippet());
});

app.get('/prices/:code', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const code = req.params.code.toUpperCase();
  const market = priceCache.prices[code];
  if (!market) {
    return res.status(404).json({ error: `Market ${code} not found`, available: Object.keys(priceCache.prices) });
  }
  res.json(market);
});

app.post('/refresh', async (req, res) => {
  try {
    const result = await refreshPrices();
    res.json({ status: 'refreshed', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CRON SCHEDULE ───
const FIFTEEN_MINUTES = 15 * 60 * 1000;

function isMarketHours() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay();
  const hour = ct.getHours();
  if (day === 6) return false;
  if (day === 0 && hour < 17) return false;
  if (day === 5 && hour >= 16) return false;
  if (hour === 16) return false;
  return true;
}

setInterval(async () => {
  if (isMarketHours()) {
    try { await refreshPrices(); }
    catch (err) { console.error('Auto-refresh failed:', err.message); }
  } else {
    console.log(`[${new Date().toISOString()}] Market closed — skipping`);
  }
}, FIFTEEN_MINUTES);

// Initial fetch on startup (always, even if market closed — shows last known prices)
refreshPrices().catch(err => console.error('Initial fetch failed:', err.message));

app.listen(PORT, () => {
  console.log(`CattleSignal Market Data v2.1 on port ${PORT}`);
  console.log(`Source: Yahoo Finance (no API key required)`);
});
