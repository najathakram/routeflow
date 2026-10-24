import { clearableField, contactPersonPayload } from "./contact-person-payload";

/**
 * #3206 follow-up: a contact person's optional fields (salutation, last name, email, phone, mobile)
 * can be CLEARED on edit. An emptied field that had a stored value is an explicit null; an empty field
 * with nothing stored is left out; a new contact sends only what was typed.
 */
const form = (over: Record<string, unknown> = {}) => ({
  salutation: "",
  firstName: " Pat ",
  lastName: "",
  email: "",
  phone: "",
  mobile: "",
  isPrimary: false,
  ...over,
});

describe("clearableField", () => {
  it("a value is kept (trimmed); an emptied loaded value is null; nothing to clear is undefined", () => {
    expect(clearableField(" Doe ", "Lee")).toBe("Doe");
    expect(clearableField("", "Lee")).toBeNull();
    expect(clearableField("   ", "Lee")).toBeNull();
    expect(clearableField("", null)).toBeUndefined();
    expect(clearableField("", undefined)).toBeUndefined();
  });
});

describe("contactPersonPayload", () => {
  it("edit: every emptied optional field that was stored is sent as null", () => {
    const stored = {
      salutation: "Dr.",
      lastName: "Lee",
      email: "pat@acme.example",
      phone: "555-0100",
      mobile: "555-0101",
    };
    expect(contactPersonPayload(form(), stored)).toEqual({
      salutation: null,
      firstName: "Pat",
      lastName: null,
      email: null,
      phone: null,
      mobile: null,
      isPrimary: false,
    });
  });

  it("edit: a field with nothing stored is left out, a typed one is sent", () => {
    const p = contactPersonPayload(form({ lastName: "Lee" }), { salutation: null, lastName: null });
    expect(p.salutation).toBeUndefined();
    expect(p.lastName).toBe("Lee");
  });

  it("add (no stored contact): only typed fields, never null", () => {
    expect(contactPersonPayload(form({ email: "pat@acme.example" }), null)).toEqual({
      salutation: undefined,
      firstName: "Pat",
      lastName: undefined,
      email: "pat@acme.example",
      phone: undefined,
      mobile: undefined,
      isPrimary: false,
    });
  });
});
