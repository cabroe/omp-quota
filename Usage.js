.pragma library

// Normalisierung des `omp usage --json`-Reports auf eine Form, die das Panel
// direkt rendern kann. Reine Funktionen, keine QML-Abhängigkeiten — damit
// derselbe Code mit `bun Usage.test.js` gegen echte omp-Ausgaben läuft.
//
// Der Rohreport hat vier Eigenheiten, die hier verschwinden:
//
//  1. Mengenangaben sind uneinheitlich. Anthropic liefert used/limit/unit
//     "percent", ZAI liefert für Token-Fenster nur `usedFraction`. Einzig
//     `usedFraction` ist überall vorhanden, also ist das die Wahrheit.
//  2. Google Antigravity meldet ein geteiltes Kontingent dreimal — einmal je
//     Upstream-Modellfamilie — mit identischen Zahlen und gemeinsamem
//     `scope.sharedGroup`. Dreimal dieselbe Zeile ist kein Mehrwert.
//  3. Labels verdoppeln Provider- und Fenstername ("ZAI 5 Hours Token
//     Quota" im Fenster "5 Hours"). Der Provider steht schon in der
//     Abschnittsüberschrift.
//  4. Dasselbe Konto steht in jedem Provider-Report. Viermal dieselbe
//     E-Mail (im Redaktionsmodus viermal "ca*") ist Rauschen, also wandert
//     ein providerübergreifend gleiches Konto nach `sharedAccount`.

// Anzeigename je Provider plus die Tokens, die in einem Limit-Label
// redundant sind, weil der Provider bereits darüber steht.
var PROVIDERS = {
  "anthropic": { name: "Anthropic", strip: ["Anthropic"] },
  "openai-codex": { name: "OpenAI Codex", strip: ["OpenAI", "Codex"] },
  "zai": { name: "Z.ai", strip: ["ZAI", "Z.ai"] },
  "google-antigravity": { name: "Google Antigravity", strip: ["Google", "Antigravity"] },
  "minimax-code": { name: "MiniMax Code", strip: ["MiniMax"] },
  "openrouter": { name: "OpenRouter", strip: ["OpenRouter"] },
  "github-copilot": { name: "GitHub Copilot", strip: ["GitHub", "Copilot"] }
};

// omps Statusvokabular, aus der Quelle der Zuordnung in der omp-Binary:
// kein Restkontingent -> "exhausted", bis 10 % Rest -> "warning", ohne
// Angabe -> "unknown". "ok" braucht kein Etikett, der Prozentwert steht
// schon daneben.
var STATUS_LABELS = {
  "ok": "",
  "warning": "fast leer",
  "exhausted": "erschöpft",
  "unknown": "unbekannt"
};

// Einheiten, in denen omp zählt. Unbekannte Einheit wird unverändert
// durchgereicht — falsch übersetzt ist schlechter als englisch.
var UNITS = {
  "request": "Anfragen",
  "requests": "Anfragen",
  "token": "Tokens",
  "tokens": "Tokens",
  "credit": "Credits",
  "credits": "Credits",
  "message": "Nachrichten",
  "messages": "Nachrichten"
};

function providerName(id) {
  var known = PROVIDERS[id];
  if (known)
    return known.name;
  // Unbekannter Provider: "some-new-provider" -> "Some New Provider".
  var parts = String(id || "").split(/[-_.]/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length === 0)
      continue;
    out.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));
  }
  return out.length > 0 ? out.join(" ") : "Unbekannt";
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function num(value) {
  // Number(null), Number("") und Number(false) sind alle 0 — ohne diesen
  // Guard würde ein JSON-null in omps Report als 0% oder als Reset
  // "jetzt" erscheinen, statt als "keine Angabe" durch NaN zu fallen.
  // Numerische Strings ("0.3") und echte 0 bleiben unberührt.
  if (value === null || value === "" || typeof value === "boolean")
    return NaN;
  var n = Number(value);
  return isFinite(n) ? n : NaN;
}

// "1 Zugang" / "2 Zugänge". Ein hart singulares Label ist bei zwei Einträgen
// schlicht falsch.
function plural(count, one, many) {
  var n = num(count);
  if (!isFinite(n))
    return "";
  return n + " " + (n === 1 ? one : many);
}

// Kompakte Zahl mit deutschem Dezimalkomma: 850, 1,2k, 12k, 4,1M. Token-
// Fenster reden in Millionen, Request-Fenster in Dutzenden.
function compact(value) {
  var n = num(value);
  if (!isFinite(n))
    return "";
  var abs = Math.abs(n);
  if (abs < 1000)
    return String(Math.round(n));
  if (abs < 1000000)
    return decimal(n / 1000, abs < 10000) + "k";
  return decimal(n / 1000000, true) + "M";
}

function decimal(value, withFraction) {
  var text = withFraction ? value.toFixed(1) : String(Math.round(value));
  return text.replace(".", ",").replace(/,0$/, "");
}

// Anteil des verbrauchten Kontingents als 0..1, oder -1 wenn der Provider
// dazu nichts sagt. `usedFraction` ist das einzige Feld, das jeder Provider
// liefert; used/limit sind der Fallback, wenn eine künftige Version die
// Fraktion weglässt.
function usedFraction(amount) {
  if (!amount)
    return -1;
  var fraction = num(amount.usedFraction);
  if (isFinite(fraction))
    return clamp(fraction, 0, 1);
  var remaining = num(amount.remainingFraction);
  if (isFinite(remaining))
    return clamp(1 - remaining, 0, 1);
  var used = num(amount.used);
  var limit = num(amount.limit);
  if (isFinite(used) && isFinite(limit) && limit > 0)
    return clamp(used / limit, 0, 1);
  return -1;
}

// Der Absolutwert, aber nur wo er mehr sagt als der Prozentwert: bei
// `unit: "percent"` wiederholt er ihn bloß. Z.ai zählt Zread in Anfragen,
// da ist "1/100 Anfragen" die eigentliche Aussage hinter "1 %".
function amountText(amount) {
  var meta = amount || {};
  var unit = String(meta.unit || "").trim().toLowerCase();
  if (unit.length === 0 || unit === "percent")
    return "";
  var used = num(meta.used);
  var limit = num(meta.limit);
  if (!isFinite(used) || !isFinite(limit) || limit <= 0)
    return "";
  var name = UNITS[unit];
  return compact(used) + "/" + compact(limit) + " " + (name !== undefined ? name : unit);
}

function statusLabel(status) {
  var key = String(status || "ok").trim().toLowerCase();
  var known = STATUS_LABELS[key];
  return known !== undefined ? known : key;
}

// Entfernt aus einem Limit-Label alles, was der Kontext schon hergibt: den
// Providernamen und den Fensternamen. Übrig bleibt, was das Limit von den
// anderen Limits desselben Providers unterscheidet ("Claude", "Gemini",
// "Zread Quota") — oder nichts, wenn das Label nur das Fenster wiederholt.
function limitSubject(label, windowLabel, strip) {
  var text = String(label || "").trim();
  if (text.length === 0)
    return "";

  var tokens = (strip || []).slice();
  if (windowLabel)
    tokens.push(String(windowLabel));

  for (var i = 0; i < tokens.length; i++) {
    var token = String(tokens[i] || "").trim();
    if (token.length === 0)
      continue;
    // Escaping, damit "Z.ai" nicht als Regex-Klasse gelesen wird.
    var escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp("(^|\\s)" + escaped + "(?=\\s|$)", "gi"), " ");
  }

  text = text.replace(/\s+/g, " ").trim();
  // Ein alleinstehendes "Quota"/"Kontingent" trägt nach dem Strippen nichts.
  if (/^(quota|limit|usage)$/i.test(text))
    return "";
  return text;
}

function limitTitle(label, windowLabel, strip) {
  var subject = limitSubject(label, windowLabel, strip);
  var window = String(windowLabel || "").trim();
  if (subject.length === 0)
    return window.length > 0 ? window : String(label || "").trim();
  if (window.length === 0)
    return subject;
  return subject + " · " + window;
}

// Eine Zeile im Panel: Titel, Füllstand, Absolutwert, Status, Reset.
function normalizeLimit(entry, strip) {
  var amount = entry.amount || {};
  var window = entry.window || {};
  var fraction = usedFraction(amount);
  // omp markiert ein erschöpftes Kontingent über `status`. Das ist die
  // einzige Stelle, an der ein Überziehen sichtbar wird: `fraction` ist auf
  // 1 begrenzt, weil der Meter nicht über den Rand laufen darf.
  var status = String(entry.status || "ok").trim().toLowerCase() || "ok";
  return {
    id: String(entry.id || ""),
    title: limitTitle(entry.label, window.label, strip),
    fraction: fraction,
    percentText: fraction >= 0 ? Math.round(fraction * 100) + "%" : "—",
    amountText: amountText(amount),
    resetsAt: num(window.resetsAt),
    durationMs: num(window.durationMs),
    status: status,
    statusLabel: statusLabel(status),
    exhausted: status === "exhausted"
  };
}

// Geteilte Kontingente einmal zählen. Ohne `sharedGroup` ist jedes Limit
// für sich; mit `sharedGroup` gewinnt der höchste Füllstand der Gruppe,
// damit ein Rundungsunterschied zwischen den Meldungen nicht nach unten
// verschluckt wird.
function dedupe(limits, strip) {
  var out = [];
  var groups = {};
  for (var i = 0; i < limits.length; i++) {
    var entry = limits[i] || {};
    var scope = entry.scope || {};
    var group = String(scope.sharedGroup || "");
    var normalized = normalizeLimit(entry, strip);
    if (group.length === 0) {
      out.push(normalized);
      continue;
    }
    if (groups[group] === undefined) {
      groups[group] = out.length;
      out.push(normalized);
    } else if (normalized.fraction > out[groups[group]].fraction) {
      out[groups[group]] = normalized;
    }
  }
  return out;
}

// Kurzes Fenster zuerst: das 5-Stunden-Kontingent entscheidet, ob gerade
// gearbeitet werden kann, das Monatskontingent ist Hintergrundwissen.
function byWindow(a, b) {
  var da = isFinite(a.durationMs) ? a.durationMs : Number.MAX_VALUE;
  var db = isFinite(b.durationMs) ? b.durationMs : Number.MAX_VALUE;
  if (da !== db)
    return da - db;
  return a.title.localeCompare(b.title, "en");
}

// Planzeile. Nur `planType` ist eine Planangabe; `orgName` ist bei
// Consumer-Accounts der Name der Person (Anthropic liefert kein planType
// und hätte sonst "Max Mustermann" als Plan angezeigt).
function planLabel(metadata) {
  return String((metadata || {}).planType || "").trim();
}

// Ein Provider ohne `planType` ließe den Slot in der Kopfzeile leer — omp
// meldet den Plan nur für Z.ai ("lite") und OpenAI Codex ("free"). Für die
// übrigen steht hier, was omp über den Zugang tatsächlich weiß. Jede Angabe
// trägt ihr Substantiv, weil ein nacktes "Carsten Bröckert" oder
// "aicode-consumers" im Plan-Slot wie eine Planbezeichnung aussieht.
//
// Nur ein Wert, und nur ohne `planType`: bei OpenAI Codex ist `orgName`
// gleich "free" und damit eine Dopplung des Plans.
function scopeLabel(metadata) {
  var meta = metadata || {};
  if (String(meta.planType || "").trim().length > 0)
    return "";

  var org = String(meta.orgName || "").trim();
  if (org.length > 0)
    return "Org " + org;

  // Google Antigravity identifiziert den Zugang über das Cloud-Projekt.
  var project = String(meta.projectId || "").trim();
  if (project.length > 0)
    return "Projekt " + project;

  // MiniMax meldet weder Plan noch Konto, dafür die freigeschalteten
  // Modellklassen — und in `unavailableModels`, welche davon gerade nicht
  // nutzbar sind. Was übrig bleibt, ist die eigentliche Auskunft.
  var models = availableModels(meta);
  if (models.length > 0)
    return (models.length === 1 ? "Modell " : "Modelle ") + models.join(", ");

  return "";
}

// `models` minus `unavailableModels`, Reihenfolge wie gemeldet.
function availableModels(metadata) {
  var meta = metadata || {};
  var all = meta.models instanceof Array ? meta.models : [];
  var blocked = meta.unavailableModels instanceof Array ? meta.unavailableModels : [];
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var name = String(all[i] || "").trim();
    if (name.length === 0)
      continue;
    var usable = true;
    for (var j = 0; j < blocked.length; j++) {
      if (String(blocked[j] || "").trim() === name) {
        usable = false;
        break;
      }
    }
    if (usable)
      out.push(name);
  }
  return out;
}

function accountLabel(metadata) {
  var meta = metadata || {};
  var email = String(meta.email || "").trim();
  if (email.length > 0)
    return email;
  var id = String(meta.accountId || "").trim();
  return id.length > 0 ? id.slice(0, 8) : "";
}

function normalizeReport(report) {
  var id = String(report.provider || "");
  var known = PROVIDERS[id];
  var strip = known ? known.strip : [];
  var limits = dedupe(report.limits instanceof Array ? report.limits : [], strip);
  limits.sort(byWindow);

  var worst = -1;
  var worstTitle = "";
  var exhausted = false;
  for (var i = 0; i < limits.length; i++) {
    if (limits[i].exhausted)
      exhausted = true;
    if (limits[i].fraction > worst) {
      worst = limits[i].fraction;
      worstTitle = limits[i].title;
    }
  }

  return {
    id: id,
    name: providerName(id),
    plan: planLabel(report.metadata),
    scope: scopeLabel(report.metadata),
    account: accountLabel(report.metadata),
    fetchedAt: num(report.fetchedAt),
    limits: limits,
    worst: worst,
    worstTitle: worstTitle,
    exhausted: exhausted,
    // Prepaid-Provider melden Reset-Guthaben statt eines Fensters.
    resetCredits: report.resetCredits && isFinite(num(report.resetCredits.availableCount))
      ? num(report.resetCredits.availableCount)
      : -1
  };
}

// Ein Konto, das für alle Provider dasselbe ist, gehört einmal in die
// Fußzeile und nicht in jede Abschnittsüberschrift. Bei mehreren Konten
// bleibt es je Provider stehen — dann unterscheidet es sie.
function collapseAccounts(providers) {
  var shared = "";
  var seen = 0;
  for (var i = 0; i < providers.length; i++) {
    // String-Guard: normalizeReport garantiert den String, aber ein
    // direkter Aufrufer mit rohen Reports crashete an .length von undefined.
    var account = String(providers[i].account || "");
    if (account.length === 0)
      continue;
    if (seen === 0) {
      shared = account;
      seen = 1;
    } else if (account !== shared) {
      return "";
    }
  }
  if (seen === 0)
    return "";
  for (var j = 0; j < providers.length; j++)
    providers[j].account = "";
  return shared;
}

// Der Report als Ganzes. `error` ist gesetzt, wenn usage.sh nichts holen
// konnte — das Panel zeigt dann den Fehler statt einer leeren Liste.
function parse(raw) {
  var text = String(raw || "").trim();
  if (text.length === 0)
    return failed("Keine Antwort von omp");

  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return failed("Antwort von omp ist kein JSON");
  }

  // JSON.parse akzeptiert auch Primitive (null, 0, "x", true) und Arrays —
  // ein Report ist aber immer ein Objekt. `null` würde unten bei
  // data.generatedAt als TypeError crashen statt als Fehlerreport zu enden.
  if (data === null || typeof data !== "object" || data instanceof Array)
    return failed("Antwort von omp ist kein JSON-Objekt");

  if (typeof data.error === "string" && data.error.length > 0)
    return failed(data.error);

  var reports = data && data.reports instanceof Array ? data.reports : [];
  var providers = [];
  for (var i = 0; i < reports.length; i++) {
    var normalized = normalizeReport(reports[i] || {});
    if (normalized.limits.length > 0)
      providers.push(normalized);
  }
  // Stabile Reihenfolge: nach Anzeigename. Ein Provider, der gerade nach
  // oben rutscht, weil sein Füllstand steigt, macht das Panel unlesbar.
  // Explizites Locale: ohne das Argument sortiert localeCompare nach der
  // Host-Locale, und dieselbe Providerliste stünde auf jeder Maschine
  // anders — die Reihenfolge hier ist Teil des Vertrags.
  providers.sort(function (a, b) {
    return a.name.localeCompare(b.name, "en");
  });

  var worst = -1;
  var worstProvider = "";
  var worstTitle = "";
  var exhausted = false;
  for (var p = 0; p < providers.length; p++) {
    if (providers[p].exhausted)
      exhausted = true;
    if (providers[p].worst > worst) {
      worst = providers[p].worst;
      worstProvider = providers[p].name;
      worstTitle = providers[p].worstTitle;
    }
  }

  return {
    error: "",
    generatedAt: num(data.generatedAt),
    providers: providers,
    sharedAccount: collapseAccounts(providers),
    worst: worst,
    worstProvider: worstProvider,
    worstTitle: worstTitle,
    exhausted: exhausted,
    withoutUsage: data.accountsWithoutUsage instanceof Array ? data.accountsWithoutUsage.length : 0,
    disabled: data.disabledCredentials instanceof Array ? data.disabledCredentials.length : 0
  };
}

// Ein Fehlerreport hat dieselbe Form wie ein guter, damit das Panel nicht
// gegen fehlende Felder prüfen muss.
function failed(message) {
  return {
    error: message,
    generatedAt: NaN,
    providers: [],
    sharedAccount: "",
    worst: -1,
    worstProvider: "",
    worstTitle: "",
    exhausted: false,
    withoutUsage: 0,
    disabled: 0
  };
}

// "in 4h 52m" bis zum Reset. Kurze Fenster brauchen Minuten, lange nicht.
function untilText(resetsAt, now) {
  var target = num(resetsAt);
  if (!isFinite(target))
    return "";
  var diff = target - (isFinite(num(now)) ? num(now) : Date.now());
  if (diff <= 0)
    return "jetzt";

  var minutes = Math.floor(diff / 60000);
  if (minutes < 1)
    return "< 1m";
  if (minutes < 60)
    return minutes + "m";

  var hours = Math.floor(minutes / 60);
  if (hours < 24) {
    var restMinutes = minutes % 60;
    return restMinutes > 0 ? hours + "h " + restMinutes + "m" : hours + "h";
  }

  var days = Math.floor(hours / 24);
  var restHours = hours % 24;
  return restHours > 0 ? days + "d " + restHours + "h" : days + "d";
}

// "vor 3m" seit dem letzten Abruf.
function agoText(timestamp, now) {
  var then = num(timestamp);
  if (!isFinite(then))
    return "";
  var diff = (isFinite(num(now)) ? num(now) : Date.now()) - then;
  if (diff < 0)
    return "gerade";
  var minutes = Math.floor(diff / 60000);
  if (minutes < 1)
    return "gerade";
  if (minutes < 60)
    return "vor " + minutes + "m";
  var hours = Math.floor(minutes / 60);
  if (hours < 24)
    return "vor " + hours + "h";
  return "vor " + Math.floor(hours / 24) + "d";
}
