import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExactPatch } from "../prisma/artifacts/api-server/src/lib/code-patch.ts";

test("aplica un parche exacto en una sola ubicación", () => {
  assert.equal(applyExactPatch("antes\n", { find: "antes", replace: "después" }), "después\n");
});
test("rechaza coincidencias repetidas", () => {
  assert.throws(() => applyExactPatch("fallo fallo", { find: "fallo", replace: "ok" }), /exactamente una vez/);
});
test("rechaza parches vacíos y sin coincidencias", () => {
  assert.throws(() => applyExactPatch("original", { find: "", replace: "x" }));
  assert.throws(() => applyExactPatch("original", { find: "otro", replace: "nuevo" }));
});
test("rechaza cambios que superarían el límite", () => {
  assert.throws(() => applyExactPatch("x", { find: "x", replace: "z".repeat(35001) }), /tamaño/);
});
test("no evalúa código de IA, sólo sustituye texto", () => {
  assert.equal(applyExactPatch("const a = 1;", { find: "1", replace: "2" }), "const a = 2;");
});
