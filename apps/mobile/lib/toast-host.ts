/**
 * F30 / REG-B151.
 *
 * `lib/toast.ts`'s iOS branch used to be a bare fallthrough (no Alert
 * fallback, no in-screen feedback — every wedge-path miss/failure sink was
 * invisible on iOS). `InlineToast.tsx` (`useInlineToast` + `<InlineToast>`)
 * exists precisely to fill this gap, but `showToast` has no way to reach a
 * screen's locally-mounted instance on its own.
 *
 * This registry is the seam: `useInlineToast` (components/InlineToast.tsx)
 * registers its `show` on mount and releases it on unmount — every screen that
 * owns an `<InlineToast>` goes through that hook, so the wiring cannot be
 * forgotten by a new screen (mirrors the `registerStaffSessionExpiredHandler`
 * pattern in lib/api-client.ts). `showToast`'s iOS branch calls
 * `getToastHost()` — routing there when a host is mounted, falling back to
 * `Alert.alert` when it isn't.
 */

export type ToastHost = (message: string) => void;

/**
 * A stack, not a single slot: pushing a screen (operator `/new-order` over an
 * already-mounted `invoices/new`) leaves the one beneath it MOUNTED, so
 * clearing a lone slot on unmount would orphan the host underneath and demote
 * that still-visible screen back to blocking `Alert`s. The top of the stack is
 * the screen the operator is actually looking at.
 */
let hosts: ToastHost[] = [];

/** Register a screen's host (last one mounted wins). `null` clears the stack. */
export function registerToastHost(host: ToastHost | null): void {
  if (!host) {
    hosts = [];
    return;
  }
  hosts = [...hosts.filter((h) => h !== host), host];
}

/**
 * Drop one screen's host on unmount. Identity-scoped — a screen that has since
 * been superseded can never unregister the host that replaced it.
 */
export function releaseToastHost(host: ToastHost): void {
  hosts = hosts.filter((h) => h !== host);
}

export function getToastHost(): ToastHost | null {
  return hosts[hosts.length - 1] ?? null;
}
