export function getTierPrice(product: any, tier: number): number {
  const fallback = Number(product.pricePerUnit) || 0;
  switch (tier) {
    case 1:
      return fallback;
    case 2:
      return Number(product.priceTier2 ?? product.pricePerUnit) || fallback;
    case 3:
      return Number(product.priceTier3 ?? product.pricePerUnit) || fallback;
    case 4:
      return Number(product.priceTier4 ?? product.pricePerUnit) || fallback;
    case 5:
      return Number(product.priceTier5 ?? product.pricePerUnit) || fallback;
    default:
      return fallback;
  }
}
