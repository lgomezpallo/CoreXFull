import assert from "node:assert/strict";
import test from "node:test";
import { makeSolidPng } from "./probe-assets.mjs";

test("makeSolidPng returns a compact valid PNG envelope", () => {
  const png = makeSolidPng(32, 32);
  assert.equal(Buffer.isBuffer(png), true);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.includes(Buffer.from("IHDR")), true);
  assert.equal(png.includes(Buffer.from("IDAT")), true);
  assert.equal(png.includes(Buffer.from("IEND")), true);
});
