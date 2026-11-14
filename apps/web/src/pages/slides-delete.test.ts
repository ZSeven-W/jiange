import { describe, expect, it } from "vitest";
import { validSlideDeleteReceipt } from "./slides-delete";

describe("slide deletion receipts", () => {
  const page = { id: 5, slidesId: 7, revision: 3 };
  it("accepts only confirmation for the requested deck, page and revision", () => {
    expect(validSlideDeleteReceipt({ deletedId: 5, slidesId: 7, revision: 3 }, page)).toBe(true);
    for (const value of [null, {}, [], { deletedId: 6, slidesId: 7, revision: 3 }, { deletedId: 5, slidesId: 8, revision: 3 }, { deletedId: 5, slidesId: 7, revision: 4 }, { deletedId: "5", slidesId: 7, revision: 3 }]) expect(validSlideDeleteReceipt(value, page)).toBe(false);
  });
});
