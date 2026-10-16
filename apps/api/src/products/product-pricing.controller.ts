import { Controller } from "@nestjs/common";

// RED stub (C0 part B): no route, no guards, no flag.
@Controller("products/:productId")
export class ProductPricingController {
  priceGrid(): void {
    return undefined;
  }
}
