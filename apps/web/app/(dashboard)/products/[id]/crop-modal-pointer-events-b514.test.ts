import fs from "fs";
import path from "path";

/**
 * B514 (C2 390px audit, biggest finding): CropModal's crop-box drag, corner
 * resize, and focal-point placement were wired only to `onMouseDown` +
 * `window.addEventListener("mousemove"/"mouseup")` — no touch handling at
 * all, so the mandatory crop+focal step for every product image upload was
 * unusable on a real phone. Converted to Pointer Events (one path for mouse,
 * touch and stylus) rather than adding a second touch-event path alongside
 * the mouse one, per the fix ruling — two paths drift. jsdom can't simulate
 * real pointer capture or touch gestures, so this pins the source-level
 * facts; the proof runner confirms the real behavior on a touch-emulated
 * 390px viewport before merge.
 */
function read(): string {
  return fs.readFileSync(path.join(__dirname, "CropModal.tsx"), "utf8");
}

describe("B514 — CropModal drag/resize/focal-point use Pointer Events, not mouse-only", () => {
  it("has no mouse-only event wiring left", () => {
    const src = read();
    expect(src).not.toMatch(/onMouseDown/);
    expect(src).not.toMatch(/addEventListener\("mouse(move|up)"/);
    expect(src).not.toMatch(/removeEventListener\("mouse(move|up)"/);
    expect(src).not.toMatch(/\(e: MouseEvent\)/);
  });

  it("startDrag captures the pointer on the handle it starts on", () => {
    const src = read();
    expect(src).toContain("(e: React.PointerEvent<HTMLDivElement>, handleId: HandleId)");
    expect(src).toContain("e.currentTarget.setPointerCapture(e.pointerId);");
  });

  it("crop-box drag and corner-resize handles use onPointerDown + touch-none", () => {
    const src = read();
    expect(src).toContain('onPointerDown={(e) => startDrag(e, "body")}');
    expect(src).toContain("onPointerDown={(e) => startDrag(e, h)}");
    // Both draggable surfaces (the box itself and each corner handle) must
    // suppress the browser's own touch gestures (scroll/zoom) so a drag isn't
    // stolen by the page the moment a finger moves.
    expect((src.match(/className="touch-none"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the crop-box and focal-point drag listen for pointer move/up/cancel globally", () => {
    const src = read();
    expect(src).toContain('window.addEventListener("pointermove", onMove);');
    expect(src).toContain('window.addEventListener("pointerup", onUp);');
    expect(src).toContain('window.addEventListener("pointercancel", onUp);');
    // Two independent drag effects (crop-box + focal-point) — both converted.
    expect((src.match(/window\.addEventListener\("pointermove", onMove\);/g) ?? []).length).toBe(2);
    expect((src.match(/window\.addEventListener\("pointercancel", onUp\);/g) ?? []).length).toBe(2);
  });

  it("the focal-point surface captures the pointer and suppresses touch gestures", () => {
    const src = read();
    expect(src).toContain('className="relative inline-block cursor-crosshair touch-none"');
    expect(src).toContain("onPointerDown={(e) => {");
  });
});
