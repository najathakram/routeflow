import { contactPersonPayload } from "../lib/contact-person-payload";

/**
 * #3206 follow-up (mobile mirror of web): a contact's optional fields can be CLEARED on edit. An emptied
 * field that had a stored value is an explicit null; an empty field with nothing stored is left out; a
 * new contact sends only what was typed.
 */
const form = (over: Record<string, unknown> = {}) => ({
  firstName: " Pat ",
  lastName: "",
  email: "",
  phone: "",
  mobile: "",
  isPrimary: false,
  ...over,
});

describe("contactPersonPayload (mobile)", () => {
  it("edit: every emptied optional field that was stored is sent as null", () => {
    const stored = {
      lastName: "Lee",
      email: "pat@acme.example",
      phone: "555-0100",
      mobile: "555-0101",
    };
    expect(contactPersonPayload(form(), stored)).toEqual({
      firstName: "Pat",
      lastName: null,
      email: null,
      phone: null,
      mobile: null,
      isPrimary: false,
    });
  });

  it("edit: a field with nothing stored is left out; a typed one is sent trimmed", () => {
    const p = contactPersonPayload(form({ lastName: " Lee " }), { lastName: null, email: null });
    expect(p.lastName).toBe("Lee");
    expect(p.email).toBeUndefined();
  });

  it("add (no stored contact): only typed fields, never null", () => {
    expect(contactPersonPayload(form({ phone: "555-0100" }), null)).toEqual({
      firstName: "Pat",
      lastName: undefined,
      email: undefined,
      phone: "555-0100",
      mobile: undefined,
      isPrimary: false,
    });
  });
});
