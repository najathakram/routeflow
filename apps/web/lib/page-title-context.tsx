"use client";

import * as React from "react";

interface PageTitleContextValue {
  title: string;
  setTitle: (title: string) => void;
}

const PageTitleContext = React.createContext<PageTitleContextValue>({
  title: "",
  setTitle: () => {},
});

const APP_NAME = "RouteFlow";

export function PageTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitleState] = React.useState("");

  const setTitle = React.useCallback((newTitle: string) => {
    setTitleState(newTitle);
    // Also update the browser tab title
    document.title = newTitle ? `${newTitle} | ${APP_NAME}` : APP_NAME;
  }, []);

  return (
    <PageTitleContext.Provider value={{ title, setTitle }}>
      {children}
    </PageTitleContext.Provider>
  );
}

export function usePageTitle() {
  return React.useContext(PageTitleContext);
}
