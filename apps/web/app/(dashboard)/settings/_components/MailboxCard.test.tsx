import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import {
  CONNECT_SECRET_STORAGE_KEY,
  EMAIL_CONNECTED_MAILBOX_ADDON,
  MailboxCard,
} from "./MailboxCard";

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
  window.sessionStorage.clear();
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

  it("CONNECTED with a recorded send failure shows a fixed sentence, never the provider text", async () => {
    statusAnswers = [{ ...CONNECTED_GOOGLE, lastError: "Gmail send failed" }];
    renderCard();

    expect(await screen.findByText(/last sync reported a problem/i)).toBeInTheDocument();
    expect(screen.queryByText(/Gmail send failed/)).not.toBeInTheDocument();
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

  it.each([
    ["mailbox_error=1"],
    ["mailbox_cancelled=google"],
    ["mailbox_admin_consent_required=1"],
  ])("%s ends the connect this tab started: its connect secret is dropped", async (flag) => {
    setUrl(`/settings?tab=email&${flag}`);
    window.sessionStorage.setItem(CONNECT_SECRET_STORAGE_KEY, "tab-secret-1");
    renderCard();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY)).toBeNull();
  });
});

describe("MailboxCard — starting a connect keeps the connect secret in THIS tab (#2115)", () => {
  const START_URL = "/settings/email/mailbox/google/start";

  function routeStart(answer: () => Promise<unknown>) {
    get.mockImplementation((url: string) => {
      if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
      if (url === STATUS_URL) return answerStatus();
      if (url === START_URL) return answer();
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }

  it("stores the secret /start returned, THEN sends the browser to exactly the URL it returned", async () => {
    // A same-document jump stands in for the provider (jsdom can't leave the page).
    const providerUrl = `${window.location.href}#fake-provider`;
    routeStart(() =>
      Promise.resolve({ data: { url: providerUrl, connectSecret: "fresh-secret-1" } }),
    );
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));

    await waitFor(() => expect(window.location.hash).toBe("#fake-provider"));
    expect(window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY)).toBe("fresh-secret-1");
    expect(window.location.search).toBe("?tab=email");
  });

  it("a tab that can't keep the secret never leaves for the provider: it says why instead", async () => {
    routeStart(() =>
      Promise.resolve({
        data: { url: `${window.location.href}#fake-provider`, connectSecret: "fresh-secret-2" },
      }),
    );
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderCard();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));

      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          title: "Couldn't start Google connect",
          description: expect.stringMatching(/blocking the site storage/),
          variant: "error",
        }),
      );
      expect(window.location.hash).toBe("");
    } finally {
      setItem.mockRestore();
    }
  });

  it("a /start answer without a secret never leaves for the provider either", async () => {
    routeStart(() => Promise.resolve({ data: { url: `${window.location.href}#fake-provider` } }));
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't start Google connect", variant: "error" }),
      ),
    );
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY)).toBeNull();
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

describe("MailboxCard — returning with a confirm token: an explicit confirm, only in the tab that started it (#2115)", () => {
  const SECRET = "tab-secret-1";
  const CONFIRM_URL = "/settings/email/mailbox/confirm";
  const CANCEL_URL = "/settings/email/mailbox/confirm/cancel";
  const previewUrl = (token: string) => `/settings/email/mailbox/confirm/${token}/preview`;
  const secretHeader = (secret: string) => ({ headers: { "X-Mailbox-Connect-Secret": secret } });

  /** This tab started the connect: it holds the secret /start handed it. */
  const inTheStartingTab = (secret = SECRET) =>
    window.sessionStorage.setItem(CONNECT_SECRET_STORAGE_KEY, secret);
  const storedSecret = () => window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY);

  function routeGet(extra: Record<string, () => Promise<unknown>>) {
    get.mockImplementation((url: string) => {
      if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
      if (url === STATUS_URL) return answerStatus();
      if (extra[url]) return extra[url]();
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }
  function routePost(extra: Record<string, () => Promise<unknown>>) {
    post.mockImplementation((url: string) =>
      extra[url] ? extra[url]() : Promise.reject(new Error(`unexpected POST ${url}`)),
    );
  }
  const previewAnswers = (token: string, provider: string, accountEmail: string) => ({
    [previewUrl(token)]: () => Promise.resolve({ data: { provider, accountEmail } }),
  });
  const httpError = (status: number, data: unknown = {}) =>
    Promise.reject(Object.assign(new Error(`status ${status}`), { response: { status, data } }));

  /**
   * The bodies of the four distinct 403s preview and confirm can answer, exactly as the API
   * sends them: the two grant-holder checks (MailboxConnectionService.assertGrantHolder, a bare
   * ForbiddenException), AddonGuard's add-on denial, and RolesGuard's default Nest refusal.
   */
  const FORBIDDEN = {
    secretMismatch: {
      statusCode: 403,
      error: "Forbidden",
      message: "mailbox_connect_secret_mismatch",
    },
    identityMismatch: {
      statusCode: 403,
      error: "Forbidden",
      message: "mailbox_confirm_identity_mismatch",
    },
    addonGate: {
      statusCode: 403,
      error: "Forbidden",
      code: "ADDON_GATE",
      addonKeys: [EMAIL_CONNECTED_MAILBOX_ADDON],
      message: `This feature requires the "${EMAIL_CONNECTED_MAILBOX_ADDON}" add-on.`,
    },
    notAnAdmin: { statusCode: 403, error: "Forbidden", message: "Forbidden resource" },
  };
  const OTHER_TAB = /only be confirmed in the browser tab where it was started/;
  /** Each 403 cause, the copy it must get, and whether that copy may blame the tab. */
  const FORBIDDEN_CASES: Array<[string, unknown, RegExp]> = [
    ["the secret of another tab", FORBIDDEN.secretMismatch, OTHER_TAB],
    [
      "a different admin",
      FORBIDDEN.identityMismatch,
      /started by a different user or in a different workspace/,
    ],
    ["the add-on not held", FORBIDDEN.addonGate, /Connected mailboxes aren't enabled/],
    [
      "a non-admin (RolesGuard)",
      FORBIDDEN.notAnAdmin,
      /can't connect a mailbox for this workspace/,
    ],
  ];
  const dialog = () => screen.findByRole("dialog", { name: /to this workspace\?$/ });
  const confirmPosts = () => post.mock.calls.filter(([url]) => url === CONFIRM_URL);

  it.each([
    ["GOOGLE", CONNECTED_GOOGLE, "Gmail", "gmail-owner@acme.test"],
    ["MICROSOFT", CONNECTED_MICROSOFT, "Outlook", "outlook-owner@acme.test"],
  ])(
    "%s: previews with this tab's secret (a header, never the URL), names the account, and binds only on Confirm",
    async (provider, connected, label, email) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-1");
      inTheStartingTab();
      routeGet(previewAnswers("tok-1", provider, email));
      routePost({ [CONFIRM_URL]: () => Promise.resolve({ data: connected }) });
      renderCard();

      const d = await dialog();
      expect(d).toHaveAccessibleName(`Connect ${email} to this workspace?`);
      expect(within(d).getByText(new RegExp(`from this ${label} account`))).toBeInTheDocument();
      expect(get).toHaveBeenCalledWith(previewUrl("tok-1"), secretHeader(SECRET));
      // The token left the address bar before anything else happened, and nothing is bound yet.
      expect(window.location.search).toBe("?tab=email");
      expect(post).not.toHaveBeenCalled();

      fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));

      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          title: `${label} mailbox connected`,
          variant: "success",
        }),
      );
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(CONFIRM_URL, { state: "tok-1" }, secretHeader(SECRET));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(await screen.findByText(email)).toBeInTheDocument();
      expect(storedSecret()).toBeNull();
    },
  );

  it("Cancel burns the grant, binds nothing, and says so", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-2");
    inTheStartingTab();
    routeGet(previewAnswers("tok-2", "GOOGLE", "gmail-owner@acme.test"));
    routePost({ [CANCEL_URL]: () => Promise.resolve({ data: undefined }) });
    renderCard();

    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(CANCEL_URL, { state: "tok-2" }));
    expect(confirmPosts()).toEqual([]);
    expect(toast).toHaveBeenCalledWith({
      title: "Gmail not connected",
      description: "You cancelled. Nothing was changed.",
      variant: "info",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storedSecret()).toBeNull();
  });

  it.each([
    ["Escape", (d: HTMLElement) => fireEvent.keyDown(d, { key: "Escape" })],
    [
      "the close button",
      (d: HTMLElement) => fireEvent.click(within(d).getByRole("button", { name: "Close" })),
    ],
  ])(
    "dismissing the dialog with %s is a Cancel too: the grant is burned",
    async (_how, dismiss) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-3");
      inTheStartingTab();
      routeGet(previewAnswers("tok-3", "GOOGLE", "gmail-owner@acme.test"));
      routePost({ [CANCEL_URL]: () => Promise.resolve({ data: undefined }) });
      renderCard();

      dismiss(await dialog());

      await waitFor(() => expect(post).toHaveBeenCalledWith(CANCEL_URL, { state: "tok-3" }));
      expect(confirmPosts()).toEqual([]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  it("a confirm link opened in ANOTHER tab (no secret here) is never previewed: the grant is burned, nothing binds", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-4");
    routePost({ [CANCEL_URL]: () => Promise.resolve({ data: undefined }) });
    renderCard();

    await waitFor(() => expect(post).toHaveBeenCalledWith(CANCEL_URL, { state: "tok-4" }));
    expect(get.mock.calls.filter(([url]) => url === previewUrl("tok-4"))).toEqual([]);
    expect(confirmPosts()).toEqual([]);
    expect(toast).toHaveBeenCalledWith({
      title: "Mailbox not connected",
      description: expect.stringMatching(
        /only be confirmed in the browser tab where it was started/,
      ),
      variant: "error",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("?tab=email");
  });

  it.each([
    [400, /expired or was already used/],
    [500, /couldn't check this connection request/],
  ])(
    "a preview the server refuses (%s): no dialog, the grant is burned, the admin is told why",
    async (status, why) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-5");
      inTheStartingTab();
      routeGet({ [previewUrl("tok-5")]: () => httpError(status) });
      routePost({ [CANCEL_URL]: () => Promise.resolve({ data: undefined }) });
      renderCard();

      await waitFor(() => expect(post).toHaveBeenCalledWith(CANCEL_URL, { state: "tok-5" }));
      expect(toast).toHaveBeenCalledWith({
        title: "Mailbox not connected",
        description: expect.stringMatching(why),
        variant: "error",
      });
      expect(confirmPosts()).toEqual([]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(storedSecret()).toBeNull();
    },
  );

  it.each(FORBIDDEN_CASES)(
    "a preview refused with 403 for %s: its own copy, and only a secret mismatch blames the tab",
    async (_cause, body, why) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-403");
      inTheStartingTab();
      routeGet({ [previewUrl("tok-403")]: () => httpError(403, body) });
      routePost({ [CANCEL_URL]: () => Promise.resolve({ data: undefined }) });
      renderCard();

      await waitFor(() => expect(post).toHaveBeenCalledWith(CANCEL_URL, { state: "tok-403" }));
      expect(toast).toHaveBeenCalledTimes(1);
      const [{ title, description, variant }] = toast.mock.calls[0];
      expect({ title, variant }).toEqual({ title: "Mailbox not connected", variant: "error" });
      expect(description).toMatch(why);
      if (why !== OTHER_TAB) expect(description).not.toMatch(OTHER_TAB);
      expect(confirmPosts()).toEqual([]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(storedSecret()).toBeNull();
    },
  );

  it.each(FORBIDDEN_CASES)(
    "a Confirm refused with 403 for %s: its own copy, and only a secret mismatch blames the tab",
    async (_cause, body, why) => {
      setUrl("/settings?tab=email&mailbox_confirm=tok-403c");
      inTheStartingTab();
      routeGet(previewAnswers("tok-403c", "GOOGLE", "gmail-owner@acme.test"));
      routePost({ [CONFIRM_URL]: () => httpError(403, body) });
      renderCard();

      fireEvent.click(within(await dialog()).getByRole("button", { name: "Confirm" }));

      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      const [{ title, description, variant }] = toast.mock.calls[0];
      expect({ title, variant }).toEqual({
        title: "Couldn't finish connecting the mailbox",
        variant: "error",
      });
      expect(description).toMatch(why);
      if (why !== OTHER_TAB) expect(description).not.toMatch(OTHER_TAB);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(storedSecret()).toBeNull();
    },
  );

  it("a Confirm the server refuses (the grant expired while the dialog sat open) closes the dialog and spends the secret", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-6");
    inTheStartingTab();
    routeGet(previewAnswers("tok-6", "GOOGLE", "gmail-owner@acme.test"));
    routePost({ [CONFIRM_URL]: () => httpError(400) });
    renderCard();

    fireEvent.click(within(await dialog()).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Couldn't finish connecting the mailbox",
        description: expect.stringMatching(/expired or was already used/),
        variant: "error",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storedSecret()).toBeNull();
    expect(post).not.toHaveBeenCalledWith(CANCEL_URL, expect.anything());
  });

  it("REGRESSION: the card finishing loading behind an open dialog doesn't remount it", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-8");
    inTheStartingTab();
    // The card's own status is still loading when the dialog opens...
    const status = deferred<{ data: unknown }>();
    statusAnswers = [status.promise];
    routeGet(previewAnswers("tok-8", "GOOGLE", "gmail-owner@acme.test"));
    renderCard();

    const d = await dialog();
    expect(screen.queryByTestId("mailbox-card")).toBeNull();

    // ...and then the card appears behind it.
    await act(async () => status.resolve({ data: NOT_CONNECTED }));
    expect(await screen.findByTestId("mailbox-card")).toBeInTheDocument();

    expect(d.isConnected).toBe(true);
    expect(screen.getByRole("dialog")).toBe(d);
  });

  it("while Confirm is on its way, the dialog can't be cancelled out from under it", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-7");
    inTheStartingTab();
    routeGet(previewAnswers("tok-7", "GOOGLE", "gmail-owner@acme.test"));
    const confirmed = deferred<{ data: unknown }>();
    routePost({ [CONFIRM_URL]: () => confirmed.promise });
    renderCard();

    const d = await dialog();
    fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(d).getByRole("button", { name: "Cancel" })).toBeDisabled());
    fireEvent.keyDown(d, { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith(CANCEL_URL, expect.anything());

    await act(async () => confirmed.resolve({ data: CONNECTED_GOOGLE }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("REGRESSION: a status GET already in flight when the confirm lands can't put 'not connected' back", async () => {
    setUrl("/settings?tab=email&mailbox_confirm=tok-race");
    inTheStartingTab();
    // The card's own status GET read the row BEFORE the confirm committed...
    const staleStatus = deferred<{ data: unknown }>();
    statusAnswers = [staleStatus.promise];
    const confirmed = deferred<{ data: unknown }>();
    routeGet(previewAnswers("tok-race", "GOOGLE", "gmail-owner@acme.test"));
    routePost({ [CONFIRM_URL]: () => confirmed.promise });
    const { queryClient } = renderCard();

    // The dialog doesn't wait for the card's own status: it is up while that GET is in flight.
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(confirmPosts()).toHaveLength(1));
    expect(get).toHaveBeenCalledWith(STATUS_URL);

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
});
