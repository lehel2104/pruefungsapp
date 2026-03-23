const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
    const db = await open({ filename: './pruefung.db', driver: sqlite3.Database });
    console.log("🛠️  Repariere Datenbank-Struktur...");

    // Fügt die alte Spalte 'satz' wieder hinzu, falls sie fehlt
    try {
        await db.exec("ALTER TABLE teilnehmer ADD COLUMN satz TEXT DEFAULT 'A'");
        console.log("✅ Spalte 'satz' (Universal) wiederhergestellt.");
    } catch (e) {
        console.log("ℹ️  Spalte 'satz' existiert bereits.");
    }

    // Sicherstellen, dass auch die neuen Spalten da sind
    try {
        await db.exec("ALTER TABLE teilnehmer ADD COLUMN theorie_satz TEXT DEFAULT 'A'");
        await db.exec("ALTER TABLE teilnehmer ADD COLUMN praxis_satz TEXT DEFAULT 'A'");
        console.log("✅ Neue Spalten (Theorie/Praxis) sind bereit.");
    } catch (e) {}

    console.log("🚀 Fertig! Starte jetzt deinen Server neu.");
    await db.close();
})();