import { QuickKeysSettingsService } from "../system-config/quick-keys-settings.service";
import { defaultQuickKeys } from "../system-config/quick-keys-settings";

/**
 * A provider entry for specs that build SettingsController but are not about quick keys (SA-747): GET reads the
 * defaults, a PATCH without `quickKeys` never reaches it.
 */
export const quickKeysSettingsStubProvider = {
  provide: QuickKeysSettingsService,
  useValue: {
    fromAll: jest.fn(() => defaultQuickKeys()),
    read: jest.fn(async () => defaultQuickKeys()),
    prepare: jest.fn(),
    save: jest.fn(),
  },
};
