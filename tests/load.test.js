// Tests für den QML-Library-Loader selbst. Er ist die Grundlage jeder
// anderen Suite und von scripts/sync-providers.js — ein Fehler hier reißt
// alles mit, ohne dass eine andere Datei ihn zeigen könnte.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./load.js";

let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "quota-load-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("load", () => {
  test("Deklarationen in Blockkommentaren zählen nicht als Export", () => {
    // Auskommentierter Altbestand wurde von der Export-Regex eingesammelt,
    // vom Funktionskörper aber nie ausgeführt: `return { geist: geist }`
    // warf ReferenceError und riss jede ladende Suite mit.
    const file = join(dir, "Ghost.js");
    writeFileSync(
      file,
      ".pragma library\n\n" +
        "/*\nvar geisterVariable = 1;\nfunction geisterFunktion() {}\n*/\n\n" +
        "function echt() {\n  return 42;\n}\n",
    );
    const lib = load(file, ["echt"]);
    expect(lib.echt()).toBe(42);
  });

  test("angeforderter Name, den es nicht gibt, schlägt laut fehl", () => {
    const file = join(dir, "Plain.js");
    writeFileSync(file, ".pragma library\n\nvar da = 1;\n");
    expect(() => load(file, ["fehltGanz"])).toThrow();
  });
});
