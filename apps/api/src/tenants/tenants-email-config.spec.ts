import { TenantsService } from "./tenants.service";

/**
 * Credential-exfil guard on the legacy TenantConfig SMTP write path
 * (PUT /tenants/me/config/email). The stored password belongs to a specific
 * mailbox+server; changing the host or user WITHOUT supplying a new password must
 * clear the stored credential rather than silently replay it against a different
 * server. Mirrors the guard on SettingsController.updateEmailSettings.
 */
function makeService(cfg: any) {
  const update = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    tenantConfig: {
      findFirst: jest.fn().mockResolvedValue(cfg),
      update,
    },
  } as any;
  const encryption = { encrypt: (v: string) => `enc(${v})` } as any;
  const svc = new TenantsService(prisma, encryption, {} as any, {} as any, {} as any, {} as any);
  return { svc, update };
}

const BASE = {
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "a@gmail.com",
  smtpPassword: "enc(saved)",
  smtpFromName: "Acme",
  smtpFromEmail: "a@gmail.com",
};

describe("TenantsService.updateEmailConfig — credential-exfil guard", () => {
  it("clears the stored password when the HOST changes without a new password", async () => {
    const { svc, update } = makeService({ ...BASE });
    await svc.updateEmailConfig("t1", { smtpHost: "smtp.attacker.com" } as any);
    expect(update.mock.calls[0][0].data.smtpPassword).toBeNull();
  });

  it("clears the stored password when the USER changes without a new password", async () => {
    const { svc, update } = makeService({ ...BASE });
    await svc.updateEmailConfig("t1", { smtpUser: "other@gmail.com" } as any);
    expect(update.mock.calls[0][0].data.smtpPassword).toBeNull();
  });

  it("keeps the stored password when nothing about the mailbox changes", async () => {
    const { svc, update } = makeService({ ...BASE });
    await svc.updateEmailConfig("t1", { smtpFromName: "New Name" } as any);
    // password key not present in the update → existing ciphertext retained
    expect("smtpPassword" in update.mock.calls[0][0].data).toBe(false);
  });

  it("does NOT clear when the host changes AND a new password is supplied", async () => {
    const { svc, update } = makeService({ ...BASE });
    await svc.updateEmailConfig("t1", {
      smtpHost: "smtp.office365.com",
      smtpPassword: "fresh",
    } as any);
    expect(update.mock.calls[0][0].data.smtpPassword).toBe("enc(fresh)");
  });

  it("does not treat an unchanged host echoed back as a mailbox change", async () => {
    const { svc, update } = makeService({ ...BASE });
    await svc.updateEmailConfig("t1", { smtpHost: "smtp.gmail.com", smtpPort: 465 } as any);
    expect("smtpPassword" in update.mock.calls[0][0].data).toBe(false);
  });
});
