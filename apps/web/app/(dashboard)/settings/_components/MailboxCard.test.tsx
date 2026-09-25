import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { EMAIL_CONNECTED_MAILBOX_ADDON, MailboxCard } from "./MailboxCard";

/**
 * F-10b (#2078): MailboxCard is the only surface a tenant admin ever sees the connected-mailbox
 * feature through. The REAL card, the REAL add-on gate (useHasAddon over GET /tenants/me/addons)
 * and a real QueryClient; only the network (apiClient) and the toast sink are mocked, so every
 * assertion reads what the admin would actually see or be told.
 */
const get = jest.fn();
const post = jest.fn();
const del = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

/** MailboxCard's query key (module-private there). */
const STATUS_KEY = ["settings", "email-mailbox"];
const STATUS_URL = "/settings/email/mailbox";

const NOT_CONNECTED = {
  configured: true,
  googleConfigured: true,
  microsoftConfigured: true,
  connected: false,
};
const CONNECTED_GOOGLE = {
  configured: true,
  googleConfigured: true,
  microsoftConfigured: true,
  connected: true,
  provider: "GOOGLE",
  accountEmail: "gmail-owner@acme.test",
  status: "CONNECTED",
  throttledUntil: null,
  lastError: null,
  lastSentAt: null,
};
const CONNECTED_MICROSOFT = {
  ...CONNECTED_GOOGLE,
  provider: "MICROSOFT",
  accountEmail: "outlook-owner@acme.test",
};
const MS_DISCONNECT_MESSAGE =
  "Disconnected. Microsoft doesn't let RouteFlow revoke access on its own — remove RouteFlow " +
  "from your Microsoft account's app permissions (myaccount.microsoft.com → Privacy → Apps and " +
  "services, or account.live.com/consent/Manage for a personal account) to fully revoke it.";
const GOOGLE_REVOKE_FAILED_MESSAGE =
  "Couldn't confirm the disconnect with Google — revoke RouteFlow's access in your Google " +
  "account (myaccount.google.com/permissions), then try disconnecting again.";

let addons: string[];
/** Answers for GET /settings/email/mailbox, in order; the last one repeats. */
let statusAnswers: Array<unknown>;

function answerStatus(): Promise<{ data: unknown }> {
  const next = statusAnswers.length > 1 ? statusAnswers.shift() : statusAnswers[0];
  return next instanceof Promise ? next : Promise.resolve({ data: next });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setUrl(pathAndQuery: string) {
  window.history.replaceState({}, "", pathAndQuery);
}

/** Let TanStack's batched notifications (scheduled on a macrotask) reach React. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function renderCard() {
  return renderWithProviders(
    <div data-testid="host">
      <MailboxCard />
    </div>,
  );
}

const toastTitles = () => toast.mock.calls.map(([t]) => t.title);

beforeEach(() => {
  jest.clearAllMocks();
  addons = [EMAIL_CONNECTED_MAILBOX_ADDON];
  statusAnswers = [NOT_CONNECTED];
  setUrl("/settings?tab=email");
  get.mockImplementation((url: string) => {
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
    if (url === STATUS_URL) return answerStatus();
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  post.mockImplementation((url: string) => Promise.reject(new Error(`unexpected POST ${url}`)));
  del.mockImplementation((url: string) => Promise.reject(new Error(`unexpected DELETE ${url}`)));
});

describe("MailboxCard — what the admin sees in each state", () => {
  it("not connected: the pitch and a Connect button per configured provider", async () => {
    renderCard();

    expect(await screen.findByText("Connect your email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect Outlook" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("not connected, only Google's client configured: no Outlook button", async () => {
    statusAnswers = [{ ...NOT_CONNECTED, microsoftConfigured: false }];
    renderCard();

    expect(await screen.findByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Outlook" })).toBeNull();
  });

  it("CONNECTED Google: the green badge, the sending address, gmail.send, Disconnect and nothing else", async () => {
    statusAnswers = [CONNECTED_GOOGLE];
    renderCard();

    expect(await screen.findByText("gmail-owner@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/arrive in your own Gmail inbox/)).toHaveTextContent("`gmail.send`");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
    expect(screen.queryByText(/Rate-limited|revoked access/)).toBeNull();
  });

  it("CONNECTED Microsoft: the Outlook wording and Mail.Send, never Gmail's", async () => {
    statusAnswers = [CONNECTED_MICROSOFT];
    renderCard();

    expect(await screen.findByText("outlook-owner@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/arrive in your own Outlook inbox/)).toHaveTextContent("`Mail.Send`");
    expect(screen.queryByText(/gmail/i)).toBeNull();
  });

  it("CONNECTED with a recorded send failure shows the last error", async () => {
    statusAnswers = [{ ...CONNECTED_GOOGLE, lastError: "Gmail send failed" }];
    renderCard();

    expect(await screen.findByText("Last error: Gmail send failed")).toBeInTheDocument();
  });

  it("THROTTLED: the amber badge and the fallback notice naming the provider and the time it clears", async () => {
    const until = "2026-09-24T15:00:00.000Z";
    statusAnswers = [
      {
        ...CONNECTED_GOOGLE,
        status: "THROTTLED",
        throttledUntil: until,
        lastError: "Rate-limited by Google — falling back to the next sender.",
      },
    ];
    renderCard();

    expect(await screen.findByText("Rate-limited")).toBeInTheDocument();
    const notice = screen.getByText(/Rate-limited by Google/);
    expect(notice).toHaveTextContent(`until ${new Date(until).toLocaleString()}`);
    expect(notice).toHaveTextContent(/falling back to your SMTP setup/);
    // The notice already explains it; the raw lastError line is not repeated under it.
    expect(screen.queryByText(/^Last error:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it.each([
    ["GOOGLE", CONNECTED_GOOGLE, "Google", "/settings/email/mailbox/google/start"],
    ["MICROSOFT", CONNECTED_MICROSOFT, "Microsoft", "/settings/email/mailbox/microsoft/start"],
  ])(
    "REVOKED %s: the red badge, the fallback notice, and a Reconnect button that restarts THAT provider's connect",
    async (_provider, connected, vendor, startUrl) => {
      statusAnswers = [
        { ...connected, status: "REVOKED", lastError: "revoked — reconnect required." },
      ];
      get.mockImplementation((url: string) => {
        if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
        if (url === STATUS_URL) return answerStatus();
        if (url === startUrl) return new Promise(() => {}); // stays pending: no navigation
        return Promise.reject(new Error(`unexpected GET ${url}`));
      });
      renderCard();

      expect(await screen.findByText("Reconnect needed")).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(`${vendor} revoked access to this mailbox — reconnect below`)),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Last error:/)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

      expect(await screen.findByRole("button", { name: "Redirecting…" })).toBeDisabled();
      expect(get).toHaveBeenCalledWith(startUrl);
    },
  );

  it.each([
    ["Connect Gmail", "/settings/email/mailbox/google/start"],
    ["Connect Outlook", "/settings/email/mailbox/microsoft/start"],
  ])(
    "%s asks its own start endpoint, then reads 'Redirecting…' with every connect button disabled",
    async (button, startUrl) => {
      get.mockImplementation((url: string) => {
        if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
        if (url === STATUS_URL) return answerStatus();
        if (url === startUrl) return new Promise(() => {}); // stays pending: no navigation
        return Promise.reject(new Error(`unexpected GET ${url}`));
      });
      renderCard();

      fireEvent.click(await screen.findByRole("button", { name: button }));

      expect(await screen.findAllByRole("button", { name: "Redirecting…" })).not.toHaveLength(0);
      // No second connect can start while the first is on its way to the provider.
      for (const b of within(screen.getByTestId("host")).getAllByRole("button")) {
        expect(b).toBeDisabled();
      }
      expect(get).toHaveBeenCalledWith(startUrl);
      expect(get.mock.calls.filter(([u]) => /\/(google|microsoft)\/start$/.test(u))).toHaveLength(
        1,
      );
    },
  );

  it("add-on not held: renders nothing and never asks for the mailbox status", async () => {
    addons = ["some.other_addon"];
    const { queryClient } = renderCard();

    await waitFor(() =>
      expect(queryClient.getQueryState(["tenant", "addons"])?.status).toBe("success"),
    );
    await flush();

    expect(screen.getByTestId("host")).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalledWith(STATUS_URL);
  });

  it("configured:false (neither provider's client env vars set): renders nothing, even once the status has loaded", async () => {
    statusAnswers = [
      { configured: false, googleConfigured: false, microsoftConfigured: false, connected: false },
    ];
    const { queryClient } = renderCard();

    await waitFor(() => expect(queryClient.getQueryState(STATUS_KEY)?.status).toBe("success"));
    await flush();

    expect(screen.getByTestId("host")).toBeEmptyDOMElement();
  });
});

describe("MailboxCard — return-from-provider flags and their toasts", () => {
  it.each([
    ["GOOGLE", CONNECTED_GOOGLE, "Gmail mailbox connected", "gmail-owner@acme.test"],
    ["MICROSOFT", CONNECTED_MICROSOFT, "Outlook mailbox connected", "outlook-owner@acme.test"],
  ])(
    "mailbox_confirm (%s): POSTs the one-time token, toasts success, shows the connection, strips the flag",
    async (_p, connected, title, email) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-1");
      statusAnswers = [connected];
      post.mockImplementation((url: string) =>
        url === "/settings/email/mailbox/confirm"
          ? Promise.resolve({ data: connected })
          : Promise.reject(new Error(`unexpected POST ${url}`)),
      );
      renderCard();

      await waitFor(() => expect(toast).toHaveBeenCalled());
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/settings/email/mailbox/confirm", { state: "tok-1" });
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith({ title, variant: "success" });
      expect(await screen.findByText(email)).toBeInTheDocument();
      expect(window.location.search).toBe("?tab=email");
    },
  );

  it("REGRESSION: a status GET already in flight when the confirm lands can't put 'not connected' back", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-race");
    // The card's own status GET read the row BEFORE the confirm committed...
    const staleStatus = deferred<{ data: unknown }>();
    statusAnswers = [staleStatus.promise];
    const confirmed = deferred<{ data: unknown }>();
    post.mockImplementation(() => confirmed.promise);
    const { queryClient } = renderCard();

    await waitFor(() => expect(get).toHaveBeenCalledWith(STATUS_URL));
    expect(post).toHaveBeenCalledWith("/settings/email/mailbox/confirm", { state: "tok-race" });

    // ...the confirm answers first...
    await act(async () => confirmed.resolve({ data: CONNECTED_GOOGLE }));
    await flush();
    // ...and only then does the stale GET answer, with the pre-confirm row.
    await act(async () => staleStatus.resolve({ data: NOT_CONNECTED }));
    await flush();
    await flush();

    expect(queryClient.getQueryData(STATUS_KEY)).toEqual(CONNECTED_GOOGLE);
    expect(await screen.findByText("gmail-owner@acme.test")).toBeInTheDocument();
    expect(screen.queryByText("Connect your email")).toBeNull();
  });

  it("mailbox_error: the generic couldn't-connect toast, no confirm call, flag stripped", async () => {
    setUrl("/settings?tab=email&mailbox_error=1");
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Couldn't connect the mailbox",
      description: "The provider didn't complete the connection — try again.",
      variant: "error",
    });
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=email");
  });

  it("mailbox_admin_consent_required: its own copy, which names who must act (the organisation's Microsoft 365 admin)", async () => {
    setUrl("/settings?tab=email&mailbox_admin_consent_required=1");
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const [{ title, description, variant }] = toast.mock.calls[0];
    expect(title).toBe("Your organisation requires admin approval");
    expect(description).toMatch(/ask a Microsoft 365 admin to grant consent/);
    expect(description).toMatch(/approve RouteFlow for your Microsoft organisation/);
    expect(variant).toBe("error");
    expect(toastTitles()).not.toContain("Couldn't connect the mailbox");
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=email");
  });

  it("mailbox_cancelled=google: says the user cancelled and that nothing changed — an info toast, not an error", async () => {
    setUrl("/settings?tab=email&mailbox_cancelled=google");
    statusAnswers = [CONNECTED_GOOGLE];
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Gmail connection cancelled",
      description: "You cancelled connecting Gmail; nothing was changed.",
      variant: "info",
    });
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=email");
    // The card still shows the connection as the server has it — nothing was changed.
    expect(await screen.findByText("gmail-owner@acme.test")).toBeInTheDocument();
  });

  it("mailbox_cancelled with a value it doesn't know (a hand-edited URL): a truthful provider-neutral toast", async () => {
    setUrl("/settings?tab=email&mailbox_cancelled=elsewhere");
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Connection cancelled",
      description: "You cancelled connecting your mailbox; nothing was changed.",
      variant: "info",
    });
    expect(window.location.search).toBe("?tab=email");
  });

  it("only the mailbox flags are stripped: other query params survive", async () => {
    setUrl("/settings?tab=email&mailbox_cancelled=google&keep=1");
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe("?tab=email&keep=1");
  });
});

describe("MailboxCard — Disconnect", () => {
  it("Google, revoked at Google: success toast, and the card drops back to not connected", async () => {
    statusAnswers = [CONNECTED_GOOGLE];
    del.mockResolvedValue({ data: { deleted: true } });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith("/settings/email/mailbox");
    expect(toast).toHaveBeenCalledWith({
      title: "Gmail mailbox disconnected",
      description: undefined,
      variant: "success",
    });
    expect(await screen.findByText("Connect your email")).toBeInTheDocument();
    expect(screen.queryByText("gmail-owner@acme.test")).toBeNull();
  });

  it("Google, revoke failed ({deleted:false}): a warning carrying the server's instruction, and the card still shows the kept connection", async () => {
    statusAnswers = [
      CONNECTED_GOOGLE,
      { ...CONNECTED_GOOGLE, status: "REVOKED", lastError: GOOGLE_REVOKE_FAILED_MESSAGE },
    ];
    del.mockResolvedValue({ data: { deleted: false, message: GOOGLE_REVOKE_FAILED_MESSAGE } });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Couldn't fully disconnect",
      description: GOOGLE_REVOKE_FAILED_MESSAGE,
      variant: "warning",
    });
    // Refetched, not assumed: the row was kept (marked REVOKED) so a retry can pick it up.
    expect(await screen.findByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.getByText("gmail-owner@acme.test")).toBeInTheDocument();
    expect(screen.queryByText("Connect your email")).toBeNull();
  });

  it("Microsoft: the success toast still carries the 'remove RouteFlow yourself' instruction", async () => {
    statusAnswers = [CONNECTED_MICROSOFT];
    del.mockResolvedValue({ data: { deleted: true, message: MS_DISCONNECT_MESSAGE } });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Outlook mailbox disconnected",
      description: MS_DISCONNECT_MESSAGE,
      variant: "success",
    });
    expect(toast.mock.calls[0][0].description).toMatch(
      /remove RouteFlow from your Microsoft account's app permissions/,
    );
    expect(await screen.findByText("Connect your email")).toBeInTheDocument();
  });

  it("REGRESSION: a status refetch still in flight when a retried disconnect succeeds can't bring the deleted connection back", async () => {
    // First answer: connected. Second (the refetch after the failed first try) is held open —
    // it reads the kept REVOKED row, i.e. BEFORE the second, successful delete.
    const staleRefetch = deferred<{ data: unknown }>();
    statusAnswers = [CONNECTED_GOOGLE, staleRefetch.promise];
    del
      .mockResolvedValueOnce({ data: { deleted: false, message: GOOGLE_REVOKE_FAILED_MESSAGE } })
      .mockResolvedValueOnce({ data: { deleted: true } });
    const { queryClient } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(toastTitles()).toEqual(["Couldn't fully disconnect"]));
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === STATUS_URL)).toHaveLength(2));

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(toastTitles()).toEqual(["Couldn't fully disconnect", "Gmail mailbox disconnected"]),
    );

    await act(async () =>
      staleRefetch.resolve({
        data: { ...CONNECTED_GOOGLE, status: "REVOKED", lastError: GOOGLE_REVOKE_FAILED_MESSAGE },
      }),
    );
    await flush();
    await flush();

    expect(queryClient.getQueryData(STATUS_KEY)).toMatchObject({ connected: false });
    expect(await screen.findByText("Connect your email")).toBeInTheDocument();
    expect(screen.queryByText("Reconnect needed")).toBeNull();
  });
});
