import fs from "fs";
import path from "path";

/** K14 F07: focus moves to the Saved line, so it must SHOW focus (UXL-35). jsdom has no :focus-visible; pin the classes. */
const source = fs.readFileSync(path.join(__dirname, "SaveStatusLine.tsx"), "utf8");
const classOf = (name: string) => {
  const start = source.indexOf(`const ${name} =`);
  const open = source.indexOf('"', start);
  return source.slice(open + 1, source.indexOf('"', open + 1));
};

it.each(["PINNED_CLASS", "SETTLED_CLASS"])("%s shows a focus-visible outline", (name) => {
  const cls = classOf(name);
  expect(cls).toContain("focus-visible:outline");
  expect(cls).not.toContain("focus:outline-none");
});
