import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface FavouritesState {
  favourites: string[]; // productIds
  toggle: (productId: string) => void;
  isFavourite: (productId: string) => boolean;
}

export const useFavouritesStore = create<FavouritesState>()(
  persist(
    (set, get) => ({
      favourites: [],

      toggle: (productId) =>
        set((state) => ({
          favourites: state.favourites.includes(productId)
            ? state.favourites.filter((id) => id !== productId)
            : [...state.favourites, productId],
        })),

      isFavourite: (productId) => get().favourites.includes(productId),
    }),
    {
      name: "routeflow-favourites",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
