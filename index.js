/**
 * CattleSignal Market Data Service v2.0
 * Railway cron: fetches 15-min delayed futures quotes from Twelve Data API
 * Serves latest prices as JSON for the Netlify Function to consume
 * 
 * Markets: GF (Feeder Cattle), LE (Live Cattle), HE (Lean Hogs),
 *          ZC (Corn), ZS (Soybeans), CL (Crude Oil), ZM (Soybean Meal), ZW (Wheat)
 * 
 * Twelve Data Free Tier: 8 API calls/min, 800/day
 * Budget: 8 markets x 4 refreshes/hr x 11 hrs = 352 calls/day (under 800)
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

// Twelve Data commodity symbols -> CattleSignal market codes
const SYMBOLS = {
  'GF1':  { name: 'Feeder Cattle', code: 'GF', unit: '¢/lb', multiplier: 500 },
  'LE1':  { name: 'Live Cattle',   code: 'LE', unit: '¢/lb', multiplier: 400 },
  'HE1':  { name: 'Lean Hogs',     code: 'HE', unit: '¢/lb', multiplier: 400 },
  'C_1':  { name: 'Corn',          code: 'ZC', unit: '¢/bu', multiplier: 50 },
  'S_1':  { name: 'Soybeans',      code: 'ZS', unit: '¢/bu', multiplier: 50 },
  'CL1':  { name: 'Crude Oil',     code: 'CL', unit: '$/bbl', multiplier: 1000 },
  'SM1':  { name: 'Soybean Meal',  code: 'ZM', unit: '$/ton', multiplier: 100 },
  'W_1':  { name: 'Wheat',         code: 'ZW', unit: '¢/bu', multiplier: 50 },
};

// In-memory cache
let priceCache = {
  lastUpdated: null,
  lastAttempt: null,
  prices: {},
  errors: [],
  source: 'twelvedata',
};

/**
 * Fetch quote from Twelve Data /quote endpoint
 * Uses 1 API credit per symbol
 */
async function fetchTwelveDataQuote(symbol) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY not set');
  }

  const url = `${TWELVE_DATA_BASE}/quote?symbol=${symbol}&apikey=${TWELVE_DATA_API_KEY}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CattleSignal/2.0' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Twelve Data returned ${res.status} for ${symbol}`);
  }

  const data = await res.json();

  if (data.status === 'error' || data.code) {
    throw new Error(data.message || `API error for ${symbol}: code ${data.code}`);
  }

  return {
    price: parseFloat(data.close) || parseFloat(data.previous_close),
    previousClose: parseFloat(data.previous_close) || null,
    open: parseFloat(data.open) || null,
    high: parseFloat(data.high) || null,
    low: parseFloat(data.low) || null,
    volume: parseInt(data.volume) || null,
    change: parseFloat(data.change) || 0,
    changePct: parseFloat(data.percent_change) || 0,
    fiftyTwoWeekHigh: parseFloat(data.fifty_two_week?.high) || null,
    fiftyTwoWeekLow: parseFloat(data.fifty_two_week?.low) || null,
    datetime: data.datetime || null,
    exchange: data.exchange || 'CME',
  };
}

/**
 * Refresh all market prices
 * Sequential with 1.5s delay to respect 8 calls/min rate limit
 */
async function refreshPrices() {
  console.log(`[${new Date().toISOString()}] Refreshing prices via Twelve Data...`);
  const errors = [];
  const prices = {};

  for (const [symbol, info] of Object.entries(SYMBOLS)) {
    try {
      const quote = await fetchTwelveDataQuote(symbol);
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
    // 1.5s between requests = 8 symbols in ~12s, well under 8/min limit
    await new Promise(r => setTimeout(r, 1500));
  }

  priceCache = {
    lastUpdated: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
    prices,
    errors,
    marketsCount: Object.keys(prices).length,
    errorsCount: errors.length,
    source: 'twelvedata',
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

  const lines = ['═══ LIVE MARKET DATA (15-min delayed, Twelve Data) ═══'];
  lines.push(`Last updated: ${priceCache.lastUpdated}`);
  lines.push('');

  for (const [code, data] of Object.entries(priceCache.prices)) {
    if (!data.price) continue;
    const dir = data.change >= 0 ? '▲' : '▼';
    const staleTag = data.stale ? ' [STALE]' : '';
    lines.push(`${data.name} (${code}): ${data.price.toFixed(2)} ${data.unit} ${dir} ${Math.abs(data.change).toFixed(2)} (${Number(data.changePct).toFixed(2)}%)${staleTag}`);
    if (data.high && data.low) {
      lines.push(`  Range: ${data.low.toFixed(2)}-${data.high.toFixed(2)} | Vol: ${(data.volume || 0).toLocaleString()}`);
    }
  }

  lines.push('');
  lines.push('Use these prices for entry/target/stop recommendations. 15-min delayed CME quotes.');
  return lines.join('\n');
}

// ─── ROUTES ───

app.get('/', (req, res) => {
  res.json({
    service: 'CattleSignal Market Data',
    version: '2.0.0',
    source: 'twelvedata',
    status: priceCache.lastUpdated ? 'ok' : 'no_data',
    lastUpdated: priceCache.lastUpdated,
    marketsLoaded: Object.keys(priceCache.prices).length,
    errors: priceCache.errorsCount || 0,
    apiKeyConfigured: !!TWELVE_DATA_API_KEY,
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

// Initial fetch
if (TWELVE_DATA_API_KEY) {
  refreshPrices().catch(err => console.error('Initial fetch failed:', err.message));
} else {
  console.warn('⚠️ TWELVE_DATA_API_KEY not set. Get a free key at https://twelvedata.com/');
}

app.listen(PORT, () => {
  console.log(`CattleSignal Market Data v2.0 on port ${PORT}`);
  console.log(`Source: Twelve Data | Key: ${TWELVE_DATA_API_KEY ? 'configured' : 'MISSING'}`);
});
