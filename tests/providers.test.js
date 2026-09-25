// Tests für `Providers.js` und die Plugin-Registry.
//
// Vertrag:
//   - `resolve(id)` liefert IMMER einen vollständigen Descriptor (alle
//     vier Felder gesetzt). Der Kern in Usage.js darf sich darauf
//     verlassen und prüft nicht selbst auf undefinierte Felder.
//   - `fallbackName(id)` baut für unbekannte IDs einen Anzeigenamen per
//     Titelcasing; leere/fehlende IDs landen bei "Unbekannt".
//   - Die Dateiliste in `providers/` und die Liste der `PLUGINS` in
//     `Providers.js` müssen synchron sein — sonst ist entweder ein
//     Provider still ("Datei angelegt, Import vergessen") oder die
//     Aggregation wirft beim Laden ("Import eingetragen, Datei gelöscht").
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "./load.js";

// Auch PLUGINS wird geladen — die Registry-Konsistenzprüfung gleicht
// sie gegen die Dateiliste im providers/-Verzeichnis ab.
const providers = load("../Providers.js", ["resolve", "fallbackName", "PLUGINS"]);

// Wurzelverzeichnis des Plugins: tests/ → ..
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVIDERS_DIR = join(ROOT, "providers");

// Erwartungen je Provider MIT Plugin. Die Strip-Tokens stehen nicht im
// Plugin, sondern werden aus ID und Anzeigenamen abgeleitet — hier steht,
// was dabei herauskommen MUSS: "Z.ai" trägt eine Schreibweise, die die ID
// nicht hergibt, bei den übrigen deckt die ID den Namen schon ab.
const KNOWN = {
  "openai-codex": { name: "OpenAI Codex", strip: ["openai", "codex"] },
  zai: { name: "Z.ai", strip: ["zai", "Z.ai"] },
  "minimax-code": { name: "MiniMax Code", strip: ["minimax", "code"] },
  openrouter: { name: "OpenRouter", strip: ["openrouter"] },
  "github-copilot": { name: "GitHub Copilot", strip: ["github", "copilot"] },
};

// Provider, deren Anzeigename aus der ID fällt: sie brauchen kein Plugin,
// und resolve() muss sie trotzdem vollständig bedienen.
const DERIVED = {
  anthropic: { name: "Anthropic", strip: ["anthropic"] },
  "google-antigravity": { name: "Google Antigravity", strip: ["google", "antigravity"] },
};

describe("resolve", () => {
  test("jede bekannte ID liefert den erwarteten Anzeigenamen und Strip-Tokens", () => {
    for (const id in KNOWN) {
      const plugin = providers.resolve(id);
      expect(plugin.id).toBe(id);
      expect(plugin.name).toBe(KNOWN[id].name);
      expect(plugin.strip).toEqual(KNOWN[id].strip);
    }
  });

  // Ohne Plugin ist der Descriptor nicht schlechter, nur abgeleitet: das
  // ist die Begründung, warum es für diese beiden keine Datei gibt.
  test("Provider ohne Plugin werden vollständig abgeleitet", () => {
    for (const id in DERIVED) {
      const plugin = providers.resolve(id);
      expect(plugin.id).toBe(id);
      expect(plugin.name).toBe(DERIVED[id].name);
      expect(plugin.strip).toEqual(DERIVED[id].strip);
      expect(plugin.unlimitedWindows).toEqual([]);
    }
  });

  // Phantom-Fenster sind eine konkrete Verhaltensaussage über den
  // Provider. Wenn morgen ein zweiter Anbieter hinzukommt, der ein
  // echtes 0-%-Kontingent für ein nicht existentes Fenster meldet, soll
  // das hier auffallen — und nicht stillschweigend akzeptiert werden.
  test("Phantom-Fenster führt ausschließlich MiniMax' '7d'", () => {
    for (const id in KNOWN) {
      const plugin = providers.resolve(id);
      if (id === "minimax-code") {
        expect(plugin.unlimitedWindows).toEqual(["7d"]);
      } else {
        expect(plugin.unlimitedWindows).toEqual([]);
      }
    }
  });

  test("jedes resolve()-Ergebnis hat strip und unlimitedWindows als Array", () => {
    for (const id in KNOWN) {
      const plugin = providers.resolve(id);
      expect(plugin.strip).toBeArray();
      expect(plugin.unlimitedWindows).toBeArray();
    }
  });

  test("unbekannte ID liefert vollständigen Fallback-Descriptor", () => {
    const plugin = providers.resolve("some-new-provider");
    expect(plugin.id).toBe("some-new-provider");
    expect(plugin.name).toBe("Some New Provider");
    // Strip-Tokens kommen aus der ID, nicht aus dem synthetischen Namen:
    // für eine leere ID wäre "Unbekannt" sonst ein Token.
    expect(plugin.strip).toEqual(["some", "new", "provider"]);
    expect(plugin.unlimitedWindows).toEqual([]);
  });

  test("leere und fehlende ID liefern vollständigen Fallback-Descriptor", () => {
    for (const id of ["", null, undefined]) {
      const plugin = providers.resolve(id);
      expect(plugin.strip).toEqual([]);
      expect(plugin.unlimitedWindows).toEqual([]);
      expect(plugin.name.length).toBeGreaterThan(0);
    }
  });

  // Negativtest: der Kern darf nicht selbst gegen fehlende Felder
  // prüfen müssen — der Fallback-Descriptor MUSS denselben Shape haben
  // wie ein echter, sonst verträgt sich beides nicht im selben Array.
  test("Fallback-Descriptor hat dieselbe Form wie ein echter", () => {
    const real = providers.resolve("zai");
    const fake = providers.resolve("nope");
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort());
  });
});

describe("fallbackName", () => {
  test("Titelcasing über '-', '_' und '.'", () => {
    expect(providers.fallbackName("some-new-provider")).toBe("Some New Provider");
    expect(providers.fallbackName("some_new.provider")).toBe("Some New Provider");
    expect(providers.fallbackName("a-b-c-d")).toBe("A B C D");
  });

  test("leere Segmente (mehrfache Trenner) werden übersprungen", () => {
    expect(providers.fallbackName("--foo--bar--")).toBe("Foo Bar");
    expect(providers.fallbackName("a..b")).toBe("A B");
  });

  test("nur Trenner -> 'Unbekannt'", () => {
    expect(providers.fallbackName("---")).toBe("Unbekannt");
    expect(providers.fallbackName(".")).toBe("Unbekannt");
  });

  test("leere ID und null/undefined -> 'Unbekannt'", () => {
    expect(providers.fallbackName("")).toBe("Unbekannt");
    expect(providers.fallbackName(null)).toBe("Unbekannt");
    expect(providers.fallbackName(undefined)).toBe("Unbekannt");
  });

  test("Rest des Segments bleibt unverändert", () => {
    // Nicht jedes Wort bekommt Title-Case — der Kern tut das nicht für
    // uns, und der Fallback soll deshalb keine Großschreibung erzwingen,
    // die der Anbieter so nicht liefert.
    expect(providers.fallbackName("FOO-bar")).toBe("FOO Bar");
  });
});

describe("Registry-Konsistenz", () => {
  // Was im providers/-Verzeichnis liegt. Dateinamen sind CamelCase
  // (Anthropic.js, GitHubCopilot.js, ...); die IDs in PLUGINS sind
  // kebab-case (anthropic, github-copilot, ...). Wir laden jede Datei
  // separat, um Datei↔Descriptor-Zuordnung wirklich zu prüfen, statt
  // eine Namenskonvention zu pinnen.
  const onDiskIds = readdirSync(PROVIDERS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => load("../providers/" + name, ["descriptor"]).descriptor.id)
    .sort();

  const inRegistry = providers.PLUGINS.map((p) => p.id).sort();

  test("jede Datei in providers/ ist in PLUGINS vertreten", () => {
    for (const id of onDiskIds) {
      expect(inRegistry).toContain(id);
    }
  });

  // Wichtig in der anderen Richtung: ein Eintrag ohne Datei wirft beim
  // Laden von Providers.js (`.import` schlägt fehl). Wenn dieser Test
  // jemals ohne vorherigen Ladefehler grün wird, hat jemand an einer
  // der beiden Seiten vorbei editiert.
  test("jeder PLUGINS-Eintrag hat eine Datei in providers/", () => {
    for (const id of inRegistry) {
      expect(onDiskIds).toContain(id);
    }
  });

  test("PLUGINS enthält keine doppelten IDs", () => {
    const seen = new Set();
    for (const id of inRegistry) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  // Der Registry-Block in Providers.js wird von scripts/sync-providers.js
  // geschrieben. Wer an ihm (oder an providers/) vorbei editiert und den
  // Sync vergessen hat, wird hier erwischt — genau der Fall, den die zwei
  // Konsistenztests oben nur zufällig abdecken.
  test("Registry-Block ist mit providers/ synchronisiert", () => {
    const result = spawnSync(
      "bun",
      ["scripts/sync-providers.js", "--check"],
      { cwd: join(PROVIDERS_DIR, ".."), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });

  // Ein Plugin trägt nur ID und Name als Pflicht; alles Optionale füllt
  // resolve(). Genau diese Arbeitsteilung wird hier gepinnt — ein Plugin,
  // das selbst `strip` mitbringt, hätte die Ableitung umgangen.
  test("ein Plugin trägt ID und Name, die Vervollständigung macht resolve()", () => {
    for (const descriptor of providers.PLUGINS) {
      expect(typeof descriptor.id).toBe("string");
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(typeof descriptor.name).toBe("string");
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.strip).toBeUndefined();

      const resolved = providers.resolve(descriptor.id);
      expect(resolved.strip).toBeArray();
      expect(resolved.unlimitedWindows).toBeArray();
    }
  });
});