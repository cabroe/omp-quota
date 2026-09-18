.pragma library

// Normalisierung des `omp usage --json`-Reports auf eine Form, die das Panel
// direkt rendern kann. Reine Funktionen, keine QML-Abhängigkeiten — damit
// derselbe Code mit `bun Usage.test.js` gegen echte omp-Ausgaben läuft.
//
// Der Rohreport hat drei Eigenheiten, die hier verschwinden:
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
  var n = Number(value);
  return isFinite(n) ? n : NaN;
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

// Eine Zeile im Panel: Titel, Füllstand, Reset-Zeitpunkt.
function normalizeLimit(entry, strip) {
  var amount = entry.amount || {};
  var window = entry.window || {};
  var fraction = usedFraction(amount);
  return {
    id: String(entry.id || ""),
    title: limitTitle(entry.label, window.label, strip),
    fraction: fraction,
    percentText: fraction >= 0 ? Math.round(fraction * 100) + "%" : "—",
    unit: String(amount.unit || ""),
    resetsAt: num(window.resetsAt),
    durationMs: num(window.durationMs),
    // omp markiert ein erschöpftes oder gesperrtes Kontingent über `status`;
    // alles außer "ok" ist eine Ansage, unabhängig vom Füllstand.
    status: String(entry.status || "ok"),
    degraded: String(entry.status || "ok") !== "ok"
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
  return a.title.localeCompare(b.title);
}

// Zwei Werte sagen dasselbe, wenn sie gleich sind — oder wenn einer die
// redigierte Kurzform des anderen ist. `omp --redact` kürzt auf ein
// eindeutiges Präfix mit Stern ("free" -> "fr*"), und ohne diese Prüfung
// stünde im Redaktionsmodus "free · fr*" statt nur "free".
function sameValue(a, b) {
  var left = String(a || "").trim().toLowerCase();
  var right = String(b || "").trim().toLowerCase();
  if (left === right)
    return true;
  if (right.charAt(right.length - 1) === "*" && left.indexOf(right.slice(0, -1)) === 0)
    return true;
  if (left.charAt(left.length - 1) === "*" && right.indexOf(left.slice(0, -1)) === 0)
    return true;
  return false;
}

// Plan- und Kontozeile. `planType` ist die belastbare Angabe; `orgName`
// wiederholt sie bei manchen Providern nur, dann bringt es nichts.
function planLabel(metadata) {
  var meta = metadata || {};
  var plan = String(meta.planType || "").trim();
  var org = String(meta.orgName || "").trim();
  if (plan.length > 0 && org.length > 0 && !sameValue(org, plan))
    return plan + " · " + org;
  if (plan.length > 0)
    return plan;
  if (org.length > 0)
    return org;
  return "";
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
  var degraded = false;
  for (var i = 0; i < limits.length; i++) {
    if (limits[i].degraded)
      degraded = true;
    if (limits[i].fraction > worst) {
      worst = limits[i].fraction;
      worstTitle = limits[i].title;
    }
  }

  return {
    id: id,
    name: providerName(id),
    plan: planLabel(report.metadata),
    account: accountLabel(report.metadata),
    fetchedAt: num(report.fetchedAt),
    limits: limits,
    worst: worst,
    worstTitle: worstTitle,
    degraded: degraded,
    // Prepaid-Provider melden Reset-Guthaben statt eines Fensters.
    resetCredits: report.resetCredits && isFinite(num(report.resetCredits.availableCount))
      ? num(report.resetCredits.availableCount)
      : -1
  };
}

// Der Report als Ganzes. `error` ist gesetzt, wenn usage.sh nichts holen
// konnte — das Panel zeigt dann den Fehler statt einer leeren Liste.
function parse(raw) {
  var text = String(raw || "").trim();
  if (text.length === 0)
    return { error: "Keine Antwort von omp", providers: [], worst: -1, generatedAt: NaN };

  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: "Antwort von omp ist kein JSON", providers: [], worst: -1, generatedAt: NaN };
  }

  if (data && typeof data.error === "string" && data.error.length > 0)
    return { error: data.error, providers: [], worst: -1, generatedAt: NaN };

  var reports = data && data.reports instanceof Array ? data.reports : [];
  var providers = [];
  for (var i = 0; i < reports.length; i++) {
    var normalized = normalizeReport(reports[i] || {});
    if (normalized.limits.length > 0)
      providers.push(normalized);
  }

  // Stabile Reihenfolge: nach Anzeigename. Ein Provider, der gerade nach
  // oben rutscht, weil sein Füllstand steigt, macht das Panel unlesbar.
  providers.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  var worst = -1;
  var worstProvider = "";
  var worstTitle = "";
  for (var p = 0; p < providers.length; p++) {
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
    worst: worst,
    worstProvider: worstProvider,
    worstTitle: worstTitle,
    withoutUsage: data.accountsWithoutUsage instanceof Array ? data.accountsWithoutUsage.length : 0,
    disabled: data.disabledCredentials instanceof Array ? data.disabledCredentials.length : 0
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
