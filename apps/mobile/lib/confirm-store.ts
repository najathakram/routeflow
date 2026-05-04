import { create } from "zustand";

/**
 * One row in the confirm/choice dialog. Renders as a horizontal button.
 * `style` matches RN Alert.alert's button styles for cross-platform parity.
 *  - "cancel" → grey, dismisses the dialog (still calls onPress if provided)
 *  - "destructive" → red text
 *  - "default" → brand text (semibold)
 */
export type ConfirmAction = {
  label: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
};

interface ConfirmState {
  visible: boolean;
  title: string;
  message: string;
  actions: ConfirmAction[];
  show: (params: { title: string; message: string; actions: ConfirmAction[] }) => void;
  hide: () => void;
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  visible: false,
  title: "",
  message: "",
  actions: [],
  show: (params) => set({ visible: true, ...params }),
  hide: () => set({ visible: false }),
}));
