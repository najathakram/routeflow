"use client";

import * as React from "react";

/**
 * Wraps the rail and the Business card: a throw inside either renders nothing there instead of taking down
 * the whole settings route (Plan & billing is where people pay). The screen itself is never wrapped.
 * `resetKey` (the pathname, in the shell) clears a failure when it changes, so navigating retries the rail;
 * with the key unchanged a failed rail stays hidden (no render loop).
 */
export class RailBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  { failed: boolean; key: string | undefined }
> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; key: string | undefined },
  ) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

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
