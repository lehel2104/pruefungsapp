const fs = require('fs');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
    // 1. Datenbank öffnen
    const db = await open({ filename: './pruefung.db', driver: sqlite3.Database });
    
    console.log("📂 Suche 'aufgaben_katalog.csv'...");

    const rows = [];

    // 2. CSV einlesen
    fs.createReadStream('aufgaben_katalog.csv')
        .pipe(csv({ separator: ';' })) // Dein Trenner ist das Semikolon
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            console.log(`📊 ${rows.length} Zeilen gefunden. Starte Datenbank-Update...`);

            for (const row of rows) {
                // Wir nutzen deine Spaltennamen aus der CSV
                const id = row.aufgabe_id;
                const punkte = parseInt(row.min_punkte);

                if (id && !isNaN(punkte)) {
                    await db.run(
                        "UPDATE aufgaben_katalog SET min_punkte = ? WHERE aufgabe_id = ?",
                        [punkte, id]
                    );
                    console.log(`✅ Aufgabe ${id}: min_punkte = ${punkte}`);
                }
            }

            console.log("🚀 Alle Mindestpunkte wurden erfolgreich aktualisiert!");
            await db.close();
            process.exit(0);
        });
})();