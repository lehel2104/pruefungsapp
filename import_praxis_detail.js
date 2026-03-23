const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const csv = require('csv-parser');

(async () => {
    const db = await open({ filename: './pruefung.db', driver: sqlite3.Database });

    await db.exec(`DROP TABLE IF EXISTS aufgaben_katalog; 
        CREATE TABLE aufgaben_katalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            abzeichen TEXT, satz TEXT, station TEXT, aufgabe_id TEXT, aufgabe_name TEXT,
            f1 TEXT, f2 TEXT, f3 TEXT, f4 TEXT, f5 TEXT, f6 TEXT, f7 TEXT, f8 TEXT, f9 TEXT, f10 TEXT, f11 TEXT
        );`);

    const rows = [];
    fs.createReadStream('praxis.csv')
        .pipe(csv({ separator: '\t' })) // Prüfe ob Tab oder Semikolon!
        .on('data', (row) => rows.push(row))
        .on('end', async () => {
            const stmt = await db.prepare(`INSERT INTO aufgaben_katalog 
                (abzeichen, satz, station, aufgabe_id, aufgabe_name, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11) 
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

            for (const r of rows) {
                await stmt.run(
                    r.Abzeichen, r.Satz, r.Station, r.Aufgabe, r.Name,
                    r['Frage 1'], r['Frage 2'], r['Frage 3'], r['Frage 4'], r['Frage 5'],
                    r['Frage 6'], r['Frage 7'], r['Frage 8'], r['Frage 9'], r['Frage 10'], r['Frage 11']
                );
            }
            await stmt.finalize();
            console.log("✅ Praxis-Katalog mit Einzel-Fragen importiert!");
            process.exit();
        });
})();