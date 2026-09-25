pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Usage.js" as Usage

// Ein Bar-Widget und ein Popup für die Provider-Kontingente, die der
// omp-Agent verwaltet. Die Bar zeigt das knappste Kontingent über alle
// Provider, das Popup jedes einzelne Fenster mit Füllstand und Reset-Zeit.
//
// Datenquelle ist `usage.sh`, das `omp usage --json` PATH-robust aufruft.
// Für die Verlaufssparklines im Popup holt `usage.sh history` zusätzlich
// omps stündliche Snapshots — beim Öffnen, nicht im Poll. Die komplette
// Normalisierung steckt in Usage.js.
Panel {
  id: root
  moduleName: "cabroe.omp-quota"
  ipcTarget: "cabroe.omp-quota"

  // Tachometer (nf-fa-dashboard). Als Escape statt als literales Zeichen,
  // damit der Codepoint im Diff lesbar bleibt.
  readonly property string glyph: "\uf0e4"

  // ----------------------------------------------------------- Einstellungen
  //
  // Alle drei kommen aus dem shell.json-Eintrag dieses Widgets und lassen
  // sich mit `omarchy bar set cabroe.omp-quota <key> <value> --json` ändern.
  //
  // Bewusst direkt auf `settings` statt über die geerbte setting()-Funktion:
  // deren Property-Zugriff liegt in Ui/Panel.qml, also registriert ein
  // Binding hier keine Abhängigkeit auf `settings` und behält nach der
  // Injektion durch den Bar-Host seinen Startwert. Direkter Zugriff macht
  // die Bindings reaktiv — so lesen die First-Party-Panels ihre Werte auch.
  //
  // Die Klemmen selbst stehen in Usage.js: als Inline-Ausdruck hier waren
  // sie von keinem Test erreichbar.
  readonly property int refreshIntervalSec:
    Usage.refreshInterval(settings ? settings.refreshIntervalSec : undefined, 300)
  readonly property real alarmAt:
    Usage.alarmFraction(settings ? settings.alarmThreshold : undefined, 90)
  readonly property bool redact: settings ? settings.redact === true : false

  // ------------------------------------------------------------------ Daten
  property var report: Usage.failed("")
  property bool loading: false
  property bool loadedOnce: false
  // Ein Abruf läuft und hat noch nichts geliefert. Trennt "wird geladen" von
  // "ist stillschweigend gescheitert" — und entscheidet, ob eine Antwort
  // überhaupt noch erwartet wird.
  property bool pending: false
  // Fehler des letzten Abrufs, getrennt vom Report: so bleiben die Zahlen
  // der letzten erfolgreichen Messung sichtbar, während der Fehler daneben
  // steht. Ein veralteter Stand ist brauchbar, eine leere Liste nicht.
  property string fetchError: ""
  // Eigene Uhr statt Date.now() in Bindings: die Reset-Countdowns müssen
  // sich bewegen, und eine Funktion allein löst keine Neuauswertung aus.
  property double nowMs: Date.now()

  // Eine Anfrage, die während eines laufenden Abrufs kommt, wird gemerkt und
  // danach ausgeführt. Sie fallen zu lassen heißt: Rechtsklick, `R` und ein
  // Wechsel der Redaktion sind im Abrufzeitfenster wirkungslos, ohne dass
  // irgendwas davon sichtbar wird.
  property bool queuedRefresh: false
  property bool queuedFresh: false
  // Mit welcher Redaktionseinstellung der laufende Abruf gestartet wurde.
  // Die Redaktion passiert in omp, also entscheidet der Aufruf, nicht die
  // Anzeige — ein Report von vorher zeigt genau die Konten, die gerade
  // verborgen werden sollen.
  property bool requestRedact: false

  // Verlaufssnapshots je Fenster (limitId -> aufsteigende Füllstände),
  // Grundlage der Sparklines. Bewusst kein Bestandteil des Live-Polls:
  // die Aufzeichnung ist stündlich, der Poll minütlich — dasselbe Bild
  // dutzendfach aus omp zu lesen, wäre reiner Prozess-Müll. Fehlgeschlage-
  // ne Verläufe sind still: die Sparkline ist eine Zutat, kein Vertrag —
  // der letzte gute Stand bleibt, die Fehlerkarte gehört dem Live-Abruf.
  property var historySeries: ({})
  property bool historyPending: false

  // Balkenzahl der Sparkline. 26 Balken auf ~370 px Inhalt: jeder knapp
  // 2 px breit — dick genug, um eine Spitze zu lesen, fein genug für die
  // Stundenauflösung von 7 Tagen.
  readonly property int sparkBars: 26

  // Analyse-Ansicht (`usage.sh stats` → omp stats, letzte 24 h). Gleiche
  // Verantwortungsteilung wie der Verlauf: eigener Prozess, eigener
  // Watchdog, Fetch beim Öffnen, Fehler still — die Statistik ist eine
  // eigene Ansicht, kein Ersatz für die Kontingente. `activeView`
  // überlebt das Schließen: der Umschalter ist eine Lesebrille, kein Reset.
  property var statsData: null
  property bool statsPending: false
  // 0 = Kontingente, 1 = Verbrauch (Verlauf je Fenster), 2 = Analyse
  // (Session-Statistik).
  property int activeView: 0

  readonly property string errorText: fetchError !== "" ? fetchError : String(report.error || "")
  readonly property bool hasError: errorText !== ""
  readonly property real worst: Number(report.worst)
  readonly property bool exhausted: report.exhausted === true
  readonly property bool alarming: worst >= alarmAt || exhausted
  readonly property string collector: decodeURIComponent(String(Qt.resolvedUrl("usage.sh")).replace(/^file:\/\//, ""))

  // Über den Index statt über das Array iterieren: `report` wird bei jedem
  // Abruf komplett ersetzt, und ein neues Array zerstört jeden Repeater-
  // Delegate. Ein neu gebautes Meter animiert nicht (Behavior greift beim
  // Initialwert nicht) und die Liste baut sich bei jedem Poll neu auf.
  // Index-Identität ist hier tragfähig, weil die Reihenfolge deterministisch
  // und ausdrücklich nicht füllstandsabhängig ist.
  readonly property var providers: report.providers instanceof Array ? report.providers : []
  readonly property int providerCount: providers.length

  function providerAt(index) {
    var list = root.providers
    return index >= 0 && index < list.length ? list[index] : null
  }

  // Version aus manifest.json statt als Literal im QML: zwei Stellen, die
  // dieselbe Zahl behaupten, laufen beim nächsten Release auseinander, und
  // das Manifest ist die Quelle, die Omarchy selbst liest. Leer, solange
  // die Datei nicht geladen ist — die Fußzeile blendet die Zeile dann aus.
  property string pluginVersion: ""

  FileView {
    path: decodeURIComponent(String(Qt.resolvedUrl("manifest.json")).replace(/^file:\/\//, ""))
    watchChanges: false
    printErrors: false
    onLoaded: {
      // Ein kaputtes Manifest darf das Widget nicht mitnehmen: die Version
      // ist Beiwerk, die Kontingente sind der Zweck.
      try {
        root.pluginVersion = String(JSON.parse(text()).version || "")
      } catch (e) {
        root.pluginVersion = ""
      }
    }
  }

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color track: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  // Zugangsangabe in der Provider-Kopfzeile: nachrangig gegenüber dem
  // Namen, aber keine Fußnote — deshalb gedämpft statt `dim`.
  readonly property real metaOpacity: 0.75
  // Basisfarbe eines noch leeren Balkens. `accent` statt `foreground`: der
  // Balken ist eine Fläche, kein Text, und soll sich von der Beschriftung
  // absetzen. Themes ohne eigenen Akzent setzen accent gleich foreground —
  // dann verhält sich die Rampe wie vorher, nur ohne Sprung.
  //
  // Direkt über `Color`, nicht über `bar`: die Plugin-Bar-API
  // (Ui/PluginBarApi.qml) führt foreground, barForeground, background und
  // urgent — kein accent. Ein `bar.accent`-Zweig wäre immer undefined und
  // damit toter Code. `Color.accent` wird beim Themewechsel neu zugewiesen,
  // das Binding bleibt also reaktiv.
  readonly property color calm: Color.accent

  // Mischt zwei Farben linear. Qt.tint() kann das nicht: es rechnet über
  // Alpha-Komposition, und ein Faktor unter 1 ergäbe eine halbdurchsichtige
  // Farbe statt einer Zwischenfarbe.
  function mix(from, to, t) {
    var k = t < 0 ? 0 : (t > 1 ? 1 : t)
    return Qt.rgba(
      from.r + (to.r - from.r) * k,
      from.g + (to.g - from.g) * k,
      from.b + (to.b - from.b) * k,
      1)
  }

  readonly property string barLabel:
    Usage.barText(glyph, worst, hasError, bar && bar.vertical === true)
  readonly property string barTooltip:
    Usage.barTooltip(report, errorText, nowMs)

  // Jeder Balken ist eingefärbt, nicht erst der knappe: die Farbe wandert
  // mit dem Füllstand von `calm` nach `urgent` und erreicht `urgent` genau
  // bei `alarmAt`. Die Kurve selbst steckt in `Usage.rampFactor()` — nur
  // das Mischen zweier Farben braucht QML.
  //
  // Erschöpft ist immer Alarm, unabhängig vom Füllstand — `fraction` ist auf
  // 1 gedeckelt, ein überzogenes Kontingent sähe sonst aus wie ein gerade
  // eben volles. Unbegrenzte Fenster (`fraction < 0`) bleiben ruhig.
  // `base` ist die Farbe bei leerem Kontingent: Flächen starten bei `calm`,
  // Text bei `foreground` — ein grau angelaufener Prozentwert wäre bei 3 %
  // schlechter lesbar, ohne etwas auszusagen.
  function colorFor(fraction, exhausted, base) {
    var from = base === undefined ? root.calm : base
    if (exhausted === true)
      return root.urgent
    return root.mix(from, root.urgent, Usage.rampFactor(fraction, root.alarmAt))
  }

  // `fresh` verwirft zuerst omps Report-Cache, damit die Provider-APIs
  // wirklich neu befragt werden. Ohne das liefert ein Refresh innerhalb des
  // Cache-Fensters dieselben Zahlen zurück.
  function refresh(fresh) {
    if (usageProcess.running) {
      root.queuedRefresh = true
      // `fresh` gewinnt: ein Rechtsklick darf nicht zum normalen Abruf
      // degradieren, nur weil gerade gepollt wurde.
      root.queuedFresh = root.queuedFresh || fresh === true
      return
    }
    // Der Aufruf läuft über /bin/bash statt über das Skript selbst. Damit
    // fällt das Ausführungsbit als Fehlerquelle weg, und der Host macht es
    // an jeder vergleichbaren Stelle genauso.
    var args = ["/bin/bash", root.collector]
    if (root.redact)
      args.push("--redact")
    if (fresh === true)
      args.push("--fresh")
    root.requestRedact = root.redact
    usageProcess.command = args
    root.loading = true
    root.pending = true
    watchdog.restart()
    usageProcess.running = true
  }

  // Alle drei Abrufe (Live + Geschichte + Statistik) — nur für explizite
  // Nutzerhandlungen (r / R / Mittelklick / Rechtsklick / Enter). Die Guards
  // in refreshHistory/refreshStats machen sie beim Schließen zum No-Op, ohne
  // dass hier ein `opened`-Check nötig wäre. Der Poll und onRedactChanged
  // nutzen weiterhin nur refresh(), um stündliche DB-Lese nicht zu häufen.
  function refreshAll(fresh) {
    root.refresh(fresh)
    if (root.opened) {
      refreshHistory()
      refreshStats()
    }
  }

  // Die gemerkte Anfrage nachziehen, sobald der Prozess wirklich beendet ist.
  function drainQueue() {
    if (!root.queuedRefresh)
      return
    root.queuedRefresh = false
    var fresh = root.queuedFresh
    root.queuedFresh = false
    root.refresh(fresh)
  }

  function applyReport(raw) {
    // Niemand wartet mehr auf diese Antwort: der Watchdog hat den Abruf
    // abgeschrieben und den Prozess abgeschossen. Was jetzt noch aus der
    // Pipe fällt, ist ein Fragment und darf seine Meldung nicht ersetzen.
    if (!root.pending)
      return

    root.pending = false
    root.loading = false
    watchdog.stop()

    // Zwischen Start und Antwort hat der Bar-Host `redact` gesetzt. Dieser
    // Report zeigt dann die Konten, die verborgen werden sollen — also
    // verwerfen und mit der aktuellen Einstellung neu holen. Die Queue wird
    // dabei geleert: onRedactChanged hat genau diesen Nachzug längst als
    // Anfrage gemerkt, und ihr Eintrag würde nach dem nächsten Prozessende
    // noch einen zweiten, redundanten Abruf mit derselben Einstellung
    // auslösen. Eine dabei gemerkte --fresh-Anfrage wandert in den
    // Ersatzabruf — sonst degradierte der erzwungene "Cache leeren"-
    // Rechtsklick still zum gecachten Poll.
    if (root.requestRedact !== root.redact) {
      var fresh = root.queuedFresh
      root.queuedRefresh = false
      root.queuedFresh = false
      // Nur den Live-Abruf neu starten: dieser Pfad entsteht aus einem
      // Poll, der vor der Redaktionsumstellung gestartet wurde, und ein
      // Geschichte- oder Statistik-Refresh wäre hier unnötiger DB-Lese-
      // Aufwand. refreshAll ist für explizite Nutzerhandlungen reserviert.
      root.refresh(fresh)
      return
    }

    var parsed = Usage.parse(raw)
    // Ein Fehlerobjekt hat keine Provider — die letzte gute Messung wird
    // dann nicht überschrieben, sondern behalten und der Fehler daneben
    // gezeigt.
    if (String(parsed.error || "") !== "") {
      root.fetchError = parsed.error
      if (!root.loadedOnce)
        root.report = parsed
      return
    }
    root.fetchError = ""
    root.report = parsed
    root.nowMs = Date.now()
    root.loadedOnce = true
  }

  // Ein Abruf, der nichts geliefert hat, muss das sagen statt für immer
  // "wird geladen" anzuzeigen. Quickshell feuert kein onExited, wenn das
  // Programm gar nicht startet — dort fällt nur `running` zurück. Deshalb
  // wird der Übergang ausgewertet und nicht das Prozessende.
  function failFetch(message) {
    if (!root.pending)
      return
    root.pending = false
    root.loading = false
    watchdog.stop()
    root.fetchError = message
    if (!root.loadedOnce)
      root.report = Usage.failed(message)
  }

  // Verlaufsreihe eines Fensters, leer wenn unbekannt. Der Zugriff über
  // die Funktion statt direkt aufs Objekt hält den Guard an einer Stelle.
  function historyFor(limitId) {
    var key = String(limitId || "")
    var series = root.historySeries
    return series && series[key] instanceof Array ? series[key] : []
  }

  function refreshHistory() {
    if (historyProcess.running || !root.opened)
      return
    var args = ["/bin/bash", root.collector, "history"]
    if (root.redact)
      args.push("--redact")
    root.historyPending = true
    historyWatchdog.restart()
    historyProcess.command = args
    historyProcess.running = true
  }

  function applyHistory(raw) {
    // Der Watchdog hat abgeschrieben: Spätes aus der Pipe darf nicht in
    // einen Zustand schreiben, den niemand mehr erwartet (gleiche Regel
    // wie applyReport — nur ohne Fehlerkarte, siehe oben).
    if (!root.historyPending)
      return
    root.historyPending = false
    historyWatchdog.stop()
    var parsed = Usage.parseHistory(raw)
    if (String(parsed.error || "") !== "")
      return
    root.historySeries = parsed.series
  }

  function refreshStats() {
    if (statsProcess.running || !root.opened)
      return
    root.statsPending = true
    statsWatchdog.restart()
    statsProcess.command = ["/bin/bash", root.collector, "stats"]
    statsProcess.running = true
  }

  function applyStats(raw) {
    // Gleiche Guard-Regel wie applyHistory: nach dem Watchdog kommt nichts
    // mehr in einen Zustand, den niemand erwartet.
    if (!root.statsPending)
      return
    root.statsPending = false
    statsWatchdog.stop()
    var parsed = Usage.parseStats(raw)
    if (parsed.stats === null)
      return
    root.statsData = parsed.stats
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Der erste Abruf läuft sofort. Der Bar-Host injiziert `settings` erst
  // nach der Instanziierung, aber das braucht keinen geratenen Timer mehr:
  // schaltet die Injektion `redact` ein, verwirft applyReport() den
  // unredigierten Report und holt mit der neuen Einstellung nach.
  Component.onCompleted: root.refresh(false)

  // Die Redaktion passiert in omp, nicht hier. Ein Wechsel der Einstellung
  // muss darum neu abrufen — ohne loadedOnce-Guard, denn genau der hätte
  // die Injektion beim Start ausgesperrt.
  onRedactChanged: root.refresh(false)

  // Beim Öffnen zeigt das Panel echte Zahlen, nicht den Stand von vorhin.
  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      flick.contentY = 0
      refresh(false)
      // Verlauf nur im Öffnen: er ist stündlich, der frischeste Stand vor
      // dem letzten Öffnen reicht dafür. Ein laufender Verlaufsabruf wird
      // nicht doppelt gestartet (refreshHistory guardt selbst).
      refreshHistory()
      // Dasselbe für die Statistik — der Umschalter soll sofort etwas
      // zeigen, wenn er benutzt wird.
      refreshStats()
    }
  }

  Process {
    id: usageProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyReport(text)
    }
    // Läuft nicht mehr, hat aber nichts geliefert: Skript fehlt, /bin/bash
    // fehlt oder der Prozess wurde abgeschossen. usage.sh selbst meldet
    // seine eigenen Fehler als JSON, die sind hier längst verarbeitet.
    //
    // Synchron, nicht über Qt.callLater: gemessen mit Quickshell 0.3.1
    // feuert onStreamFinished immer VOR onRunningChanged — im Normalfall,
    // beim SIGKILL mit Teilausgabe (die Teildaten kommen noch an) und
    // beim gar nicht startenden Prozess (dort feuert nur onRunningChanged,
    // was genau der Fall ist, für den failFetch existiert). applyReport
    // hat also längst pending=false gesetzt, wenn es etwas zu melden gab.
    // Ein deferriertes failFetch wäre sogar schädlich: drainQueue() startet
    // hier synchron den nächsten Abruf und setzt pending wieder auf true —
    // das verspätete failFetch würde dann DESSEN Zustand abreißen und
    // seinen Watchdog stoppen.
    onRunningChanged: {
      if (running)
        return
      root.failFetch("Abruf lieferte keine Ausgabe — usage.sh oder /bin/bash fehlt")
      root.drainQueue()
    }
  }

  // Verlaufsabruf: gleiche Architektur wie usageProcess, aber eigenständig
  // — der Live-Poll darf von einem hängenden Verlauf nicht blockiert wer-
  // den und umgekehrt. Fehler werden still verworfen (Zutat, kein Vertrag).
  Process {
    id: historyProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyHistory(text)
    }
    onRunningChanged: {
      if (running)
        return
      // Nichts geliefert (Skript fehlt, abgeschossen): den offenen Abruf
      // schließen, damit das nächste Öffnen nicht für immer blockiert.
      if (root.historyPending) {
        root.historyPending = false
        historyWatchdog.stop()
      }
    }
  }

  // Derselbe Hänger-Fall wie beim Live-Watchdog: running = false allein
  // reicht nicht (bash deferiert SIGTERM beim Vordergrund-Kind), deshalb
  // zusätzlich das SIGKILL an bash — den alleinigen Halter der Pipe.
  Timer {
    id: historyWatchdog
    interval: 25000
    repeat: false
    onTriggered: {
      root.historyPending = false
      historyProcess.running = false
      historyProcess.signal(9)
    }
  }

  // Statistik-Abruf: drittes Exemplar desselben Musters. Eigenständig vom
  // Live-Poll und vom Verlauf — ein Hänger in einer Quelle darf die
  // anderen zwei nicht blockieren.
  Process {
    id: statsProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStats(text)
    }
    onRunningChanged: {
      if (running)
        return
      if (root.statsPending) {
        root.statsPending = false
        statsWatchdog.stop()
      }
    }
  }

  Timer {
    id: statsWatchdog
    interval: 25000
    repeat: false
    onTriggered: {
      root.statsPending = false
      statsProcess.running = false
      statsProcess.signal(9)
    }
  }

  // Deckt den Fall ab, den kein Signal meldet: ein Abruf, der hängt. Die
  // Frist liegt über dem Limit in usage.sh (20 s), damit im Normalfall das
  // Skript zuerst aufgibt und seinen genaueren Fehler melden kann.
  Timer {
    id: watchdog
    interval: 25000
    repeat: false
    onTriggered: {
      // Erst die Meldung, dann der Kill: der Kill läuft über
      // onRunningChanged, und failFetch() dort würde diese präzise Meldung
      // sonst durch die generische ersetzen.
      root.failFetch("omp hat nach 25 s nicht geantwortet")
      // Ohne den Kill blockiert der Hänger jeden weiteren Abruf für immer,
      // weil refresh() bei laufendem Prozess nur noch in die Queue schreibt.
      // running = false allein reicht NICHT: Quickshell setzt es in
      // QProcess::terminate() um — SIGTERM an bash — und `running` bleibt
      // true, bis finished feuert. bash deferiert ein SIGTERM aber, solange
      // ein Vordergrund-Kind läuft (empirisch verifiziert), und timeout
      // wartet ohne -k endlos auf ein TERM-ignorierendes Kind. Das SIGKILL
      // trifft bash direkt; nur bash hält die stdout-Pipe, also feuert
      // finished garantiert und die Queue zieht nach. signal() guardt selbst
      // gegen einen bereits toten Prozess.
      usageProcess.running = false
      usageProcess.signal(9)
    }
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh(false)
  }

  // Die Uhr für die Countdowns tickt, während jemand hinsieht — und im
  // Fehlerfall, weil dann der Tooltip die Alterung des letzten Abrufs
  // nennt. `WidgetButton` liest `tooltipText` genau einmal, bei
  // `onEntered`, und ein Binding auf `nowMs` liefert dort den zuletzt
  // gesetzten Wert: ohne diesen zweiten Fall zeigte der Tooltip die
  // Alterung so an, wie sie beim letzten Öffnen des Popups war. Bewusst
  // über den Zustand statt über ein Hover-Signal — das hinge an der
  // Reihenfolge von `containsMouse` und `entered()` innerhalb von Qt.
  // Sonst tickt hier nichts, was ohnehin niemand liest.
  Timer {
    interval: 30000
    repeat: true
    running: root.opened || root.hasError
    onTriggered: root.nowMs = Date.now()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barLabel
    active: root.alarming || root.hasError
    tooltipText: root.barTooltip

    onPressed: function (code) {
      if (code === Qt.RightButton)
        root.refreshAll(true)
      else if (code === Qt.MiddleButton)
        root.refreshAll(false)
      else if (root.opened)
        root.close()
      else
        root.open()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onCloseRequested: root.close()
      onTabRequested: function (direction) {
        root.switchPanel(direction)
      }
      onMoveRequested: function (dx, dy) {
        if (dy !== 0)
          flick.scrollBy(dy)
      }
      onActivateRequested: root.refreshAll(false)
      onTextKey: function (t) {
        if (t === "r")
          root.refreshAll(false)
        else if (t === "R" || t === "f")
          root.refreshAll(true)
        else if (t === "v")
          root.activeView = (root.activeView + 1) % 3
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        function scrollBy(direction) {
          var step = Style.space(48) * direction
          var max = Math.max(0, contentHeight - height)
          contentY = Math.max(0, Math.min(max, contentY + step))
        }

        Column {
          id: content
          width: flick.width
          spacing: Style.space(12)

          PanelHero {
            // Der Hero trägt den Namen des Widgets, nicht den der Ansicht —
            // "Kontingente" ist der erste Tab darunter und stünde sonst
            // doppelt auf dem Schirm.
            title: "omp-quota"
            // Die Zahl bleibt stehen, solange es eine gibt — ein
            // fehlgeschlagener Abruf macht die letzte Messung nicht falsch,
            // nur alt. Das sagt die Fehlerkarte darunter.
            detail: isFinite(root.worst) && root.worst >= 0 ? Math.round(root.worst * 100) + "%" : ""
            meta: {
              if (root.exhausted)
                return "Kontingent erschöpft"
              if (isFinite(root.worst) && root.worst >= 0)
                return root.report.worstProvider + " · " + root.report.worstTitle
              if (root.hasError)
                return "omp nicht erreichbar"
              if (root.loading)
                return "wird geladen"
              return "keine Kontingente gemeldet"
            }
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: root.glyph
                // Fehler schlägt alles; sonst trägt das Glyph dieselbe
                // Stufe wie das knappste Kontingent.
                color: root.hasError ? root.urgent : root.colorFor(root.worst, root.exhausted, root.foreground)
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
          }

          // Umschalter zwischen Kontingente, Verbrauch und Analyse. Die
          // Datensätze liegen beim Öffnen bereits vor — der Wechsel ist
          // rein lokal, kein Abruf. Bleibt stehen, wenn der Live-Abruf
          // fehlschlägt: die Fehlerkarte gehört zur Kontingent-Ansicht.
          Row {
            width: parent.width
            spacing: Style.space(14)

            ViewTab { view: 0 }
            ViewTab { view: 1 }
            ViewTab { view: 2 }
          }

          // Fehlerkarte. Steht auch dann da, wenn darunter noch Zahlen aus
          // dem letzten guten Abruf stehen — sonst hielte man einen alten
          // Stand für den aktuellen.
          BorderSurface {
            width: parent.width
            visible: root.hasError
            implicitHeight: errorLabel.implicitHeight + Style.space(20)
            color: "transparent"
            radius: Style.cornerRadius
            borderSpec: Border.controlSpec("normal", root.urgent, Color.accent)

            Text {
              id: errorLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: root.errorText
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          // Die Trennlinie gehört zur Ansicht, nicht zum Block: In allen
          // drei Ansichten steht sie direkt unter Tabs bzw. Fehlerkarte,
          // und der Abstand zur folgenden Überschrift ist überall derselbe
          // — content-spacing 12 plus topPadding 12 des Blocks darunter.
          // In der Kontingent-Ansicht nur mit Providern: ohne bliebe die
          // Linie das Letzte im Popup.
          PanelSeparator {
            foreground: root.foreground
            visible: root.activeView !== 0 || root.providerCount > 0
          }

          // Abgeleitete Hinweise (Usage.tips()): Engpass, bevorstehender
          // Reset, Spitzen-Vorlauf, Kostentreiber, freie Kapazität — alles
          // aus den drei ohnehin geholten Quellen, höchstens drei Zeilen,
          // Dringlichkeit zuerst. Verschwindet vollständig, wenn gerade
          // kein Hinweis zutrifft. Dieselbe Rhythmik wie die anderen
          // Ansichtsblöcke (topPadding 12 / spacing 8 / bottomPadding 8);
          // die Trennlinie darüber liegt auf Ansichtsebene.
          Column {
            id: tipsView
            width: parent.width
            visible: root.activeView === 0 && tipsView.tipCount > 0
            spacing: Style.space(8)
            topPadding: Style.space(12)
            bottomPadding: Style.space(8)

            readonly property var entries: Usage.tips(
              root.report, root.historySeries, root.statsData, root.alarmAt, root.nowMs)
            readonly property int tipCount: entries.length

            function tipAt(position) {
              var list = tipsView.entries
              return position >= 0 && position < list.length ? list[position] : null
            }

            Row {
              width: parent.width

              PanelSectionHeader {
                id: tipsTitle
                text: "Tipps"
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.body
                color: root.foreground
              }

              Item {
                width: Math.max(0, parent.width - tipsTitle.implicitWidth - tipsMeta.width)
                height: 1
              }

              PanelSectionHeader {
                id: tipsMeta
                text: "Kontingente · Verlauf · Kosten"
                foreground: root.foreground
                fontFamily: root.fontFamily
                font.bold: false
                opacity: root.metaOpacity
                elide: Text.ElideRight
                width: Math.min(implicitWidth, parent.width * 0.6)
              }
            }

            // Repeater über den Zähler, nicht über das Array — dieselbe
            // Regel wie bei den Providern: entries wird bei jedem Abruf
            // ersetzt, Delegates an Index-Identität zu binden hält den
            // Block stabil. Nur Text, kein Meter — hier gibt es nichts zu
            // animieren.
            Repeater {
              model: tipsView.tipCount

              delegate: Text {
                required property int index
                width: tipsView.width
                textFormat: Text.PlainText
                text: tipsView.tipAt(index) ? tipsView.tipAt(index).text : ""
                // Nur der Engpass trägt Alarmfarbe — Farbe überall hieße,
                // alles sei gleichermaßen dringend, und dann wäre es nichts.
                color: tipsView.tipAt(index) && tipsView.tipAt(index).alarm === true
                       ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }
            }
          }

          Repeater {
            model: root.providerCount

            delegate: ProviderSection {
              required property int index
              width: content.width
              provider: root.providerAt(index)
              // Die Komponente definiert sichtbar an provider !== null —
              // hier kommt der Ansichts-Wechsel dazu.
              visible: root.activeView === 0 && provider !== null
            }
          }

          // Analyse-Ansicht: Gesamtblock und Modelle nach Kosten. Pur
          // als Textzeilen — keine Meter, es gibt keinen Füllstand, den
          // eine Rampe deuten könnte. Kosten in Vordergrundfarbe, Abo-
          // Modelle (0 $) im Grau. Dasselbe Design wie die Kontingent-
          // Abschnitte: Kopfzeile (Titel links, Meta rechts) und dieselbe
          // Rhythmik (topPadding 12 / innen 8 / bottom 8) — die Trenn-
          // linie darüber liegt auf Ansichtsebene.
          Column {
            id: statsView
            width: parent.width
            visible: root.activeView === 2
            spacing: Style.space(8)
            topPadding: Style.space(12)
            bottomPadding: Style.space(8)

            readonly property var stats: root.statsData
            readonly property int modelCount: stats && stats.models instanceof Array ? stats.models.length : 0


            Row {
              width: parent.width

              PanelSectionHeader {
                id: statsTitle
                text: "Analyse"
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.body
                color: root.foreground
              }

              Item {
                width: Math.max(0, parent.width - statsTitle.implicitWidth - statsMeta.width)
                height: 1
              }

              PanelSectionHeader {
                id: statsMeta
                text: "letzte 24 Stunden · Sessionstatistik"
                foreground: root.foreground
                fontFamily: root.fontFamily
                font.bold: false
                opacity: root.metaOpacity
                elide: Text.ElideRight
                width: Math.min(implicitWidth, parent.width * 0.6)
              }
            }

            Text {
              width: parent.width
              visible: statsView.stats === null
              textFormat: Text.PlainText
              text: root.statsPending ? "wird geladen" : "keine Statistikdaten"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width
              visible: statsView.stats !== null
              textFormat: Text.PlainText
              text: {
                var s = statsView.stats
                if (!s)
                  return ""
                var parts = []
                parts.push(Usage.compact(s.requests) + " Anfragen")
                if (s.errors > 0)
                  parts.push(s.errors + " Fehler")
                var tokens = s.inputTokens + s.outputTokens
                if (isFinite(tokens) && tokens > 0)
                  parts.push(Usage.compact(tokens) + " Tokens")
                if (isFinite(s.cacheRate) && s.cacheRate > 0) {
                  // Cache-Rate und Ersparnis zusammen: die Rate allein sagt
                  // nicht, wie viel der Prompt-Input nicht voll bezahlt wurde.
                  var cache = Math.round(s.cacheRate * 100) + "% Cache"
                  if (isFinite(s.cacheSavings) && s.cacheSavings > 0)
                    cache += " (spart " + Math.round(s.cacheSavings * 100) + "%)"
                  parts.push(cache)
                }
                if (isFinite(s.tokensPerSecond) && s.tokensPerSecond > 0)
                  parts.push("Ø " + Math.round(s.tokensPerSecond) + " Tok/s")
                return parts.join("  ·  ")
              }
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Text {
              width: parent.width
              visible: statsView.stats !== null && isFinite(statsView.stats.cost)
              textFormat: Text.PlainText
              text: "Kosten 24h: " + Usage.formatMoney(statsView.stats ? statsView.stats.cost : NaN)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            // Modelle: Name mit Provider links, Last und Kosten rechts,
            // darunter der Kosten-Anteil als Meter. Der Anteil ist keine
            // Alarmskala — ein teures Modell ist keine Warnung —, deshalb
            // bleibt die Füllung durchgehend calm. Unbepreiste Modelle
            // (Anteil 0) zeigen ein ehrliches "Abo" und keinen Meter.
            Repeater {
              model: statsView.modelCount

              delegate: Column {
                id: modelRow
                required property int index
                width: statsView.width

                readonly property var entry: statsView.stats.models[index]
                readonly property bool priced: isFinite(modelRow.entry.cost) && modelRow.entry.cost > 0

                Row {
                  width: parent.width

                  // Drei benannte Maße, alle aus GEKAPPTEN Breiten: der
                  // Provider-Slot hängt nur an der Zeilenbreite (kein
                  // Zirkel), der Name bekommt den Rest, der Spacer zieht
                  // exakt dieselben Werte ab. Vorher rechnete `lead` mit
                  // `modelName.implicitWidth` — sobald der Name gekappt
                  // wurde, war der Spacer 0 und Last/Kosten liefen über
                  // die rechte Popup-Kante hinaus. Dieselbe Regel wie in
                  // LimitRow: kappen und rechnen mit demselben Maß.
                  readonly property real providerSlot: modelProvider.visible ? modelProvider.width + modelProvider.leftPadding : 0
                  readonly property real tail: modelReqs.implicitWidth + modelCost.implicitWidth

                  Text {
                    id: modelName
                    textFormat: Text.PlainText
                    text: modelRow.entry.name
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, Math.max(0, parent.width - parent.tail - parent.providerSlot - Style.space(12)))
                  }

                  Text {
                    id: modelProvider
                    visible: text.length > 0 && modelRow.entry.providerName !== modelRow.entry.name
                    textFormat: Text.PlainText
                    text: modelRow.entry.providerName
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    leftPadding: Style.space(8)
                    elide: Text.ElideRight
                    // Nach dem Namen, aber nie über die rechte Seite:
                    // auf 30 % der Zeile gedeckelt.
                    width: Math.min(implicitWidth, parent.width * 0.3)
                    anchors.baseline: modelName.baseline
                  }

                  Item {
                    width: Math.max(0, parent.width - modelName.width - parent.providerSlot - parent.tail)
                    height: 1
                  }

                  Text {
                    id: modelReqs
                    textFormat: Text.PlainText
                    text: Usage.compact(modelRow.entry.requests)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    rightPadding: text !== "" ? Style.space(8) : 0
                    anchors.baseline: modelName.baseline
                  }

                  Text {
                    id: modelCost
                    textFormat: Text.PlainText
                    text: modelRow.priced ? Usage.formatMoney(modelRow.entry.cost) : "Abo"
                    color: modelRow.priced ? root.foreground : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.baseline: modelName.baseline
                  }
                }

                Item {
                  width: parent.width
                  visible: modelRow.entry.share > 0
                  implicitHeight: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

                  Rectangle {
                    id: shareTrack
                    anchors.fill: parent
                    radius: height / 2
                    color: root.track
                  }

                  Rectangle {
                    anchors.left: shareTrack.left
                    anchors.verticalCenter: shareTrack.verticalCenter
                    height: shareTrack.height
                    radius: shareTrack.radius
                    width: shareTrack.width * Math.max(0, Math.min(1, modelRow.entry.share))
                    color: root.calm

                    Behavior on width {
                      NumberAnimation {
                        duration: 160
                        easing.type: Easing.OutCubic
                      }
                    }
                  }
                }
              }
            }

          }

          // Verbrauchs-Ansicht: die drei meist verbrauchten Provider, je
          // einer mit vergrößerter Sparkline und Kennzahlen (Ø, Spitze,
          // Anzahl Stundenwerte). Das Ranking liefert topConsumers() — je
          // Provider sein schlimmstes Fenster, nie ein Provider doppelt.
          // Dasselbe Design wie die Kontingent-Abschnitte: Kopfzeile
          // (Titel links, Meta rechts) und dieselbe Rhythmik (topPadding
          // 12 / innen 8 / bottom 8) — die Trennlinie darüber liegt auf
          // Ansichtsebene.
          Column {
            id: historyView
            width: parent.width
            visible: root.activeView === 1
            spacing: Style.space(8)
            topPadding: Style.space(12)
            bottomPadding: Style.space(8)

            readonly property int topCount: 3
            readonly property var entries: Usage.topConsumers(root.providers, root.historySeries, historyView.topCount)
            readonly property int entryCount: entries.length

            function entryAt(position) {
              var list = historyView.entries
              return position >= 0 && position < list.length ? list[position] : null
            }


            Row {
              width: parent.width

              PanelSectionHeader {
                id: historyTitle
                text: "Verbrauch"
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.body
                color: root.foreground
              }

              Item {
                width: Math.max(0, parent.width - historyTitle.implicitWidth - historyMeta.width)
                height: 1
              }

              PanelSectionHeader {
                id: historyMeta
                text: "letzte 7 Tage · Stundenwerte"
                foreground: root.foreground
                fontFamily: root.fontFamily
                font.bold: false
                opacity: root.metaOpacity
                elide: Text.ElideRight
                width: Math.min(implicitWidth, parent.width * 0.6)
              }
            }

            Text {
              width: parent.width
              visible: historyView.entryCount === 0
              textFormat: Text.PlainText
              text: root.historyPending ? "wird geladen" : "keine Verlaufsdaten"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Repeater {
              model: historyView.entryCount

              delegate: HistoryRow {
                required property int index
                width: historyView.width
                provider: historyView.entryAt(index) ? historyView.entryAt(index).provider : null
                limit: historyView.entryAt(index) ? historyView.entryAt(index).limit : null
              }
            }
          }

          // Zustand und Tastenkürzel in getrennten Zeilen, beide umbrechend.
          // Als eine Zeile mit `elide` fiel der Hinweis als erstes weg,
          // sobald ein geteiltes Konto oder ein Zähler dazukam — also genau
          // die Information, die man hier nachschlägt.
          Column {
            width: parent.width
            spacing: Style.space(2)
            // Gleicher Kopfplatz wie bei den Provider-Abschnitten: Die
            // Fußzeile löst sich so sichtbar vom letzten Provider, statt
            // nur das content-spacing (12) von dessen Meter zu trennen.
            topPadding: Style.space(12)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: text !== ""
              text: {
                var parts = []
                if (root.loading)
                  parts.push("wird aktualisiert")
                else if (isFinite(root.report.generatedAt))
                  parts.push("Stand " + Usage.agoText(root.report.generatedAt, root.nowMs))
                if (String(root.report.sharedAccount || "") !== "")
                  parts.push(root.report.sharedAccount)
                if (root.report.disabled > 0)
                  parts.push(Usage.plural(root.report.disabled, "Zugang deaktiviert", "Zugänge deaktiviert"))
                if (root.report.withoutUsage > 0)
                  parts.push(Usage.plural(root.report.withoutUsage, "Konto ohne Daten", "Konten ohne Daten"))
                return parts.join("  ·  ")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // Hinweise links, Version rechts auf derselben Grundlinie. Als
            // Item statt Row, weil der Hinweistext umbrechen muss (eine Row
            // mit elide ließe genau die Information verschwinden, die man
            // hier nachschlägt) und die Version dabei rechts oben bleibt.
            Item {
              width: parent.width
              implicitHeight: Math.max(keyHints.implicitHeight, versionLabel.implicitHeight)

              Text {
                id: keyHints
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.right: versionLabel.left
                anchors.rightMargin: Style.space(8)
                anchors.top: parent.top
                text: "v Ansicht · r neu laden · R Cache leeren"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }

              Text {
                id: versionLabel
                textFormat: Text.PlainText
                anchors.right: parent.right
                anchors.top: parent.top
                // Ohne geladenes Manifest keine leere Spalte reservieren.
                visible: root.pluginVersion !== ""
                width: visible ? implicitWidth : 0
                text: "v" + root.pluginVersion
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }
  }

  // Ein Provider-Abschnitt: Trennlinie, Kopfzeile (Name links, Plan bzw.
  // Zugangsangabe, Konto und Reset-Credits rechts) und je Kontingent eine
  // LimitRow.
  component ProviderSection: Column {
    id: providerBlock
    property var provider: null

    readonly property int limitCount: provider && provider.limits instanceof Array ? provider.limits.length : 0

    function limitAt(position) {
      var list = providerBlock.provider ? providerBlock.provider.limits : null
      return list instanceof Array && position >= 0 && position < list.length ? list[position] : null
    }

    spacing: Style.space(8)
    // Kopfplatz über jedem Provider: Die Lücke gehört zum Abschnitt selbst,
    // nicht zum spacing des umgebenden content-Columns — das würde Hero,
    // Fehlerkarte und Fußzeile im gleichen Maß auseinanderziehen. So ist der
    // Gruppenabstand (~2× Zeilenabstand) nur dort, wo Gruppen wechseln, und
    // das Raster innerhalb eines Providers bleibt eng.
    topPadding: Style.space(12)
    // Fußplatz unter dem letzten Meter eines Providers. Eigenes Padding
    // statt eines größeren topPadding: die Lücke soll zum abgeschlossenen
    // Block gehören, nicht vor den nächsten wandern — sonst klebt der
    // letzte Provider an der Fußzeile, während alle anderen Luft haben.
    bottomPadding: Style.space(8)
    // Während eines Abrufs, der Provider entfernt, kann der Index kurz ins
    // Leere zeigen.
    visible: providerBlock.provider !== null

    Row {
      width: parent.width

      PanelSectionHeader {
        id: providerTitle
        text: providerBlock.provider ? providerBlock.provider.name : ""
        foreground: root.foreground
        fontFamily: root.fontFamily
        // Der Provider ist die Überschrift seiner Zeilen, also muss er über
        // ihnen stehen: `body` (12) gegen `bodySmall` (11) der Kontingent-
        // titel. Mit dem Default `caption` (10) war er die kleinste Schrift
        // im Abschnitt und damit optisch untergeordnet.
        fontSize: Style.font.body
        // PanelSectionHeader dunkelt intern um 1.4 ab — gedacht für ein
        // kleines Label über einer Liste. Hier trägt die Zeile den Namen,
        // nach dem man sucht, also volle Vordergrundfarbe. `font.bold` ist
        // in der Komponente schon gesetzt.
        color: root.foreground
      }

      Item {
        // providerMeta.width statt implicitWidth: der Text ist auf 60 % der
        // Breite gedeckelt und elidiert — der Spacer muss mit der
        // gezeichneten, nicht der vollen Breite rechnen, sonst klebt der
        // Meta-Text nicht an der rechten Kante. parent.width ist vom Popup
        // gesetzt, daher keine Bindingschleife.
        width: Math.max(0, parent.width - providerTitle.implicitWidth - providerMeta.width)
        height: 1
      }

      PanelSectionHeader {
        id: providerMeta
        text: {
          var provider = providerBlock.provider
          if (!provider)
            return ""
          var parts = []
          // Was für ein Zugang das ist: Plan, Org, Projekt oder Modell —
          // immer beschriftet, immer genau eine Angabe (accessLabel()).
          if (String(provider.access || "") !== "")
            parts.push(provider.access)
          // Leer, solange alle Provider dasselbe Konto melden — das steht
          // dann einmal in der Fußzeile.
          if (String(provider.account || "") !== "")
            parts.push(provider.account)
          // Prepaid-Guthaben, mit dem sich ein gesperrtes Fenster vorzeitig
          // zurücksetzen lässt.
          if (Number(provider.resetCredits) >= 0)
            parts.push(Usage.plural(provider.resetCredits, "Reset-Credit", "Reset-Credits"))
          return parts.join(" · ")
        }
        foreground: root.foreground
        fontFamily: root.fontFamily
        font.bold: false
        opacity: root.metaOpacity
        elide: Text.ElideRight
        // Der Providername hat Vorrang, wenn der Platz knapp wird.
        width: Math.min(implicitWidth, parent.width * 0.6)
      }
    }

    Repeater {
      model: providerBlock.limitCount

      delegate: LimitRow {
        required property int index
        width: providerBlock.width
        limit: providerBlock.limitAt(index)
      }
    }
  }

  // Eine Kontingentzeile: Titel, Status und Absolutwert, Reset-Countdown,
  // Prozent, Meter. Der Meter zeigt den Verbrauch, füllt also in Richtung
  // Limit.
  component LimitRow: Column {
    id: limitRow
    property var limit: null

    readonly property real fraction: limit ? Number(limit.fraction) : -1
    // Erschöpft heißt erschöpft, unabhängig vom Füllstand: `fraction` ist
    // auf 1 begrenzt und ein überzogenes Kontingent sähe sonst aus wie ein
    // gerade eben volles.
    readonly property bool exhausted: limit ? limit.exhausted === true : false
    readonly property bool alarming: exhausted || (isFinite(fraction) && fraction >= root.alarmAt)
    // Dieselbe Rampe für Fläche und Zahl, nur mit unterschiedlichem
    // Startpunkt: beide erreichen `urgent` im selben Moment, driften also
    // nie auseinander.
    readonly property color tone: root.colorFor(fraction, exhausted)
    readonly property color textTone: root.colorFor(fraction, exhausted, root.foreground)
    readonly property string resetText: limit ? Usage.untilText(limit.resetsAt, root.nowMs) : ""
    // Status zuerst, dann der Absolutwert — letzterer nur, wo die Einheit
    // keine Prozent sind und der Prozentwert die Zahl verschweigt.
    readonly property string detailText: {
      if (!limitRow.limit)
        return ""
      var parts = []
      if (String(limitRow.limit.statusLabel || "") !== "")
        parts.push(limitRow.limit.statusLabel)
      if (String(limitRow.limit.amountText || "") !== "")
        parts.push(limitRow.limit.amountText)
      return parts.join(" · ")
    }

    spacing: Style.space(5)

    Row {
      id: titleRow
      width: parent.width

      // Was rechts stehen bleibt: Detail, Reset und Prozent behalten ihren
      // Platz, der Titel weicht. Einmal benannt statt zweimal ausgeschrieben
      // — Titelbreite und Spacer müssen exakt denselben Wert abziehen,
      // sonst driften sie bei jeder Änderung auseinander.
      readonly property real tailWidth: limitDetail.implicitWidth + limitReset.implicitWidth + limitPercent.implicitWidth

      Text {
        id: limitTitle
        textFormat: Text.PlainText
        text: limitRow.limit ? limitRow.limit.title : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
        // Ein langer Fenstername weicht zuerst.
        width: Math.min(implicitWidth, Math.max(0, parent.width - titleRow.tailWidth - Style.space(12)))
      }

      Item {
        width: Math.max(0, parent.width - limitTitle.width - titleRow.tailWidth)
        height: 1
      }

      Text {
        id: limitDetail
        textFormat: Text.PlainText
        text: limitRow.detailText
        visible: text !== ""
        color: limitRow.exhausted ? root.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        // Kein Platz reservieren, wenn nichts zu sagen ist.
        rightPadding: text !== "" ? Style.space(8) : 0
        anchors.baseline: limitTitle.baseline
      }

      Text {
        id: limitReset
        textFormat: Text.PlainText
        text: limitRow.resetText
        // Bei erschöpftem Kontingent ist die Rückkehrzeit Teil der
        // Alarmmeldung — sie gehört in die Alarmfarbe, nicht ins Grau.
        color: limitRow.exhausted ? root.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        rightPadding: text !== "" ? Style.space(8) : 0
        anchors.baseline: limitTitle.baseline
      }

      Text {
        id: limitPercent
        textFormat: Text.PlainText
        text: limitRow.limit ? limitRow.limit.percentText : "—"
        color: limitRow.textTone
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: limitRow.alarming
      }
    }

    // Komplett ausblenden statt nur die Füllung: Ein leerer Track liest
    // sich als 0 % verbraucht — bei einem unbegrenzten Fenster (fraction
    // -1) ist die Zeile ohne Meter ehrlicher, das "∞" trägt die Aussage.
    Item {
      width: parent.width
      visible: limitRow.fraction >= 0
      implicitHeight: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

      Rectangle {
        id: meterTrack
        anchors.fill: parent
        radius: height / 2
        color: root.track
      }

      Rectangle {
        anchors.left: meterTrack.left
        anchors.verticalCenter: meterTrack.verticalCenter
        height: meterTrack.height
        radius: meterTrack.radius
        width: meterTrack.width * Math.max(0, Math.min(1, limitRow.fraction))
        visible: limitRow.fraction >= 0
        color: limitRow.tone

        Behavior on width {
          NumberAnimation {
            duration: 160
            easing.type: Easing.OutCubic
          }
        }
        // Der Farbsprung beim Stufenwechsel wird mitgeführt: ein Meter, der
        // wächst und dabei hart umschaltet, liest sich wie ein Neuaufbau.
        Behavior on color {
          ColorAnimation {
            duration: 160
          }
        }
      }
    }
  }

  // Eine Verlaufszeile: Titel (Provider · Fenster), große Sparkline und
  // Kennzahlen. Die Zeile stammt aus topConsumers() — die drei größten
  // Verbraucher über alle Provider hinweg, daher trägt der Titel den
  // Providernamen mit.
  component HistoryRow: Column {
    id: historyRow
    property var provider: null
    property var limit: null

    readonly property string titleText: {
      var name = historyRow.provider ? String(historyRow.provider.name || "") : ""
      var title = historyRow.limit ? String(historyRow.limit.title || "") : ""
      return name !== "" && title !== "" ? name + " · " + title : (name !== "" ? name : title)
    }

    readonly property var spark:
      Usage.sparkline(root.historyFor(limit ? limit.id : ""), root.sparkBars)
    readonly property int sparkCount: spark.length
    readonly property var summary:
      historyRow.sparkCount >= 2 ? Usage.historySummary(root.historyFor(limit ? limit.id : "")) : null
    readonly property string summaryText: {
      if (!historyRow.summary)
        return ""
      var parts = []
      parts.push("Ø " + Math.round(historyRow.summary.average * 100) + " %")
      parts.push("Spitze " + Math.round(historyRow.summary.peak * 100) + " %")
      parts.push(Usage.plural(historyRow.summary.count, "Stundenwert", "Stundenwerte"))
      return parts.join(" · ")
    }

    spacing: Style.space(5)
    visible: historyRow.sparkCount >= 2

    Row {
      width: parent.width

      readonly property real tailWidth: historyStand.implicitWidth

      Text {
        id: historyTitle
        textFormat: Text.PlainText
        text: historyRow.titleText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
        width: Math.min(implicitWidth, Math.max(0, parent.width - parent.tailWidth - Style.space(12)))
      }

      Item {
        width: Math.max(0, parent.width - historyTitle.width - parent.tailWidth)
        height: 1
      }

      Text {
        id: historyStand
        textFormat: Text.PlainText
        // Das Alter der Aufzeichnung, nicht des Live-Stands: eine Reihe,
        // die seit Tagen nichts Neues bekam, sagt das hier.
        text: historyRow.summary && isFinite(historyRow.summary.last)
              ? "Stand " + Usage.agoText(historyRow.summary.last, root.nowMs) : ""
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        anchors.baseline: historyTitle.baseline
      }
    }

    // Dieselbe Balkenlogik wie in LimitRow, aber auf eigener Höhe: 26
    // Balken brauchen Platz, damit die Spitze lesbar bleibt.
    Item {
      width: parent.width
      implicitHeight: Style.space(40)

      Repeater {
        model: historyRow.sparkCount

        delegate: Rectangle {
          required property int index

          x: index * width
          width: parent.width / historyRow.sparkCount
          height: parent.height * historyRow.spark[index]
          anchors.bottom: parent.bottom
          color: root.colorFor(historyRow.spark[index], false)
        }
      }
    }

    Text {
      width: parent.width
      visible: historyRow.summaryText !== ""
      textFormat: Text.PlainText
      text: historyRow.summaryText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // Ein Tab im Ansichtsumschalter. Aktiv: volle Farbe und fett; inaktiv:
  // gedimmt. Der Klick setzt nur activeView — geladen wird beim Öffnen,
  // nicht beim Umschalten.
  component ViewTab: Text {
    id: tab
    property int view: 0

    textFormat: Text.PlainText
    text: ["Kontingente", "Verbrauch", "Analyse"][tab.view]
    color: tab.view === root.activeView ? root.foreground : root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    font.bold: tab.view === root.activeView

    MouseArea {
      anchors.fill: parent
      onClicked: root.activeView = tab.view
    }
  }
}
