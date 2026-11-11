import { NonTouchPointerSensor } from "./SortableLines";

/**
 * #4284 review SHOULD b: the 4 px PointerSensor also fires for a finger on the \`touch-none\` handle, so the 150 ms
 * long-press gated nothing. Touch must go through the TouchSensor's long-press only.
 */
describe("NonTouchPointerSensor activator", () => {
  const press = (pointerType: string, over: Record<string, unknown> = {}) => {
    const onActivation = jest.fn();
    const handled = NonTouchPointerSensor.activators[0].handler(
      { nativeEvent: { isPrimary: true, button: 0, pointerType, ...over } } as never,
      { onActivation } as never,
    );
    return { handled, onActivation };
  };

  it("a finger does not start a drag at 4 px", () => {
    const { handled, onActivation } = press("touch");
    expect(handled).toBe(false);
    expect(onActivation).not.toHaveBeenCalled();
  });

  it("a mouse and a pen still start the drag", () => {
    for (const t of ["mouse", "pen"]) {
      const { handled, onActivation } = press(t);
      expect(handled).toBe(true);
      expect(onActivation).toHaveBeenCalledTimes(1);
    }
  });

  it("a secondary pointer or a non-primary button never does", () => {
    expect(press("mouse", { button: 2 }).handled).toBe(false);
    expect(press("mouse", { isPrimary: false }).handled).toBe(false);
  });
});
