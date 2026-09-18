.pragma library

// Zwei Gründe für dieses Plugin:
//
//  1. Schreibweise: das Titelcasing der ID ergäbe "Minimax Code".
//  2. Das 7-Tage-Fenster existiert nicht. MiniMax führt das Wochenlimit im
//     eigenen Dashboard als "Unlimited", setzt aber
//     `current_weekly_remaining_percent = 100`, und omp rechnet daraus
//     stur `(100 - 100) / 100` = 0. `omp usage --history` zeigt 20 von 20
//     Snapshots bei 0,0 %, während das 5-h-Fenster parallel auf 35 % lief.
//     Eine 0-%-Zeile wäre eine Aussage über ein Kontingent, das es nicht
//     gibt — deshalb gilt "7d" hier als unbegrenzt.
//
// Im JSON ist dieses Fenster von einem echten, frisch zurückgesetzten
// nicht zu unterscheiden. Genau deshalb steht es hier und nicht im Kern.
var descriptor = {
  id: "minimax-code",
  name: "MiniMax Code",
  unlimitedWindows: ["7d"]
};
