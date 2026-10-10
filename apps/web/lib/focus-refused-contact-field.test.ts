/** @jest-environment jsdom */
import { focusRefusedContactField } from "./refused-text-field";

const refusal = (field: string) => ({
  response: { status: 400, data: { code: "TEXT_CELL_FORMULA_LEAD", field } },
});

describe("focusRefusedContactField (B984): the refused name input gets the cursor", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<input id="contact-first-name" /><input id="contact-last-name" /><input id="other" />';
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["firstName", "contact-first-name"],
    ["lastName", "contact-last-name"],
  ])("a refused %s focuses #%s", (field, id) => {
    focusRefusedContactField(refusal(field));
    expect(document.activeElement?.id).toBe(id);
  });

  it("any other refusal (another field, another error) focuses nothing", () => {
    focusRefusedContactField(refusal("salutation"));
    focusRefusedContactField({ response: { status: 409, data: { code: "X" } } });
    focusRefusedContactField(new Error("boom"));
    expect(document.activeElement).toBe(document.body);
  });
});
