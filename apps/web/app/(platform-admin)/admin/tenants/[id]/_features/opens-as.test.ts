import { opensAsChoosableFor } from "./opens-as";

const BOXES = [false, true];

describe("opensAsChoosableFor", () => {
  it("is true only for Shipping + Counter without Delivery", () => {
    const choosable: string[] = [];
    for (const delivery of BOXES)
      for (const shipping of BOXES)
        for (const counter of BOXES) {
          if (opensAsChoosableFor({ delivery, shipping, counter })) {
            choosable.push(`${delivery}/${shipping}/${counter}`);
          }
        }
    expect(choosable).toEqual(["false/true/true"]);
  });

  it("ignores everything else on the ticks (door payments, opens as)", () => {
    expect(
      opensAsChoosableFor({
        delivery: false,
        shipping: true,
        counter: true,
        doorPayments: true,
        opensAs: "order",
      }),
    ).toBe(true);
  });
});
