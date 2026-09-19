// Tests für Usage.js (Parse-Vertrag). Usage.js ist eine QML-`.pragma
// library` ohne ES-Exports — der Loader in `tests/load.js` löst die
// `.import`-Direktive auf und reicht die Top-Level-Bindings als Objekt
// zurück. Providerwissen liegt ausschließlich in `providers/*.js` und
// wird über `Providers.js` aggregiert; dieses Test-File bezieht echte
// Descriptors per `providers.resolve(id)`, statt handgeschriebene
// Attrappen zu füttern.
import { describe, test, expect } from "bun:test";
import { load } from "./load.js";

const usage = load("../Usage.js", [
  "parse",
  "num",
  "usedFraction",
  "limitTitle",
  "dedupe",
  "accessLabel",
  "accountLabel",
  "amountText",
  "statusLabel",
  "compact",
  "decimal",
  "plural",
  "collapseAccounts",
  "untilText",
  "agoText",
  "refreshInterval",
  "alarmFraction",
  "rampFactor",
  "barText",
  "barTooltip",
  "parseHistory",
  "sparkline",
  "historySummary",
  "topConsumers",
  "parseStats",
  "formatMoney",
]);

const providers = load("../Providers.js", ["resolve"]);

// Neutraler Descriptor für generische Tests, die mit keinem konkreten
// Providerverhalten zu tun haben (Dedupe-Logik, Formatierung).
const NEUTRAL = providers.resolve("");

// Echte Descriptors dort, wo das Providerverhalten geprüft wird.
const ZAI = providers.resolve("zai");
const MINIMAX = providers.resolve("minimax-code");
const ANTHROPIC = providers.resolve("anthropic");

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
      NEUTRAL,
    );
    expect(out).toHaveLength(2);
    expect(out.filter((l) => l.fraction === 0.7)).toHaveLength(1);
  });

  test("ohne sharedGroup bleibt jedes Limit eigenständig", () => {
    expect(usage.dedupe([rawLimit(), rawLimit()], NEUTRAL)).toHaveLength(2);
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
      NEUTRAL,
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
      NEUTRAL,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("h");
    expect(out[0].title).toContain("5 Hour");
  });
});

describe("limitTitle / Label-Strip", () => {
  // Strip-Tokens stammen aus dem echten Z.ai-Descriptor; ändert jemand
  // dort die Liste, fällt der Test sofort.
  test("Provider- und Fenstertoken werden entfernt", () => {
    expect(usage.limitTitle("ZAI 5 Hours Token Quota", "5 Hours", ZAI.strip)).toBe(
      "Token Quota · 5 Hours",
    );
  });

  test("Label, das nur das Fenster wiederholt, fällt aufs Fenster zurück", () => {
    expect(usage.limitTitle("5 Hours", "5 Hours", ZAI.strip)).toBe("5 Hours");
  });

  test("Regex-Sonderzeichen im Token werden escaped", () => {
    // "C++" wäre als Regex ein SyntaxError; escaped wird es als Wort gestrippt
    expect(usage.limitTitle("Z.ai C++ Pro Quota", "C++", ZAI.strip)).toBe("Pro Quota · C++");
  });

  test("Fenster-Token werden mitgestrippt; bloßes 'Quota' trägt nichts", () => {
    expect(usage.limitTitle("Z.ai Pro Quota", "Pro", ZAI.strip)).toBe("Pro");
  });

  test("leeres Label", () => {
    expect(usage.limitTitle("", "5 Hours", [])).toBe("5 Hours");
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
      NEUTRAL,
    );
    expect(out[0].exhausted).toBe(true);
    expect(out[0].statusLabel).toBe("erschöpft");
    expect(out[0].fraction).toBe(0.9);
  });

  test("ohne status bleibt alles ok", () => {
    const out = usage.dedupe([rawLimit()], NEUTRAL);
    expect(out[0].status).toBe("ok");
    expect(out[0].statusLabel).toBe("");
    expect(out[0].exhausted).toBe(false);
  });
});

// MiniMax' Wochenfenster existiert nicht — im Dashboard steht dort
// "Unlimited". omp rechnet aus `current_weekly_remaining_percent: 100`
// trotzdem ein 7-Tage-Fenster mit 0 % aus, und das sah im Panel wie ein
// unangetastetes Kontingent aus.
describe("unbegrenzte Fenster", () => {
  // MiniMax' 7-Tage-Fenster, wie omp es liefert.
  function weekly(overrides = {}) {
    return rawLimit({
      id: "general:7d",
      label: "General 7 Day",
      scope: { provider: "minimax-code", shared: true, windowId: "7d" },
      window: { id: "7d", label: "7 Day", durationMs: 7 * DAY, resetsAt: 9000 },
      amount: { used: 0, usedFraction: 0, remaining: 100, remainingFraction: 1, unit: "percent" },
      ...overrides,
    });
  }

  test("MiniMax' 7-Tage-Fenster wird als unbegrenzt gezeigt, nicht als 0 %", () => {
    const out = usage.dedupe([weekly()], MINIMAX);
    expect(out[0].unlimited).toBe(true);
    expect(out[0].percentText).toBe("∞");
    expect(out[0].statusLabel).toBe("unbegrenzt");
    // Kein Füllstand: der Meter bleibt leer (Panel zeichnet erst ab 0).
    expect(out[0].fraction).toBe(-1);
    // Das Ende einer Woche ohne Limit ist kein Reset.
    expect(out[0].resetsAt).toBeNaN();
  });

  test("echter Wochenverbrauch zählt wieder als Kontingent", () => {
    const out = usage.dedupe(
      [weekly({ amount: { usedFraction: 0.3, unit: "percent" } })],
      MINIMAX,
    );
    expect(out[0].unlimited).toBe(false);
    expect(out[0].percentText).toBe("30%");
    expect(out[0].resetsAt).toBe(9000);
  });

  test("nur das gelistete Fenster des gelisteten Providers", () => {
    // MiniMax' 5-h-Fenster: frisch zurückgesetzt, aber ein echtes Limit.
    const interval = usage.dedupe(
      [weekly({ window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: 9000 } })],
      MINIMAX,
    );
    expect(interval[0].unlimited).toBe(false);
    expect(interval[0].percentText).toBe("0%");

    // Anthropics 7-Tage-Fenster am Wochenanfang steht ebenfalls auf 0 %.
    const other = usage.dedupe([weekly()], ANTHROPIC);
    expect(other[0].unlimited).toBe(false);
    expect(other[0].percentText).toBe("0%");
  });

  test("ein unbegrenztes Fenster verschiebt worst nicht", () => {
    const out = usage.parse(
      reportOf({
        provider: "minimax-code",
        metadata: { models: ["general"] },
        limits: [
          weekly(),
          rawLimit({
            id: "general:5h",
            label: "General 5 Hour",
            window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: 3000 },
            amount: { usedFraction: 0.04, unit: "percent" },
          }),
        ],
      }),
    );
    expect(out.worst).toBeCloseTo(0.04);
    expect(out.worstTitle).toBe("General · 5 Hour");
    expect(out.providers[0].worstTitle).toBe("General · 5 Hour");
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

describe("accessLabel / accountLabel", () => {
  // Die Metadaten unten sind die echten Felder aus `omp usage --json`:
  // planType liefert nur zai/openai-codex, die übrigen Provider gar keinen
  // Plan. Jede Angabe trägt ihr Substantiv — sonst stünde in derselben
  // Spalte "lite" neben "Org Ada Lovelace".
  test("jede Angabe trägt ihr Substantiv, auch der Plan", () => {
    // zai / openai-codex
    expect(usage.accessLabel({ planType: "lite" })).toBe("Plan lite");
    // anthropic
    expect(
      usage.accessLabel({ email: "a@example.com", orgName: "Ada Lovelace" }),
    ).toBe("Org Ada Lovelace");
    // google-antigravity
    expect(
      usage.accessLabel({ email: "a@example.com", projectId: "example-project" }),
    ).toBe("Projekt example-project");
    // minimax-code: `video` ist gemeldet, aber nicht nutzbar
    expect(
      usage.accessLabel({
        source: "minimax-token-plan",
        models: ["general", "video"],
        unavailableModels: ["video"],
      }),
    ).toBe("Modell general");
    expect(usage.accessLabel({ models: ["general", "video"] })).toBe(
      "Modelle general, video",
    );
  });

  // Regressionsfall: `orgName` ist bei Consumer-Accounts der Name der
  // Person. Als Plan gelesen stand dort "Anthropic · Ada Lovelace".
  test("der Plan hat Vorrang, jede Angabe steht allein", () => {
    // openai-codex meldet orgName "free" — gleich dem planType.
    expect(usage.accessLabel({ planType: "free", orgName: "free" })).toBe("Plan free");
    expect(usage.accessLabel({ planType: "pro", orgName: "acme" })).toBe("Plan pro");
    expect(usage.accessLabel({ orgName: "acme", projectId: "p1" })).toBe("Org acme");
  });

  test("ohne jede Angabe bleibt der Slot leer", () => {
    expect(usage.accessLabel({ email: "a@example.com" })).toBe("");
    expect(usage.accessLabel({})).toBe("");
    // Alle Modelle blockiert: keine Auskunft ist besser als "Modelle ".
    expect(usage.accessLabel({ models: ["video"], unavailableModels: ["video"] })).toBe("");
  });

  // Non-Array-Felder werden ignoriert, nicht als Zeichenliste iteriert —
  // ein Refactor mit Array.from würde aus "general" 7 Buchstaben-Modelle
  // machen, und das ginge sonst unbemerkt durch.
  test("models als String statt Array wird ignoriert", () => {
    expect(usage.accessLabel({ models: "general" })).toBe("");
    expect(
      usage.accessLabel({ models: ["general"], unavailableModels: "general" }),
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
  // ein leeres Konto übersprungen — das einzige nicht-leere wandert in die
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

  // Auf Vertragsebene: ein unbekannter Provider wird über die Registry
  // aufgelöst, der Anzeigename entsteht via fallbackName() per
  // Titelcasing — Kerncode hält sich an das Schema und überlässt die
  // Namensbildung der Registry.
  test("unbekannter Provider liefert einen titelcasierten Anzeigenamen", () => {
    const out = usage.parse(
      reportOf(
        rawProvider({ provider: "some-new-provider", limits: [rawLimit({ amount: {} })] }),
      ),
    );
    expect(out.error).toBe("");
    expect(out.providers[0].name).toBe("Some New Provider");
    expect(out.providers[0].id).toBe("some-new-provider");
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

// Diese fünf Funktionen saßen als Inline-Ausdruck in Panel.qml und waren
// damit von keinem Test erreichbar — die Grenzen der Settings und die Form
// der Farbrampe waren reine Behauptung.
describe("refreshInterval", () => {
  test("klemmt auf 60..3600 s", () => {
    expect(usage.refreshInterval(600, 300)).toBe(600);
    expect(usage.refreshInterval(5, 300)).toBe(60);
    expect(usage.refreshInterval(99999, 300)).toBe(3600);
  });

  test("rundet und akzeptiert numerische Strings (shell.json ohne --json)", () => {
    expect(usage.refreshInterval("600", 300)).toBe(600);
    expect(usage.refreshInterval(600.6, 300)).toBe(601);
  });

  test("unbrauchbare Eingabe fällt auf den Default, nicht auf 0", () => {
    expect(usage.refreshInterval(undefined, 300)).toBe(300);
    expect(usage.refreshInterval(null, 300)).toBe(300);
    expect(usage.refreshInterval("", 300)).toBe(300);
    expect(usage.refreshInterval("viel", 300)).toBe(300);
    expect(usage.refreshInterval(true, 300)).toBe(300);
  });
});

describe("alarmFraction", () => {
  test("Prozent wird Anteil", () => {
    expect(usage.alarmFraction(90, 90)).toBeCloseTo(0.9);
    expect(usage.alarmFraction(75, 90)).toBeCloseTo(0.75);
  });

  test("nie 0: eine Schwelle von 0 färbte jedes Kontingent dauerhaft", () => {
    expect(usage.alarmFraction(0, 90)).toBeCloseTo(0.05);
    expect(usage.alarmFraction(-40, 90)).toBeCloseTo(0.05);
  });

  test("über 100 % bleibt bei 1", () => {
    expect(usage.alarmFraction(140, 90)).toBe(1);
  });

  test("unbrauchbare Eingabe nimmt den Default", () => {
    expect(usage.alarmFraction(null, 90)).toBeCloseTo(0.9);
    expect(usage.alarmFraction("", 90)).toBeCloseTo(0.9);
  });
});

describe("rampFactor", () => {
  test("0 bei leerem Kontingent, 1 ab der Schwelle", () => {
    expect(usage.rampFactor(0, 0.9)).toBe(0);
    expect(usage.rampFactor(0.9, 0.9)).toBe(1);
    expect(usage.rampFactor(1, 0.9)).toBe(1);
  });

  test("monoton steigend zwischen 0 und der Schwelle", () => {
    var previous = -1;
    for (var f = 0; f <= 0.9; f += 0.1) {
      const value = usage.rampFactor(f, 0.9);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  test("Kurve liegt unter der Diagonale — die untere Hälfte bleibt ruhig", () => {
    // Genau das ist der Zweck des Exponenten: linear wäre die halbe
    // Schwelle schon halb alarmfarben.
    expect(usage.rampFactor(0.45, 0.9)).toBeLessThan(0.3);
    expect(usage.rampFactor(0.8, 0.9)).toBeLessThan(0.8);
  });

  test("unbegrenzt und ohne Angabe bleiben ruhig", () => {
    expect(usage.rampFactor(-1, 0.9)).toBe(0);
    expect(usage.rampFactor(NaN, 0.9)).toBe(0);
  });

  test("Schwelle 0 kippt nicht in eine Division durch 0", () => {
    expect(usage.rampFactor(0.5, 0)).toBe(1);
  });
});

describe("barText", () => {
  test("Glyph mit Prozentwert", () => {
    expect(usage.barText("G", 0.6, false, false)).toBe("G 60%");
  });

  test("Fehler schlägt den Wert", () => {
    expect(usage.barText("G", 0.6, true, false)).toBe("G !");
  });

  test("vertikale Bar zeigt nur das Glyph — 28 px tragen keine Zahl", () => {
    expect(usage.barText("G", 0.6, false, true)).toBe("G");
  });

  test("ohne Messung nur das Glyph", () => {
    expect(usage.barText("G", -1, false, false)).toBe("G");
    expect(usage.barText("G", NaN, false, false)).toBe("G");
  });
});

describe("barTooltip", () => {
  const now = 1_000_000;
  const MINUTE = 60 * 1000;
  const report = {
    generatedAt: now - 3 * MINUTE,
    worst: 0.6,
    worstProvider: "Z.ai",
    worstTitle: "Token Quota · 5 Hours",
    exhausted: false,
  };

  test("Wert, Provider und Fenster", () => {
    expect(usage.barTooltip(report, "", now)).toBe(
      "omp: 60% — Z.ai · Token Quota · 5 Hours",
    );
  });

  test("erschöpft wird benannt — 100 % sagt nicht, dass nichts mehr geht", () => {
    expect(usage.barTooltip({ ...report, worst: 1, exhausted: true }, "", now))
      .toContain("(Kontingent erschöpft)");
  });

  test("mit Fehler bleibt die Zahl, bekommt aber ihr Alter und die konkrete Meldung", () => {
    const text = usage.barTooltip(report, "Timeout nach 20s", now);
    expect(text).toContain("omp: 60%");
    expect(text).toContain("Stand vor 3m");
    expect(text).toContain("Timeout nach 20s");
  });

  test("ohne Messung nur der Fehler bzw. der Titel", () => {
    expect(usage.barTooltip(usage.parse("{}"), "omp weg", now)).toBe("omp: omp weg");
    expect(usage.barTooltip(usage.parse("{}"), "", now)).toBe("omp-Kontingente");
  });
});

// Echte Snapshot-Form aus `omp usage --json --history` (gekürzt auf die
// Felder, die parseHistory liest). Mehrere Konten desselben Fensters und
// nicht aufsteigende Zeitstempel sind reale omp-Ausgaben.
function rawEntry(overrides = {}) {
  return {
    recordedAt: 1789574060219,
    provider: "anthropic",
    accountKey: "oauth|account:x|email:a@example.com",
    email: "a@example.com",
    accountId: "x",
    limitId: "anthropic:5h",
    label: "Claude 5 Hour",
    windowLabel: "5 Hour",
    usedFraction: 0.5,
    status: "ok",
    resetsAt: 1789587260219,
    ...overrides,
  };
}

describe("parseHistory", () => {
  test("Snapshots je limitId, aufsteigend nach recordedAt", () => {
    const result = usage.parseHistory(JSON.stringify({
      entries: [
        rawEntry({ recordedAt: 2000, usedFraction: 0.3 }),
        rawEntry({ recordedAt: 1000, usedFraction: 0.1 }),
      ],
    }));
    expect(result.error).toBe("");
    expect(result.series["anthropic:5h"].map((p) => p.f)).toEqual([0.1, 0.3]);
  });

  test("mehrere Konten je Zeitstempel: der höchste Stand gewinnt", () => {
    const result = usage.parseHistory(JSON.stringify({
      entries: [
        rawEntry({ accountId: "a", usedFraction: 0.2 }),
        rawEntry({ accountId: "b", usedFraction: 0.9 }),
        rawEntry({ accountId: "a", usedFraction: 0.4, recordedAt: 1789574060220 }),
      ],
    }));
    expect(result.series["anthropic:5h"].map((p) => p.f)).toEqual([0.9, 0.4]);
  });

  test("Einträge ohne limitId oder Füllstand fallen raus", () => {
    const result = usage.parseHistory(JSON.stringify({
      entries: [
        rawEntry({ limitId: "" }),
        rawEntry({ usedFraction: null }),
        rawEntry({ recordedAt: "x" }),
        rawEntry({ usedFraction: 0.7 }),
      ],
    }));
    expect(result.series["anthropic:5h"].map((p) => p.f)).toEqual([0.7]);
  });

  test("Füllstände über 1 werden geklemmt", () => {
    const result = usage.parseHistory(JSON.stringify({
      entries: [rawEntry({ usedFraction: 1.5 })],
    }));
    expect(result.series["anthropic:5h"][0].f).toBe(1);
  });

  test("Fehlerobjekt wird als Fehler durchgereicht", () => {
    expect(usage.parseHistory('{"error":"omp weg"}').error).toBe("omp weg");
    expect(usage.parseHistory('{"error":"omp weg"}').series).toEqual({});
  });

  test("leer, kaputt oder kein Objekt: lesbarer Fehler, leere Serie", () => {
    expect(usage.parseHistory("").error).toContain("Keine Antwort");
    expect(usage.parseHistory("kein json").error).toContain("kein JSON");
    expect(usage.parseHistory("null").error).toContain("kein JSON-Objekt");
    expect(usage.parseHistory("[1]").error).toContain("kein JSON-Objekt");
  });

  test("fehlende entries: kein Fehler, leere Serie", () => {
    const result = usage.parseHistory("{}");
    expect(result.error).toBe("");
    expect(result.series).toEqual({});
  });
});

describe("sparkline", () => {
  const pts = (fs) => fs.map((f) => ({ t: 0, f }));

  test("Maximum je Bucket — die Spitze überlebt das Verdichten", () => {
    // 10 Punkte -> 5 Balken; Bucket 1 enthält die 0.92-Spitze.
    const bars = usage.sparkline(pts([0.1, 0.2, 0.92, 0.3, 0.4, 0.1, 0.5, 0.1, 0.2, 0.1]), 5);
    expect(bars).toEqual([0.2, 0.92, 0.4, 0.5, 0.2]);
  });

  test("weniger Punkte als Balken bleiben unverdichtet", () => {
    expect(usage.sparkline(pts([0.1, 0.5, 0.3]), 26)).toEqual([0.1, 0.5, 0.3]);
  });

  test("NaN-Punkte zählen als 0 — ein Loch ist kein Verbrauch", () => {
    expect(usage.sparkline([{ t: 0, f: "x" }, { t: 1 }, { t: 2, f: 0.4 }], 26))
      .toEqual([0, 0, 0.4]);
  });

  test("Werte über 1 werden geklemmt", () => {
    expect(usage.sparkline(pts([1.5]), 3)).toEqual([1]);
  });

  test("unbrauchbare Eingaben: leere Liste", () => {
    expect(usage.sparkline(undefined, 26)).toEqual([]);
    expect(usage.sparkline(pts([0.5]), 0)).toEqual([]);
    expect(usage.sparkline(pts([0.5]), NaN)).toEqual([]);
  });
});

describe("historySummary", () => {
  // Zeilen mit echten Zeitstempeln — first/last sind Teil des Vertrags.
  const rows = (fs) => fs.map((f, i) => ({ t: i * 3600, f }));

  test("Durchschnitt, Spitze und Anzahl über die gültigen Punkte", () => {
    const s = usage.historySummary(rows([0.1, 0.92, 0.3]));
    expect(s.count).toBe(3);
    expect(s.average).toBeCloseTo((0.1 + 0.92 + 0.3) / 3, 12);
    expect(s.peak).toBeCloseTo(0.92, 12);
    expect(s.first).toBe(0);
    expect(s.last).toBe(7200);
  });

  test("ein Punkt: Spitze gleich Durchschnitt, first gleich last", () => {
    const s = usage.historySummary(rows([0.5]));
    expect(s.count).toBe(1);
    expect(s.average).toBeCloseTo(0.5, 12);
    expect(s.peak).toBeCloseTo(0.5, 12);
    expect(s.first).toBe(0);
    expect(s.last).toBe(0);
  });

  test("NaN-Punkte werden übersprungen, Zeitstempel trotzdem geführt", () => {
    const s = usage.historySummary([{ t: 10, f: "x" }, { t: 20, f: 0.4 }, { t: 30 }]);
    expect(s.count).toBe(1);
    expect(s.average).toBeCloseTo(0.4, 12);
    expect(s.peak).toBeCloseTo(0.4, 12);
    expect(s.first).toBe(20);
    expect(s.last).toBe(20);
  });

  test("Werte werden auf 0..1 geklemmt", () => {
    const s = usage.historySummary(rows([1.5, -0.2]));
    expect(s.average).toBe(0.5);
    expect(s.peak).toBe(1);
  });

  test("leere und unbrauchbare Eingaben: alles NaN, count 0", () => {
    for (const input of [undefined, null, [], [{}], [{ t: 1 }, { t: 2, f: "x" }]]) {
      const s = usage.historySummary(input);
      expect(s.count).toBe(0);
      expect(s.average).toBeNaN();
      expect(s.peak).toBeNaN();
      expect(s.first).toBeNaN();
      expect(s.last).toBeNaN();
    }
  });
});

describe("topConsumers", () => {
  // Drei Provider: A mit zwei Fenstern (nur das schlimmste zählt), B mit
  // einem, C ohne Aufzeichnung. Nur Fenster mit ≥ 2 Punkten gelten.
  const PROVIDERS = [
    { name: "A", limits: [{ id: "a5", title: "A 5h" }, { id: "aweek", title: "A week" }] },
    { name: "B", limits: [{ id: "b5", title: "B 5h" }, { id: "b-empty", title: "B leer" }] },
    { name: "C", limits: [{ id: "c5", title: "C 5h" }] },
  ];

  test("je Provider genau ein Fenster: das mit der höchsten Spitze", () => {
    const series = {
      a5: [{ t: 0, f: 0.9 }, { t: 3600, f: 0.2 }],
      aweek: [{ t: 0, f: 0.5 }, { t: 3600, f: 0.5 }],
      b5: [{ t: 0, f: 0.7 }, { t: 3600, f: 0.4 }],
    };
    const top = usage.topConsumers(PROVIDERS, series, 3);
    // A nur einmal (a5, Peak 0.9 — nicht aweek), B einmal, C ohne Daten raus.
    expect(top.map((e) => e.limit.id)).toEqual(["a5", "b5"]);
    expect(top.map((e) => e.provider.name)).toEqual(["A", "B"]);
    expect(top[0].peak).toBeCloseTo(0.9, 12);
  });

  test("Provider-Rang folgt der Spitze ihres schlimmsten Fensters", () => {
    const series = {
      a5: [{ t: 0, f: 0.4 }, { t: 3600, f: 0.3 }],
      b5: [{ t: 0, f: 0.8 }, { t: 3600, f: 0.2 }],
      c5: [{ t: 0, f: 0.6 }, { t: 3600, f: 0.6 }],
    };
    const top = usage.topConsumers(PROVIDERS, series, 3);
    expect(top.map((e) => e.provider.name)).toEqual(["B", "C", "A"]);
  });

  test("Fenster ohne Aufzeichnung (unter 2 Punkten) fallen heraus", () => {
    const series = {
      a5: [{ t: 0, f: 0.9 }, { t: 3600, f: 0.2 }],
      "b-empty": [{ t: 0, f: 1.0 }],
    };
    const top = usage.topConsumers(PROVIDERS, series, 3);
    expect(top.map((e) => e.provider.name)).toEqual(["A"]);
  });

  test("count kürzt die Liste", () => {
    const series = {
      a5: [{ t: 0, f: 0.9 }, { t: 3600, f: 0.2 }],
      b5: [{ t: 0, f: 0.7 }, { t: 3600, f: 0.4 }],
      c5: [{ t: 0, f: 0.6 }, { t: 3600, f: 0.6 }],
    };
    expect(usage.topConsumers(PROVIDERS, series, 2).map((e) => e.provider.name))
      .toEqual(["A", "B"]);
    expect(usage.topConsumers(PROVIDERS, series, 1).map((e) => e.provider.name))
      .toEqual(["A"]);
  });

  test("unbrauchbare Eingaben: leere Liste", () => {
    expect(usage.topConsumers(undefined, undefined, 3)).toEqual([]);
    expect(usage.topConsumers(PROVIDERS, undefined, 3)).toEqual([]);
    expect(usage.topConsumers(PROVIDERS, [], 3)).toEqual([]);
    expect(usage.topConsumers(PROVIDERS, { a5: [{ t: 0, f: 0.5 }, { t: 1, f: 0.5 }] }, NaN)).toEqual([]);
    expect(usage.topConsumers(PROVIDERS, { a5: [{ t: 0, f: 0.5 }, { t: 1, f: 0.5 }] }, 0)).toEqual([]);
  });

  test("regression: bei peak+avg-Gleichstand entscheidet der Providername", () => {
    // Vorher: Reihenfolge hing von der parse-Sortierung ab. Bei wechselnder
    // parse-Eingabereihenfolge (Providerliste kommt sortiert aus parse())
    // rutschten gleichwertige Provider in der Top-Verbraucher-Liste hin
    // und her. Jetzt: alphabetisch nach Providername.
    const series = {
      a5: [{ t: 0, f: 0.5 }, { t: 3600, f: 0.5 }],
      b5: [{ t: 0, f: 0.5 }, { t: 3600, f: 0.5 }],
      c5: [{ t: 0, f: 0.5 }, { t: 3600, f: 0.5 }],
    };
    const names = (list) =>
      usage.topConsumers(list, series, 3).map((e) => e.provider.name);
    // Lieferreihenfolge gewechselt: Ergebnis bleibt alphabetisch stabil.
    expect(names([PROVIDERS[0], PROVIDERS[1], PROVIDERS[2]]))
      .toEqual(["A", "B", "C"]);
    expect(names([PROVIDERS[2], PROVIDERS[1], PROVIDERS[0]]))
      .toEqual(["A", "B", "C"]);
    expect(names([PROVIDERS[1], PROVIDERS[0], PROVIDERS[2]]))
      .toEqual(["A", "B", "C"]);
  });
});

// Echte omp-stats-Form (gekürzt auf die Felder, die parseStats liest).
const STATS_RAW = JSON.stringify({
  overall: {
    totalRequests: 2297,
    failedRequests: 10,
    totalInputTokens: 5469798,
    totalOutputTokens: 1232622,
    cacheRate: 0.9756,
    totalCost: 102.8004,
  },
  byModel: [
    { model: "glm-5.3", provider: "zai", totalRequests: 164, totalCost: 3.99 },
    { model: "claude-opus-5", provider: "anthropic", totalRequests: 675, totalCost: 94.28 },
    { model: "MiniMax-M3", provider: "minimax-code", totalRequests: 820, totalCost: 0 },
  ],
});

describe("parseStats", () => {
  test("Gesamtblock wird übernommen", () => {
    const { error, stats } = usage.parseStats(STATS_RAW);
    expect(error).toBe("");
    expect(stats.requests).toBe(2297);
    expect(stats.errors).toBe(10);
    expect(stats.cost).toBeCloseTo(102.8004);
    expect(stats.cacheRate).toBeCloseTo(0.9756);
  });

  test("Modelle nach Kosten absteigend, bei Gleichstand nach Last", () => {
    const { stats } = usage.parseStats(STATS_RAW);
    expect(stats.models.map((m) => m.name)).toEqual([
      "claude-opus-5", "glm-5.3", "MiniMax-M3",
    ]);
  });

  test("unbepreiste Modelle mit mehr Last schlagen vor teurere ohne Last", () => {
    const { stats } = usage.parseStats(JSON.stringify({
      overall: {},
      byModel: [
        { model: "a", totalRequests: 1, totalCost: 5 },
        { model: "b", totalRequests: 900, totalCost: 0 },
        { model: "c", totalRequests: 50, totalCost: 0 },
      ],
    }));
    expect(stats.models.map((m) => m.name)).toEqual(["a", "b", "c"]);
  });

  test("Fehlerobjekt und kaputte Eingabe: Fehler, stats null", () => {
    expect(usage.parseStats('{"error":"weg"}').error).toBe("weg");
    expect(usage.parseStats("").error).toContain("Keine Antwort");
    expect(usage.parseStats("nix").error).toContain("kein JSON");
    expect(usage.parseStats("5").error).toContain("kein JSON-Objekt");
    expect(usage.parseStats('{"error":"weg"}').stats).toBeNull();
  });

  test("fehlende Felder: leere, aber gültige Ansicht", () => {
    const { error, stats } = usage.parseStats("{}");
    expect(error).toBe("");
    expect(stats.models).toEqual([]);
    expect(stats.requests).toBe(0);
  });
});

describe("formatMoney", () => {
  test("deutsches Komma, zwei Nachkommastellen", () => {
    expect(usage.formatMoney(102.8004)).toBe("$102,80");
    expect(usage.formatMoney(0.5)).toBe("$0,50");
  });

  test("ab 1000 ohne Nachkommastellen", () => {
    expect(usage.formatMoney(1234.56)).toBe("$1235");
  });

  test("regression: Rundung an der 1000-Schwelle", () => {
    // Vorher: formatMoney(999.999) prüfte die Schwelle auf dem ungerundeten
    // Wert (< 1000) und gab dann n.toFixed(2) aus — kaufmännisches Runden
    // macht aus 999.999 dort "1000.00" ("$1000,00"), eine 4+2-Darstellung
    // für einen Wert, der laut Schwelle keine Cents mehr haben sollte.
    // Jetzt: erst auf 2 Dezimalstellen runden, dann Schwelle auf dem
    // gerundeten Wert prüfen.
    expect(usage.formatMoney(999.999)).toBe("$1000");
    expect(usage.formatMoney(999.995)).toBe("$1000");
    // Knapp darunter bleibt im Cent-Bereich.
    expect(usage.formatMoney(999.99)).toBe("$999,99");
    expect(usage.formatMoney(999.994)).toBe("$999,99");
    // Die alte Verhaltensgrenze wandert nicht.
    expect(usage.formatMoney(1000)).toBe("$1000");
    expect(usage.formatMoney(999)).toBe("$999,00");
  });

  test("unbrauchbare Eingabe: leer", () => {
    expect(usage.formatMoney(null)).toBe("");
    expect(usage.formatMoney("x")).toBe("");
  });

  test("negative Beträge korrekt formatiert", () => {
    expect(usage.formatMoney(-999.999)).toBe("-$1000");
    expect(usage.formatMoney(-999.99)).toBe("-$999,99");
    expect(usage.formatMoney(-56.46)).toBe("-$56,46");
    expect(usage.formatMoney(-1234.56)).toBe("-$1235");
  });

  test("regression: negative Rundung an der Schwelle — -999.999 ergibt -$1000, nicht -$1000,00", () => {
    // gerundet: -999.999 -> -1000.00; Schwelle >= 1000 -> String(Math.round(-1000)) = "-1000"
    expect(usage.formatMoney(-999.999)).toBe("-$1000");
  });

  test("-0.00 zeigt nicht $-0,00", () => {
    // Math.round(-0.001*100) = Math.round(-0.1) = 0 (JS rundet -0.1 zu 0)
    // Also ergibt -0.001 -> $0,00 (korrekt, weil der Betrag 0 ist)
    expect(usage.formatMoney(-0.001)).toBe("$0,00");
    // -0.005 -> Math.round(-0.5) = 0 -> $0,00 (nach -0.5 wird zu 0 gerundet)
    expect(usage.formatMoney(-0.005)).toBe("$0,00");
  });
});