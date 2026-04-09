export function getTierPrice(product: any, tier: number): number {
  switch (tier) {
    case 1:
      return Number(product.pricePerUnit);
    case 2:
      return Number(product.priceTier2);
    case 3:
      return Number(product.priceTier3);
    case 4:
      return Number(product.priceTier4);
    case 5:
      return Number(product.priceTier5);
    default:
      return Number(product.pricePerUnit);
  }
}
