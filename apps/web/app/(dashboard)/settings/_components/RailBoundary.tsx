"use client";

import * as React from "react";

/**
 * Wraps the rail and the Business card: a throw inside either renders nothing there instead of taking down
 * the whole settings route (Plan & billing is where people pay). The screen itself is never wrapped.
 */
export class RailBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Settings rail failed to render", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
