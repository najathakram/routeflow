import { create } from "zustand";

interface ConfirmState {
  visible: boolean;
  title: string;
  message: string;
  confirmText: string;
  destructive: boolean;
  onConfirm: () => void;
  show: (params: {
    title: string;
    message: string;
    confirmText: string;
    destructive: boolean;
    onConfirm: () => void;
  }) => void;
  hide: () => void;
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  visible: false,
  title: "",
  message: "",
  confirmText: "OK",
  destructive: false,
  onConfirm: () => {},
  show: (params) => set({ visible: true, ...params }),
  hide: () => set({ visible: false }),
}));
