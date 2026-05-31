export type UsdKrwExchangeRate = {
  rate: number;
  fetchedAt: number;
};

const USD_KRW_CACHE_KEY = "myharness.usdKrwExchangeRate.v1";
const USD_KRW_CACHE_TTL_MS = 60 * 60 * 1000;
const USD_KRW_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

let cachedUsdKrwRate: UsdKrwExchangeRate | null = null;
let pendingUsdKrwRate: Promise<UsdKrwExchangeRate> | null = null;

function isFresh(rate: UsdKrwExchangeRate, now: number) {
  return Number.isFinite(rate.rate) && rate.rate > 0 && now - rate.fetchedAt < USD_KRW_CACHE_TTL_MS;
}

function readStoredUsdKrwRate(now: number): UsdKrwExchangeRate | null {
  try {
    const raw = window.localStorage.getItem(USD_KRW_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UsdKrwExchangeRate>;
    const rate = { rate: Number(parsed.rate), fetchedAt: Number(parsed.fetchedAt) };
    return isFresh(rate, now) ? rate : null;
  } catch {
    return null;
  }
}

function writeStoredUsdKrwRate(rate: UsdKrwExchangeRate) {
  try {
    window.localStorage.setItem(USD_KRW_CACHE_KEY, JSON.stringify(rate));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function parseUsdKrwRate(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rates = record.rates && typeof record.rates === "object" ? record.rates as Record<string, unknown> : null;
  const conversionRates = record.conversion_rates && typeof record.conversion_rates === "object"
    ? record.conversion_rates as Record<string, unknown>
    : null;
  const value = Number(rates?.KRW ?? conversionRates?.KRW);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchUsdKrwRate(now: number) {
  const response = await fetch(USD_KRW_ENDPOINT, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Exchange-rate request failed: ${response.status}`);
  }
  const rateValue = parseUsdKrwRate(await response.json());
  if (!rateValue) {
    throw new Error("Exchange-rate response did not include USD/KRW.");
  }
  const rate = { rate: rateValue, fetchedAt: now };
  cachedUsdKrwRate = rate;
  writeStoredUsdKrwRate(rate);
  return rate;
}

export async function getUsdKrwExchangeRate(now = Date.now()): Promise<UsdKrwExchangeRate> {
  if (cachedUsdKrwRate && isFresh(cachedUsdKrwRate, now)) {
    return cachedUsdKrwRate;
  }
  const stored = readStoredUsdKrwRate(now);
  if (stored) {
    cachedUsdKrwRate = stored;
    return stored;
  }
  if (!pendingUsdKrwRate) {
    pendingUsdKrwRate = fetchUsdKrwRate(now).finally(() => {
      pendingUsdKrwRate = null;
    });
  }
  return pendingUsdKrwRate;
}
