const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const csv = require('csv-parser');

(async () => {
    const db = await open({
        filename: './pruefung.db',
        driver: sqlite3.Database
    });

    console.log("Lösche alte Katalog-Daten...");
    await db.exec("DELETE FROM aufgaben_katalog;");

    const eintraege = [];
    // Pfad zu deiner CSV-Datei
    fs.createReadStream('praxis.csv')
        .pipe(csv({ separator: ';' })) // Hier ';' oder ',' je nach deiner CSV
        .on('data', (row) => {
            eintraege.push(row);
        })
        .on('end', async () => {
            const stmt = await db.prepare(`
                INSERT INTO aufgaben_katalog 
                (abzeichen, satz, station, aufgabe_id, aufgabe_name, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const r of eintraege) {
                await stmt.run(
                    r['Abzeichen'], r['Satz'], r['Station'], r['Aufgabe'], r['Name'],
                    r['Frage 1'], r['Frage 2'], r['Frage 3'], r['Frage 4'], r['Frage 5'],
                    r['Frage 6'], r['Frage 7'], r['Frage 8'], r['Frage 9'], r['Frage 10'], r['Frage 11']
                );
            }
            await stmt.finalize();
            console.log(`✅ ${eintraege.length} Aufgaben erfolgreich in die 11 Spalten importiert!`);
            process.exit();
        });
})();