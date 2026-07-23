import { useCartStore } from "../store/cartStore";

// Pure-logic tests for the box-aware customer cart. A boxed product's line is
// stored piece-denominated (qty = whole boxes * unitsPerBox, pieces 0) and
// priced by the BOX via computeLineSubtotal — mirroring the web buyer cart so
// customer orders never over/under-charge boxed products.

const boxed = {
  productId: "p-box",
  name: "Boxed widget",
  unitPrice: 60, // per BOX
  unit: "box",
  unitsPerBox: 6,
};

const loose = {
  productId: "p-loose",
  name: "Loose widget",
  unitPrice: 3.5,
  unit: "each",
  unitsPerBox: null,
};

beforeEach(() => {
  useCartStore.getState().clear();
});

describe("cartStore box-awareness", () => {
  it("adds a boxed product as 1 whole box (qty = unitsPerBox, boxes 1, pieces 0)", () => {
    useCartStore.getState().add(boxed);
    const item = useCartStore.getState().items[0];
    expect(item.qty).toBe(6);
    expect(item.boxes).toBe(1);
    expect(item.pieces).toBe(0);
  });

  it("increments a boxed line by whole boxes on repeated add", () => {
    const { add } = useCartStore.getState();
    add(boxed);
    add(boxed);
    const item = useCartStore.getState().items[0];
    expect(item.boxes).toBe(2);
    expect(item.qty).toBe(12);
  });

  it("step(+/-) moves a boxed line by whole boxes and removes at 0", () => {
    const store = useCartStore.getState();
    store.add(boxed); // 1 box
    store.step("p-box", 2); // 3 boxes
    expect(useCartStore.getState().items[0].boxes).toBe(3);
    expect(useCartStore.getState().items[0].qty).toBe(18);
    store.step("p-box", -3); // → 0 → removed
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it("prices a boxed line by the BOX (2 boxes of $60 = $120, not qty*unitPrice)", () => {
    const store = useCartStore.getState();
    store.add(boxed);
    store.add(boxed); // 2 boxes, qty 12
    // computeLineSubtotal: $60 * (2 + 0/6) = $120. A naive 12 * $60 would be $720.
    expect(useCartStore.getState().total()).toBeCloseTo(120, 2);
  });

  it("treats a non-boxed product as plain pieces", () => {
    const store = useCartStore.getState();
    store.add(loose); // qty 1
    store.step("p-loose", 2); // qty 3
    const item = useCartStore.getState().items[0];
    expect(item.qty).toBe(3);
    expect(item.boxes).toBeNull();
    expect(item.pieces).toBeNull();
    expect(useCartStore.getState().total()).toBeCloseTo(10.5, 2); // 3 * $3.50
  });

  it("sums a mixed cart (boxed + non-boxed) correctly", () => {
    const store = useCartStore.getState();
    store.add(boxed); // 1 box = $60
    store.add(loose); // 1 piece = $3.50
    expect(useCartStore.getState().total()).toBeCloseTo(63.5, 2);
  });
});

describe("cartStore.setUnits (typed qty input)", () => {
  it("sets a boxed line to an absolute box count (3 boxes of 6 -> qty 18)", () => {
    const store = useCartStore.getState();
    store.add(boxed); // 1 box
    store.setUnits("p-box", 3);
    const item = useCartStore.getState().items[0];
    expect(item.boxes).toBe(3);
    expect(item.pieces).toBe(0);
    expect(item.qty).toBe(18);
  });

  it("sets a loose line to an absolute qty (7)", () => {
    const store = useCartStore.getState();
    store.add(loose); // qty 1
    store.setUnits("p-loose", 7);
    const item = useCartStore.getState().items[0];
    expect(item.qty).toBe(7);
    expect(item.boxes).toBeNull();
    expect(item.pieces).toBeNull();
  });

  it("removes the line when set to 0", () => {
    const store = useCartStore.getState();
    store.add(loose);
    store.setUnits("p-loose", 0);
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it("removes the line when set to a negative count", () => {
    const store = useCartStore.getState();
    store.add(boxed);
    store.setUnits("p-box", -1);
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it("is a no-op for a product that isn't in the cart", () => {
    const store = useCartStore.getState();
    store.add(loose);
    store.setUnits("nope", 5);
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(1);
  });

  it("floors a fractional unit count", () => {
    const store = useCartStore.getState();
    store.add(loose);
    store.setUnits("p-loose", 4.9);
    expect(useCartStore.getState().items[0].qty).toBe(4);
  });
});
