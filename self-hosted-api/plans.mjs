export function licensePlans(env = process.env) {
  const terms = JSON.parse(env.SHOPIER_LICENSE_PRODUCTS || "{}");
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
    throw new Error("SHOPIER_LICENSE_PRODUCTS must be a JSON object.");
  }
  const details = JSON.parse(env.SHOPIER_PLAN_DETAILS || "{}");
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("SHOPIER_PLAN_DETAILS must be a JSON object.");
  }
  return Object.entries(terms).map(([productId, value]) => {
    const days = Number(value);
    if (!productId.trim() || !Number.isInteger(days) || days < 0 || days > 36500) {
      throw new Error("Each Shopier product must map to 0–36500 integer days.");
    }
    const detail = details[productId] || {};
    const checkoutUrl = String(detail.checkoutUrl || env.SHOPIER_CHECKOUT_URL || "").trim();
    if (checkoutUrl && new URL(checkoutUrl).protocol !== "https:") {
      throw new Error("Shopier checkout URLs must use HTTPS.");
    }
    return {
      productId,
      days,
      name: String(detail.name || (
        days === 0 ? "Ömür boyu lisans" : days === 30 ? "Aylık lisans" : `${days} günlük lisans`
      )).slice(0, 100),
      priceLabel: String(detail.priceLabel || "").slice(0, 80),
      checkoutUrl,
    };
  });
}
