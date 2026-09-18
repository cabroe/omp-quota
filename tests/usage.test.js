// Tests für Usage.js (Parse-Vertrag). Usage.js ist eine QML-`.pragma library`
// ohne ES-Exports — der Loader hier wrapt den Quelltext wie das README-Snippet,
// gibt aber alle getesteten Funktionen zurück, nicht nur parse().
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const USAGE_NAMES = [
  "parse",
  "num",
  "providerName",
  "usedFraction",
  "limitTitle",
  "dedupe",
  "planLabel",
  "scopeLabel",
  "accountLabel",
  "amountText",
  "statusLabel",
  "compact",
  "decimal",
  "plural",
  "collapseAccounts",
  "untilText",
  "agoText",
];

const usage = new Function(
  readFileSync(new URL("../Usage.js", import.meta.url), "utf8").replace(
    /^\.pragma\s+library\s*$/m,
    "",
  ) + `\nreturn {${USAGE_NAMES.join(",")}};`,
)();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;

// Roh-Limit, wie `omp usage --json` es liefert; nur die relevanten Felder.
function rawLimit(overrides = {}) {
  return {
    id: "l1",
    label: "Token Quota",
    amount: { usedFraction: 0.5 },
    window: { label: "5 Hours", durationMs: 5 * HOUR, resetsAt: 3000 },
    ...overrides,
  };
}

function rawProvider(overrides = {}) {
  return {
    provider: "zai",
    metadata: { planType: "pro", email: "a@example.com" },
    limits: [rawLimit()],
    ...overrides,
  };
}

function reportOf(...providers) {
  return JSON.stringify({ generatedAt: 1000, reports: providers });
}

describe("usedFraction", () => {
  test("usedFraction gewinnt gegen used/limit", () => {
    expect(usage.usedFraction({ usedFraction: 0.25, used: 10, limit: 100 })).toBe(0.25);
  });

  test("remainingFraction wird zu 1 - Rest", () => {
    expect(usage.usedFraction({ remainingFraction: 0.3 })).toBeCloseTo(0.7);
  });

  test("used/limit ist der letzte Fallback", () => {
    expect(usage.usedFraction({ used: 50, limit: 200 })).toBe(0.25);
    expect(usage.usedFraction({ used: 50, limit: 0 })).toBe(-1);
  });

  test("ohne Mengenangabe -1", () => {
    expect(usage.usedFraction({})).toBe(-1);
    expect(usage.usedFraction(undefined)).toBe(-1);
  });

  test("clamp auf 0..1", () => {
    expect(usage.usedFraction({ usedFraction: 1.5 })).toBe(1);
    expect(usage.usedFraction({ usedFraction: -0.2 })).toBe(0);
  });

  // JSON-null ist nicht "Feld fehlt": num(null) war vor dem Guard 0 und
  // unterlief genau diesen Fallback.
  test("explizites null fällt auf used/limit durch", () => {
    expect(usage.usedFraction({ usedFraction: null, used: 30, limit: 100 })).toBe(0.3);
  });
});

describe("num", () => {
  test("null, leerer String und Boolean sind keine 0", () => {
    expect(usage.num(null)).toBeNaN();
    expect(usage.num("")).toBeNaN();
    expect(usage.num(false)).toBeNaN();
    expect(usage.num(true)).toBeNaN();
  });

  test("echte Werte und numerische Strings bleiben unberührt", () => {
    expect(usage.num(0)).toBe(0);
    expect(usage.num("0.3")).toBe(0.3);
    expect(usage.num(-5)).toBe(-5);
    expect(usage.num(undefined)).toBeNaN();
    expect(usage.num("keine zahl")).toBeNaN();
  });
});

describe("dedupe", () => {
  test("sharedGroup: höchster Füllstand gewinnt, Gruppe erscheint einmal", () => {
    const group = { scope: { sharedGroup: "gemini-pro" } };
    const out = usage.dedupe(
      [
        rawLimit({ ...group, amount: { usedFraction: 0.3 } }),
        rawLimit({ ...group, amount: { usedFraction: 0.7 } }),
        rawLimit({ ...group, amount: { usedFraction: 0.3 } }),
        rawLimit({ amount: { usedFraction: 0.1 } }),
      ],
      [],
    );
    expect(out).toHaveLength(2);
    expect(out.filter((l) => l.fraction === 0.7)).toHaveLength(1);
  });

  test("ohne sharedGroup bleibt jedes Limit eigenständig", () => {
    expect(usage.dedupe([rawLimit(), rawLimit()], [])).toHaveLength(2);
  });

  // Ein solo-Limit zwischen zwei Gruppentreffern darf den gespeicherten
  // Gruppen-Index nicht verschieben — groups[group] wird vor dem Push
  // gesetzt, der Test pinnt genau das.
  test("Gruppen-Index bleibt korrekt, wenn ein solo-Limit dazwischenliegt", () => {
    const out = usage.dedupe(
      [
        rawLimit({ id: "g1a", amount: { usedFraction: 0.1 }, scope: { sharedGroup: "g1" } }),
        rawLimit({ id: "solo", amount: { usedFraction: 0.5 } }),
        rawLimit({ id: "g1b", amount: { usedFraction: 0.9 }, scope: { sharedGroup: "g1" } }),
      ],
      [],
    );
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("g1b");
    expect(out[0].fraction).toBe(0.9);
    expect(out[1].id).toBe("solo");
  });

  // Antigravity meldet pro Gruppe zwei Fenster; der Sieger bringt sein
  // eigenes Fenster mit, die Sortierung in normalizeReport stellt die
  // Reihenfolge danach wieder her.
  test("Gruppensieger behält sein Fenster, auch bei gemischten Dauern", () => {
    const out = usage.dedupe(
      [
        rawLimit({ id: "w", window: { label: "Weekly", durationMs: DAY, resetsAt: 5000 }, scope: { sharedGroup: "g" } }),
        rawLimit({ id: "h", amount: { usedFraction: 0.9 }, window: { label: "5 Hour", durationMs: HOUR, resetsAt: 6000 }, scope: { sharedGroup: "g" } }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("h");
    expect(out[0].title).toContain("5 Hour");
  });
});

describe("limitTitle / Label-Strip", () => {
  test("Provider- und Fenstertoken werden entfernt", () => {
    expect(usage.limitTitle("ZAI 5 Hours Token Quota", "5 Hours", ["ZAI", "Z.ai"])).toBe(
      "Token Quota · 5 Hours",
    );
  });

  test("Label, das nur das Fenster wiederholt, fällt aufs Fenster zurück", () => {
    expect(usage.limitTitle("5 Hours", "5 Hours", ["ZAI"])).toBe("5 Hours");
  });

  test("Regex-Sonderzeichen im Token werden escaped", () => {
    // "C++" wäre als Regex ein SyntaxError; escaped wird es als Wort gestrippt
    expect(usage.limitTitle("Z.ai C++ Pro Quota", "C++", ["Z.ai"])).toBe("Pro Quota · C++");
  });

  test("Fenster-Token werden mitgestrippt; bloßes 'Quota' trägt nichts", () => {
    expect(usage.limitTitle("Z.ai Pro Quota", "Pro", ["Z.ai"])).toBe("Pro");
  });

  test("leeres Label", () => {
    expect(usage.limitTitle("", "5 Hours", [])).toBe("5 Hours");
  });
});

describe("providerName", () => {
  test("bekannte IDs", () => {
    expect(usage.providerName("anthropic")).toBe("Anthropic");
    expect(usage.providerName("openai-codex")).toBe("OpenAI Codex");
  });

  test("unbekannte IDs werden Titel-cased", () => {
    expect(usage.providerName("some-new-provider")).toBe("Some New Provider");
    expect(usage.providerName("some_new.provider")).toBe("Some New Provider");
  });

  test("leere ID", () => {
    expect(usage.providerName("")).toBe("Unbekannt");
  });
});

describe("statusLabel", () => {
  test("omps Statusvokabular auf Deutsch", () => {
    expect(usage.statusLabel("ok")).toBe("");
    expect(usage.statusLabel("warning")).toBe("fast leer");
    expect(usage.statusLabel("exhausted")).toBe("erschöpft");
    expect(usage.statusLabel("unknown")).toBe("unbekannt");
  });

  test("unbekannter Status wird durchgereicht, fehlender ist ok", () => {
    expect(usage.statusLabel("weird")).toBe("weird");
    expect(usage.statusLabel(undefined)).toBe("");
  });

  test("Groß-/Kleinschreibung und Whitespace werden normalisiert", () => {
    expect(usage.statusLabel(" EXHAUSTED ")).toBe("erschöpft");
  });
});

describe("normalizeLimit / exhausted", () => {
  test("status exhausted markiert das Limit", () => {
    const out = usage.dedupe(
      [rawLimit({ status: "exhausted", amount: { usedFraction: 0.9 } })],
      [],
    );
    expect(out[0].exhausted).toBe(true);
    expect(out[0].statusLabel).toBe("erschöpft");
    expect(out[0].fraction).toBe(0.9);
  });

  test("ohne status bleibt alles ok", () => {
    const out = usage.dedupe([rawLimit()], []);
    expect(out[0].status).toBe("ok");
    expect(out[0].statusLabel).toBe("");
    expect(out[0].exhausted).toBe(false);
  });
});

describe("amountText / Zahlenformat", () => {
  test("percent und leere Angaben liefern keinen Absolutwert", () => {
    expect(usage.amountText({ unit: "percent", used: 80, limit: 100 })).toBe("");
    expect(usage.amountText({})).toBe("");
    expect(usage.amountText({ unit: "requests", used: 1 })).toBe("");
  });

  test("Request-Fenster zeigen 1/100 Anfragen", () => {
    expect(usage.amountText({ unit: "requests", used: 1, limit: 100 })).toBe("1/100 Anfragen");
  });

  test("Token-Fenster kompakt mit deutschem Komma", () => {
    expect(usage.amountText({ unit: "tokens", used: 1500, limit: 1200000 })).toBe(
      "1,5k/1,2M Tokens",
    );
  });

  test("unbekannte Einheit wird unverändert durchgereicht", () => {
    expect(usage.amountText({ unit: "widgets", used: 2, limit: 5 })).toBe("2/5 widgets");
  });

  test("limit <= 0 ergibt keinen Text", () => {
    expect(usage.amountText({ unit: "credits", used: 250, limit: 0 })).toBe("");
  });
});

describe("compact / decimal / plural", () => {
  test("kompakte Skalen", () => {
    expect(usage.compact(850)).toBe("850");
    expect(usage.compact(0)).toBe("0");
    expect(usage.compact(1200)).toBe("1,2k");
    expect(usage.compact(12000)).toBe("12k");
    expect(usage.compact(1200000)).toBe("1,2M");
    expect(usage.compact(1000000)).toBe("1M");
  });

  test("Nicht-Zahlen bleiben leer", () => {
    expect(usage.compact(NaN)).toBe("");
  });

  test("decimal: Komma statt Punkt, ',0' wird gestrippt", () => {
    expect(usage.decimal(1.5, true)).toBe("1,5");
    expect(usage.decimal(1.0, true)).toBe("1");
    expect(usage.decimal(9.96, false)).toBe("10");
    expect(usage.decimal(9.96, true)).toBe("10");
  });

  test("plural: 1 Zugang, 2 Zugänge", () => {
    expect(usage.plural(1, "Zugang", "Zugänge")).toBe("1 Zugang");
    expect(usage.plural(3, "Zugang", "Zugänge")).toBe("3 Zugänge");
    expect(usage.plural("2", "Zugang", "Zugänge")).toBe("2 Zugänge");
    expect(usage.plural(NaN, "Zugang", "Zugänge")).toBe("");
  });
});

describe("planLabel / accountLabel", () => {
  test("nur planType ist eine Planangabe, orgName wird ignoriert", () => {
    expect(usage.planLabel({ planType: "pro", orgName: "acme" })).toBe("pro");
    // Regressionsfall: Anthropic liefert kein planType, dadurch stand der
    // Name des Kontoinhabers als Plan im Panel.
    expect(usage.planLabel({ orgName: "Ada Lovelace" })).toBe("");
    expect(usage.planLabel({ orgName: "acme" })).toBe("");
    expect(usage.planLabel({})).toBe("");
  });

  // Die Metadaten unten sind die echten Felder aus `omp usage --json`:
  // planType liefert nur zai/openai-codex, die übrigen drei Provider gar
  // keinen Plan. Ohne scopeLabel blieb deren Kopfzeilen-Slot leer.
  test("ohne planType tritt die Angabe ein, die der Provider wirklich führt", () => {
    // anthropic
    expect(
      usage.scopeLabel({ email: "a@example.com", orgName: "Ada Lovelace" }),
    ).toBe("Org Ada Lovelace");
    // google-antigravity
    expect(
      usage.scopeLabel({ email: "a@example.com", projectId: "example-project" }),
    ).toBe("Projekt example-project");
    // minimax-code: `video` ist gemeldet, aber nicht nutzbar
    expect(
      usage.scopeLabel({
        source: "minimax-token-plan",
        models: ["general", "video"],
        unavailableModels: ["video"],
      }),
    ).toBe("Modell general");
    expect(usage.scopeLabel({ models: ["general", "video"] })).toBe(
      "Modelle general, video",
    );
  });

  test("mit planType bleibt scopeLabel leer statt den Plan zu doppeln", () => {
    // openai-codex meldet orgName "free" — gleich dem planType.
    expect(usage.scopeLabel({ planType: "free", orgName: "free" })).toBe("");
    expect(usage.scopeLabel({ planType: "lite" })).toBe("");
  });

  test("orgName schlägt projectId, keine Angabe bleibt leer", () => {
    expect(usage.scopeLabel({ orgName: "acme", projectId: "p1" })).toBe("Org acme");
    expect(usage.scopeLabel({ email: "a@example.com" })).toBe("");
    expect(usage.scopeLabel({})).toBe("");
    // Alle Modelle blockiert: keine Auskunft ist besser als "Modelle ".
    expect(usage.scopeLabel({ models: ["video"], unavailableModels: ["video"] })).toBe("");
  });

  // Non-Array-Felder werden ignoriert, nicht als Zeichenliste iteriert —
  // ein Refactor mit Array.from würde aus "general" 7 Buchstaben-Modelle
  // machen, und das ginge sonst unbemerkt durch.
  test("models als String statt Array wird ignoriert", () => {
    expect(usage.scopeLabel({ models: "general" })).toBe("");
    expect(
      usage.scopeLabel({ models: ["general"], unavailableModels: "general" }),
    ).toBe("Modell general");
  });

  test("E-Mail schlägt accountId, accountId wird auf 8 Zeichen gekürzt", () => {
    expect(usage.accountLabel({ email: "a@example.com", accountId: "1234567890" })).toBe(
      "a@example.com",
    );
    expect(usage.accountLabel({ accountId: "1234567890" })).toBe("12345678");
    expect(usage.accountLabel({})).toBe("");
  });
});

describe("collapseAccounts", () => {
  test("dieselbes Konto überall: einmal in die Fußzeile, aus den Abschnitten", () => {
    const providers = [
      { account: "a@example.com" },
      { account: "a@example.com" },
    ];
    expect(usage.collapseAccounts(providers)).toBe("a@example.com");
    expect(providers[0].account).toBe("");
    expect(providers[1].account).toBe("");
  });

  test("verschiedene Konten bleiben je Provider stehen", () => {
    const providers = [{ account: "a@example.com" }, { account: "b@example.com" }];
    expect(usage.collapseAccounts(providers)).toBe("");
    expect(providers[0].account).toBe("a@example.com");
    expect(providers[1].account).toBe("b@example.com");
  });

  test("einzelner Provider: Konto wandert ebenfalls in die Fußzeile", () => {
    const providers = [{ account: "a@example.com" }];
    expect(usage.collapseAccounts(providers)).toBe("a@example.com");
    expect(providers[0].account).toBe("");
  });

  test("gar keine Konten", () => {
    expect(usage.collapseAccounts([{ account: "" }, { account: "" }])).toBe("");
  });

  // Roher Report statt normalizeReport-Output: fehlendes account-Feld darf
  // nicht crashen (crashte vorher an .length von undefined). Es wird wie
  // ein leeres Konto übersprungen — das einzige nicht-leare wandert in die
  // Fußzeile.
  test("fehlendes account-Feld wird wie ein leeres behandelt", () => {
    expect(usage.collapseAccounts([{}, { account: "a@example.com" }])).toBe(
      "a@example.com",
    );
    expect(usage.collapseAccounts([{ account: "a@example.com" }, {}])).toBe(
      "a@example.com",
    );
  });
});

describe("parse", () => {
  test("leere Antwort", () => {
    const out = usage.parse("  ");
    expect(out.error.length).toBeGreaterThan(0);
    expect(out.providers).toEqual([]);
    expect(out.worst).toBe(-1);
    expect(out.exhausted).toBe(false);
  });

  test("kein JSON", () => {
    expect(usage.parse("kein json").error.length).toBeGreaterThan(0);
  });

  // JSON.parse akzeptiert Primitive — ein Report ist immer ein Objekt.
  // `null` crashte vorher bei data.generatedAt mit TypeError.
  test("JSON-Primitive statt Objekt: Fehler statt Crash", () => {
    for (const input of ["null", "0", "123", '"x"', "true", "[]"]) {
      const out = usage.parse(input);
      expect(out.error).toBe("Antwort von omp ist kein JSON-Objekt");
      expect(out.providers).toEqual([]);
      expect(out.worst).toBe(-1);
    }
  });

  test("Fehlerreports haben dieselbe Form wie gute", () => {
    const out = usage.parse('{"error":"omp not found"}');
    expect(out.error).toBe("omp not found");
    expect(out.providers).toEqual([]);
    expect(out.sharedAccount).toBe("");
    expect(out.worstProvider).toBe("");
    expect(out.worstTitle).toBe("");
    expect(out.exhausted).toBe(false);
    expect(out.withoutUsage).toBe(0);
    expect(out.disabled).toBe(0);
  });

  test("Provider alphabetisch sortiert, worst über alle Provider", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({ provider: "zai", limits: [rawLimit({ amount: { usedFraction: 0.9 } })] }),
        rawProvider({
          provider: "anthropic",
          limits: [rawLimit({ amount: { usedFraction: 0.4 } })],
        }),
      ),
    );
    expect(out.error).toBe("");
    expect(out.providers.map((p) => p.name)).toEqual(["Anthropic", "Z.ai"]);
    expect(out.worst).toBe(0.9);
    expect(out.worstProvider).toBe("Z.ai");
    expect(out.worstTitle).toBe("Token Quota · 5 Hours");
  });

  test("Limits je Provider nach durationMs aufsteigend", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({
          limits: [
            rawLimit({ window: { label: "Monthly", durationMs: 30 * DAY } }),
            rawLimit({ window: { label: "5 Hours", durationMs: 5 * HOUR } }),
          ],
        }),
      ),
    );
    expect(out.providers[0].limits.map((l) => l.title)).toEqual([
      "Token Quota · 5 Hours",
      "Token Quota · Monthly",
    ]);
  });

  test("exhausted wird je Provider und reportweit aggregiert", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({
          provider: "anthropic",
          limits: [
            rawLimit({ amount: { usedFraction: 0.2 } }),
            rawLimit({ id: "l2", status: "exhausted" }),
          ],
        }),
      ),
    );
    expect(out.exhausted).toBe(true);
    expect(out.providers[0].exhausted).toBe(true);
  });

  test("ohne exhausted bleibt das Flag false", () => {
    const out = usage.parse(reportOf(rawProvider()));
    expect(out.exhausted).toBe(false);
  });

  test("gleiches Konto wird zu sharedAccount kollabiert", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({ provider: "zai", metadata: { email: "a@example.com" } }),
        rawProvider({ provider: "anthropic", metadata: { email: "a@example.com" } }),
      ),
    );
    expect(out.sharedAccount).toBe("a@example.com");
    expect(out.providers.every((p) => p.account === "")).toBe(true);
  });

  test("verschiedene Konten bleiben je Provider", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({ provider: "zai", metadata: { email: "a@example.com" } }),
        rawProvider({ provider: "anthropic", metadata: { email: "b@example.com" } }),
      ),
    );
    expect(out.sharedAccount).toBe("");
    const byId = Object.fromEntries(out.providers.map((p) => [p.id, p.account]));
    expect(byId).toEqual({ zai: "a@example.com", anthropic: "b@example.com" });
  });

  test("Provider ohne Limits werden nicht gelistet", () => {
    const out = usage.parse(
      reportOf(rawProvider({ limits: [] }), rawProvider({ provider: "anthropic" })),
    );
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0].id).toBe("anthropic");
  });

  test("worst bleibt -1 ohne auswertbare Füllstände", () => {
    const out = usage.parse(reportOf(rawProvider({ limits: [rawLimit({ amount: {} })] })));
    expect(out.worst).toBe(-1);
    expect(out.worstProvider).toBe("");
  });

  test("percentText: gerundet oder Gedankenstrich", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({
          limits: [
            rawLimit({ amount: { usedFraction: 0.756 } }),
            rawLimit({ amount: {}, id: "l2" }),
          ],
        }),
      ),
    );
    expect(out.providers[0].limits[0].percentText).toBe("76%");
    expect(out.providers[0].limits[1].percentText).toBe("—");
  });

  test("resetCredits: Prepaid-Guthaben oder -1", () => {
    const out = usage.parse(
      JSON.stringify({
        reports: [
          {
            provider: "openrouter",
            limits: [rawLimit()],
            resetCredits: { availableCount: 3 },
          },
        ],
      }),
    );
    expect(out.providers[0].resetCredits).toBe(3);
    expect(
      usage.parse(reportOf(rawProvider({ provider: "openrouter" }))).providers[0].resetCredits,
    ).toBe(-1);
  });

  test("reports fehlt oder ist kein Array", () => {
    const out = usage.parse("{}");
    expect(out.providers).toEqual([]);
    expect(out.error).toBe("");
  });

  // Der reports[i] || {}-Guard: ein null-Element wird übersprungen, die
  // echten Provider daneben laufen weiter (normalizeReport(null) würde
  // ohne Guard bei entry.amount werfen).
  test("null-Elemente im reports-Array werden übersprungen", () => {
    const out = usage.parse(
      JSON.stringify({ generatedAt: 1000, reports: [null, rawProvider()] }),
    );
    expect(out.error).toBe("");
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0].id).toBe("zai");
  });
});

describe("untilText", () => {
  const now = 1_000_000;

  test("Vergangenheit und sofort", () => {
    expect(usage.untilText(now - 5_000, now)).toBe("jetzt");
    expect(usage.untilText(now, now)).toBe("jetzt");
  });

  test("Minuten und Stunden", () => {
    expect(usage.untilText(now + 30_000, now)).toBe("< 1m");
    expect(usage.untilText(now + 5 * MIN, now)).toBe("5m");
    expect(usage.untilText(now + 5 * HOUR + 30 * MIN, now)).toBe("5h 30m");
    expect(usage.untilText(now + 5 * HOUR, now)).toBe("5h");
  });

  test("Tage", () => {
    expect(usage.untilText(now + 26 * HOUR, now)).toBe("1d 2h");
    expect(usage.untilText(now + 3 * DAY, now)).toBe("3d");
  });

  test("fehlerhafte Eingaben", () => {
    expect(usage.untilText(NaN, now)).toBe("");
    expect(usage.untilText(undefined, now)).toBe("");
  });
});

describe("agoText", () => {
  const now = 1_000_000;

  test("frisch und Zukunft", () => {
    expect(usage.agoText(now - 30_000, now)).toBe("gerade");
    expect(usage.agoText(now + 60_000, now)).toBe("gerade");
  });

  test("Minuten, Stunden, Tage", () => {
    expect(usage.agoText(now - 3 * MIN, now)).toBe("vor 3m");
    expect(usage.agoText(now - 2 * HOUR, now)).toBe("vor 2h");
    expect(usage.agoText(now - 3 * DAY, now)).toBe("vor 3d");
  });

  test("fehlerhafte Eingaben", () => {
    expect(usage.agoText(NaN, now)).toBe("");
  });
});
