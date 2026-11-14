"use client";

import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { isScanKey } from "@/lib/scan-run";

/**
 * W-1187 (SA ruling 8): the one drag-to-reorder wrapper for a list of lines. It owns the sensors (handle drag on a
 * pointer, a 150 ms long-press on touch, Space/arrows on the keyboard, Alt+Up/Down for one step), the screen-reader text
 * and the 6-dot handle, so every screen that lets a line be moved behaves and reads the same. It never talks to the
 * server: a move calls `onMove` with the whole new id list and the screen decides what to do (the order page PUTs it).
 */
export interface SortableLine {
  id: string;
  /** What a screen reader says for the line: the product name. */
  label: string;
}

/** One move: the full new id order, the line that moved and where it landed (0-based). */
export interface LineMove {
  ids: string[];
  movedId: string;
  toIndex: number;
}

/**
 * dnd-kit's PointerSensor answers every pointer type, a finger included, so a touch on the handle started a drag after 4 px
 * and the 150 ms long-press gated nothing. This one ignores touch: a finger goes through the TouchSensor's long-press only,
 * and a swipe that has not held still still scrolls the page.
 */
export class NonTouchPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: { nativeEvent: PointerEvent },
        { onActivation }: { onActivation?: (e: { event: Event }) => void },
      ) => {
        if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return false;
        onActivation?.({ event });
        return true;
      },
    },
  ] as unknown as typeof PointerSensor.activators;
}

/** Scan safety (W-1187 PR-2b): no key timing is read here; a scan is told apart by the key it types (`@/lib/scan-run`). */
const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta", "AltGraph"];
const MOVE_CODES = ["Space", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/**
 * Space picks up and drops, the arrows move, Escape cancels: Enter does nothing (a scanner ends every code with it), and
 * any other key cancels the move instead of steering it.
 */
export class ScanSafeKeyboardSensor extends KeyboardSensor {
  constructor(props: ConstructorParameters<typeof KeyboardSensor>[0]) {
    super(props);
    // dnd-kit binds its key handler in the base constructor and attaches it one tick later, so a wrapper set here is the
    // one that listens. (The members are private in its types; the wrapper only uses what the class itself exposes.)
    const self = this as unknown as {
      handleKeyDown: (e: Event) => void;
      detach: () => void;
      props: { onCancel: () => void };
    };
    const inner = self.handleKeyDown;
    self.handleKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (MODIFIER_KEYS.includes(e.key)) return; // a modifier alone neither steers nor cancels
      if (!MOVE_CODES.includes(e.code)) {
        self.detach();
        self.props.onCancel();
        return; // no preventDefault: the key is the scan's
      }
      inner(event);
    };
  }
}
const KEYBOARD_CODES = { start: ["Space"], end: ["Space"], cancel: ["Escape"] };

const INSTRUCTIONS =
  "Press Space to pick up. Use the arrow keys to move, Space to drop, Escape to cancel. Alt plus Up or Down moves one line.";

interface Ctx {
  lines: SortableLine[];
  enabled: boolean;
  move: (id: string, toIndex: number) => void;
}
const SortableCtx = React.createContext<Ctx | null>(null);

function buzz() {
  // Android only; iOS has no web vibration. A short tick on lift and on each pass.
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(10);
  }
}

export function SortableLines({
  lines,
  onMove,
  enabled = true,
  children,
}: {
  lines: SortableLine[];
  onMove: (move: LineMove) => void;
  /** false: no handles, no drag (the order is closed, or a line edit is unsaved). */
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(NonTouchPointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(ScanSafeKeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES,
    }),
  );
  const ids = React.useMemo(() => lines.map((l) => l.id), [lines]);

  const move = React.useCallback(
    (id: string, toIndex: number) => {
      const from = ids.indexOf(id);
      if (from < 0 || toIndex < 0 || toIndex >= ids.length || from === toIndex) return;
      onMove({ ids: arrayMove(ids, from, toIndex), movedId: id, toIndex });
    },
    [ids, onMove],
  );

  const place = (id: unknown) => {
    const i = ids.indexOf(String(id));
    return { name: lines[i]?.label ?? "Line", n: i + 1, of: ids.length };
  };
  const announcements: Announcements = {
    onDragStart({ active }) {
      buzz();
      const p = place(active.id);
      return `Picked up ${p.name}, line ${p.n} of ${p.of}.`;
    },
    onDragOver({ over }) {
      if (!over) return undefined;
      buzz();
      return `Line ${place(over.id).n} of ${ids.length}.`;
    },
    onDragEnd({ active, over }) {
      const to = place(over?.id ?? active.id);
      return `${place(active.id).name} moved to line ${to.n} of ${to.of}.`;
    },
    onDragCancel({ active }) {
      const p = place(active.id);
      return `Move cancelled. ${p.name} is back at line ${p.n}.`;
    },
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(String(active.id), ids.indexOf(String(over.id)));
  };

  return (
    <SortableCtx.Provider value={{ lines, enabled, move }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: INSTRUCTIONS },
          restoreFocus: false, // a cancel by a scan key must not pull focus back to the handle mid-scan
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </DndContext>
    </SortableCtx.Provider>
  );
}

/** What one row spreads onto its element, plus the handle to draw at its leading edge (null when moving is off). */
export function useSortableLine(id: string) {
  const ctx = React.useContext(SortableCtx);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !ctx?.enabled });
  const index = ctx ? ctx.lines.findIndex((l) => l.id === id) : -1;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(
      isDragging && transform ? { ...transform, scaleX: 1.02, scaleY: 1.02 } : transform,
    ),
    transition: reduced ? undefined : transition,
    ...(isDragging
      ? {
          position: "relative",
          zIndex: 10,
          background: "#fff",
          boxShadow: "0 8px 24px rgba(15,23,42,.18)",
        }
      : {}),
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // a scan key, not a move: the screen's capture (till scan box, order builder Search) owns it (lib/scan-run)
    if (isScanKey(e)) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      ctx?.move(id, index + (e.key === "ArrowUp" ? -1 : 1));
      return;
    }
    (
      listeners as { onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void } | undefined
    )?.onKeyDown?.(e);
  };

  const handle =
    ctx?.enabled && index >= 0 ? (
      <button
        type="button"
        ref={setActivatorNodeRef}
        data-sortable-handle={id}
        {...attributes}
        {...listeners}
        onKeyDown={onKeyDown}
        aria-label={`Move ${ctx.lines[index].label}, line ${index + 1} of ${ctx.lines.length}`}
        className={cn(
          "-my-2 flex h-11 w-11 shrink-0 max-md:-ml-3 cursor-grab touch-none items-center justify-center rounded-md",
          "text-navy/40 hover:text-navy focus-visible:text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
          isDragging && "cursor-grabbing text-navy",
        )}
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
    ) : null;

  return { setNodeRef, style, isDragging, handle };
}
