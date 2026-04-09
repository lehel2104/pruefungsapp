const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const QRCode = require('qrcode');
const { Parser } = require('json2csv');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const basicAuth = require('express-basic-auth');
const { PDFDocument } = require('pdf-lib');


const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

let db;
let stationsStatus = {}; 
let pruefungGestartet = false;
let pruefungsKonfig = { Blau: "A", Orange: "A", Bronze: "A", Silber: "A", Gold: "A" };
let aktiveStufen = ["Blau", "Bronze", "Silber", "Gold", "Orange"]; 
let druckFortschritt = { status: "bereit", logs: [], pdfBuffer: null };

const praxisRegeln = {
    "orange": { soll: 3, mindest: 2 },
    "blau":   { soll: 5, mindest: 3 },
    "bronze": { soll: 8, mindest: 5 },
    "silber": { soll: 15, mindest: 11 },
    "gold":   { soll: 24, mindest: 20 }
};

const theorieRegeln = {
    "orange": { fragen: 5, mindest: 3 },
    "blau":   { fragen: 8, mindest: 5 },
    "bronze": { fragen: 12, mindest: 9 },
    "silber": { fragen: 25, mindest: 20 },
    "gold":   { fragen: 40, mindest: 32 }
};

// --- HILFSFUNKTIONEN ---

async function syncStationsStatus() {
    try {
        const stationen = await db.all('SELECT DISTINCT station FROM aufgaben_katalog');
        for (let s of stationen) {
            const sID = s.station.toString().trim();
            if (sID === "") continue;

            if (!stationsStatus[sID]) {
                stationsStatus[sID] = { 
                    status: "FREI", person: "", prueferName: "Prüfer " + sID, abzeichen: "", aufgabe: "" 
                };
            }

            const randomPass = Math.floor(100000 + Math.random() * 900000).toString();

            await db.run(`INSERT OR IGNORE INTO pruefer_accounts (station, anzeigename, passwort) 
                          VALUES (?, ?, ?)`, [sID, `Prüfer Station ${sID}`, randomPass]);
        }
    } catch (err) { console.error("Sync Fehler:", err); }
}

async function berechneTeilnehmerStatus(db, t, alleErgebnisse, alleAufgaben) {
    try {
        if (!t) return { ...t, stationenDetails: [], fortschritt: 0, gesamtSoll: 0 };

        const tID = String(t.id).trim();
        const tAbzeichenRaw = t.abzeichen ? String(t.abzeichen).trim() : "";
        const tAbzeichenKey = tAbzeichenRaw.toLowerCase();

        const thSatz = (t.theorie_satz || "A").toString().toUpperCase();
        const prSatz = (t.praxis_satz || "A").toString().toUpperCase();

        // 1. Welche Aufgaben MUSS der Teilnehmer machen?
        const sollAufgaben = alleAufgaben.filter(a => {
            if (!a.abzeichen || !a.satz) return false;
            const stufenInCsv = a.abzeichen.toLowerCase().split(',').map(s => s.trim());
            const satzInCsv = String(a.satz).trim().toUpperCase();
            return stufenInCsv.includes(tAbzeichenKey) && satzInCsv === prSatz;
        });

        const hatErgebnisse = alleErgebnisse.filter(e => 
            e.teilnehmer_id && String(e.teilnehmer_id).trim() === tID
        );
        
        const stationenDetails = [];
        const uniqueStations = [...new Set(sollAufgaben.map(a => String(a.station).trim()))];

        uniqueStations.forEach(sID => {
            const aufgabenAnStation = sollAufgaben.filter(a => String(a.station).trim() === sID);
            const sNum = sID.replace(/\D/g, "");

            const aufgabenDetails = aufgabenAnStation.map(sollA => {
                const ergebnis = hatErgebnisse.find(e => 
                    String(e.aufgabe_id).trim() === String(sollA.id).trim() || 
                    String(e.aufgabe_id).trim() === String(sollA.aufgabe_id).trim()
                );
                return {
                    name: sollA.aufgabe_name,
                    status: ergebnis ? ergebnis.status : 'offen',
                    fehler: ergebnis ? ergebnis.fehler : 0
                };
            });

            const erledigt = aufgabenAnStation.length > 0 && aufgabenDetails.every(d => d.status !== 'offen');
            const hatFehler = aufgabenDetails.some(d => d.status === 'nicht_bestanden');
            
            stationenDetails.push({
                nummer: sNum, 
                erledigt: erledigt, 
                ergebnis: hatFehler ? 'nicht_bestanden' : 'bestanden',
                details: aufgabenDetails 
            });
        });

        // 2. Theorie prüfen
        const thErgebnis = hatErgebnisse.find(e => String(e.station).toLowerCase().includes('theorie'));
        const hatTheorie = !!thErgebnis;
        const theorieBestanden = thErgebnis?.status === 'bestanden' || thErgebnis?.status === true;
        const anzahlTheoriePunkte = thErgebnis ? thErgebnis.fehler : 0;

        const allePraxisAufgaben = stationenDetails.flatMap(s => s.details);
        const anzahlBestanden = allePraxisAufgaben.filter(d => d.status === 'bestanden').length;
        
        // ACHTUNG: Stelle sicher, dass praxisRegeln global definiert ist!
        const regel = praxisRegeln[tAbzeichenKey] || { mindest: 0 };
        const praxisBestanden = anzahlBestanden >= regel.mindest;

        const erledigtePraxisCount = stationenDetails.filter(s => s.erledigt).length;
        const gesamtSoll = uniqueStations.length + 1;
        const fortschritt = erledigtePraxisCount + (hatTheorie ? 1 : 0);

        return {
            ...t,
            theorie_satz: thSatz,
            praxis_satz: prSatz,
            stationenDetails,
            hatTheorie,
            theorieBestanden,
            anzahlTheoriePunkte,
            theorieDetails: thErgebnis ? thErgebnis.antwort_details : null, 
            fortschritt,
            gesamtSoll,
            istFertig: (fortschritt >= gesamtSoll && gesamtSoll > 0),
            anzahlBestanden,
            mindestSoll: regel.mindest,
            praxisBestanden,
            gesamtBestanden: (praxisBestanden && theorieBestanden)
        };

    } catch (err) {
        console.error("Fehler in berechneTeilnehmerStatus:", err);
        return { ...t, stationenDetails: [], fortschritt: 0, gesamtSoll: 0, anzahlBestanden: 0, praxisBestanden: false };
    }
}
// --- INITIALISIERUNG & SERVER START ---
(async () => {
    try {
        db = await open({ filename: './pruefung.db', driver: sqlite3.Database });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS teilnehmer (id TEXT PRIMARY KEY, name TEXT, vorname TEXT, abzeichen TEXT, theorie_satz TEXT, praxis_satz TEXT, satz TEXT, ov TEXT, geburtsdatum TEXT);
            CREATE TABLE IF NOT EXISTS pruefer_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, station TEXT UNIQUE, anzeigename TEXT, passwort TEXT);
            CREATE TABLE IF NOT EXISTS ergebnisse (id INTEGER PRIMARY KEY AUTOINCREMENT, teilnehmer_id TEXT, station TEXT, aufgabe_id TEXT, fehler INTEGER, status TEXT, zeit TEXT, antwort_details TEXT);
            CREATE TABLE IF NOT EXISTS aufgaben_katalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT, abzeichen TEXT, satz TEXT, station TEXT, aufgabe_id TEXT, aufgabe_name TEXT, 
                f1 TEXT, f2 TEXT, f3 TEXT, f4 TEXT, f5 TEXT, f6 TEXT, f7 TEXT, f8 TEXT, f9 TEXT, f10 TEXT, f11 TEXT
            );
            CREATE TABLE IF NOT EXISTS theorie_katalog (id INTEGER PRIMARY KEY AUTOINCREMENT, abzeichen TEXT, satz TEXT, frage TEXT, a1 TEXT, a2 TEXT, a3 TEXT, loesungen TEXT);
        `);
        console.log("🚀 Datenbank bereit.");
        

        app.listen(port, '0.0.0.0', () => {
            console.log(`📡 Server läuft auf Port ${port}`);
        });
    } catch (err) {
        console.error("DB Start Fehler:", err);
    }
})();

// 1. Der Schutz-Filter (Middleware)
const adminSchutz = (req, res, next) => {
    if (req.cookies && req.cookies.station === 'admin') {
        next(); 
    } else {
        res.redirect('/login'); 
    }
};

// 2. Globale Zuweisung für alle /admin/... Pfade
app.use('/admin', adminSchutz);

// 3. DIE EINE, RICHTIGE DASHBOARD ROUTE (Die kurze Version bitte löschen!)
app.get('/', adminSchutz, async (req, res) => {
    try {
        const alleT = await db.all('SELECT * FROM teilnehmer ORDER BY CAST(id AS INTEGER) ASC');
        const stufen = (typeof aktiveStufen !== 'undefined') ? aktiveStufen : [];
        const tRows = alleT.filter(t => stufen.includes(t.abzeichen));
        const rohErgebnisse = await db.all('SELECT * FROM ergebnisse');
        const alleA = await db.all('SELECT * FROM aufgaben_katalog');
        
        const ergebnisseRaw = rohErgebnisse.map(e => {
            const t = alleT.find(tn => tn.id.toString().trim() === e.teilnehmer_id.toString().trim());
            const aufgabeAusKatalog = alleA.find(a => a.id.toString() === e.aufgabe_id?.toString());
            const aufgabeName = aufgabeAusKatalog ? aufgabeAusKatalog.aufgabe_name : (e.station === 'Theorie' ? 'Theorie-Test' : 'Aufgabe ' + e.aufgabe_id);

            return {
                ...e,
                vorname: t ? t.vorname : "ID:",
                name: t ? t.name : e.teilnehmer_id,
                abzeichen: t ? t.abzeichen : "N/A",
                aufgabe_name: aufgabeName,
                status: (e.status && typeof e.status === 'string') ? e.status : "unbekannt" 
            };
        });

        const teilnehmer = await Promise.all(tRows.map(t => berechneTeilnehmerStatus(db, t, rohErgebnisse, alleA)));
        const ergebnisse = ergebnisseRaw.filter(e => e.abzeichen === "N/A" || stufen.includes(e.abzeichen));

        // Hier werden alle Variablen korrekt übergeben
        res.render('index', { 
            teilnehmer, 
            ergebnisse, 
            pruefungsKonfig: (typeof pruefungsKonfig !== 'undefined') ? pruefungsKonfig : {},
            pruefungGestartet: (typeof pruefungGestartet !== 'undefined') ? pruefungGestartet : false, 
            aktiveStufen: stufen
        });

    } catch (err) { 
        console.error("Dashboard Fehler:", err);
        res.status(500).send("Fehler im Dashboard: " + err.message); 
    }
});

app.get('/admin/teilnehmer', async (req, res) => {
    try {
        // 1. Alle Rohdaten aus der DB laden
        const tRows = await db.all('SELECT * FROM teilnehmer ORDER BY CAST(id AS INTEGER) ASC');
        const rohE = await db.all('SELECT * FROM ergebnisse');
        const aAll = await db.all('SELECT * FROM aufgaben_katalog');

        // 2. Status für jeden Teilnehmer einzeln berechnen (Praxis, Theorie, Sätze)
        const teilnehmer = await Promise.all(
            tRows.map(t => berechneTeilnehmerStatus(db, t, rohE, aAll))
        );

        // 3. Den Durchschnitts-Fortschritt der gesamten Gruppe berechnen
        let gesamtProzent = 0;
        if (teilnehmer.length > 0) {
            const summeProzent = teilnehmer.reduce((acc, t) => {
                // Nur rechnen, wenn gesamtSoll > 0 ist, um Division durch 0 zu vermeiden
                let einzelProzent = (t.gesamtSoll > 0) ? (t.fortschritt / t.gesamtSoll) * 100 : 0;
                return acc + einzelProzent;
            }, 0);
            gesamtProzent = Math.round(summeProzent / teilnehmer.length);
        }

        // 4. Daten an das EJS-Template übergeben
        res.render('teilnehmer_management', { 
            teilnehmer, 
            gesamtFortschritt: gesamtProzent 
        });

    } catch (err) { 
        console.error("Fehler beim Laden der Teilnehmer-Verwaltung:", err);
        res.status(500).send("Datenbankfehler: " + err.message); 
    }
});

// Diese Route in deiner server.js suchen:
app.post('/admin/upload-teilnehmer', upload.single('csvfile'), (req, res) => {
    const results = [];
    const qrDir = './public/qrcodes';
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

    fs.createReadStream(req.file.path).pipe(csv({ separator: ';' }))
        .on('data', (data) => { if(data.id) results.push(data); })
        .on('end', async () => {
            try {
                for (let p of results) {
                    const stufe = p.abzeichen;
                    
                    // HIER: Das Programm holt sich die Sätze vom Admin-Panel (pruefungsKonfig)
                    // Du musst sie also NICHT in der CSV haben!
                    const konfig = pruefungsKonfig[stufe] || { theorie: 'A', praxis: 'A' };
                    
                    const thSatz = (typeof konfig === 'object') ? konfig.theorie : 'A';
                    const prSatz = (typeof konfig === 'object') ? konfig.praxis : 'A';

                    // 9 Fragezeichen für die 9 Spalten (inkl. OV und Geburtsdatum)
                    await db.run('INSERT OR REPLACE INTO teilnehmer VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
                        [
                            p.id.toString().trim(), 
                            p.name, 
                            p.vorname, 
                            stufe, 
                            thSatz,      // Automatisch aus Admin-Panel
                            prSatz,      // Automatisch aus Admin-Panel
                            prSatz,      // Allgemeiner Satz (folgt Praxis)
                            p.ov || '',  // Aus der CSV
                            p.geburtsdatum || '' // Aus der CSV
                        ]
                    );
                    
                    await QRCode.toFile(`${qrDir}/${p.id.toString().trim()}.png`, p.id.toString().trim());
                }
                
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                console.log("✅ CSV-Import abgeschlossen und Sätze automatisch zugewiesen.");
                res.redirect('/');
            } catch (err) {
                console.error("Fehler beim CSV-Import:", err);
                res.status(500).send("Fehler beim Importieren der Daten.");
            }
        });
});

app.post('/admin/upload-katalog', upload.single('csvfile'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv({ separator: ';' }))
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            await db.run('DELETE FROM aufgaben_katalog');
            for (let a of results) {
                await db.run(`INSERT INTO aufgaben_katalog 
                    (abzeichen, satz, station, aufgabe_id, aufgabe_name, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                    [
                        a.Abzeichen || a.abzeichen, 
                        a.Satz || a.satz, 
                        a.Station || a.station, 
                        a.Aufgabe || a.aufgabe_id, 
                        a.Name || a.aufgabe_name, 
                        a.f1, a.f2, a.f3, a.f4, a.f5, a.f6, a.f7, a.f8, a.f9, a.f10, a.f11
                    ]
                );
            }
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.redirect('/admin/konfiguration');
        });
});

app.post('/admin/start-pruefung', async (req, res) => {
    try {
        const wahl = req.body.aktive_stufen;
        // Falls nur eine Stufe gewählt wurde, in Array umwandeln
        aktiveStufen = wahl ? (Array.isArray(wahl) ? wahl : [wahl]) : [];
        
        for (const stufe of ['Blau', 'Orange', 'Bronze', 'Silber', 'Gold']) {
            if (aktiveStufen.includes(stufe)) {
                // Holen der Werte aus dem Formular
                const thSatz = req.body[stufe + '_theorie_satz'] || 'A';
                const prSatz = req.body[stufe + '_praxis_satz'] || 'A';

                // 1. In der Datenbank für alle vorhandenen Teilnehmer updaten
                await db.run(
                    `UPDATE teilnehmer 
                     SET theorie_satz = ?, praxis_satz = ?, satz = ? 
                     WHERE abzeichen = ?`,
                    [thSatz, prSatz, prSatz, stufe]
                );

                // 2. WICHTIG: Die globale Konfig als OBJEKT speichern
                // Nur so können Nachzügler später beides korrekt "erben"
                pruefungsKonfig[stufe] = { 
                    theorie: thSatz, 
                    praxis: prSatz 
                };
            }
        }

        await syncStationsStatus();
        pruefungGestartet = true;
        res.redirect('/');
    } catch (err) {
        console.error("Fehler beim Starten:", err);
        res.status(500).send("Fehler beim Speichern der Sätze.");
    }
});

app.get('/start-aufgabe/:aufgabe_id/:teilnehmer_id/:station', async (req, res) => {
    try {
        const { aufgabe_id, teilnehmer_id, station } = req.params;

        // 1. Teilnehmer laden
        const t = await db.get('SELECT * FROM teilnehmer WHERE id = ?', [teilnehmer_id.toString().trim()]);

        // 2. Aufgabe laden (WICHTIG: aufgabe_id statt id nutzen)
        // SELECT * sorgt dafür, dass auch min_punkte mitkommt
        const aufgabe = await db.get('SELECT * FROM aufgaben_katalog WHERE id = ?', [aufgabe_id]);

        if (!t || !aufgabe) {
            return res.send(`Fehler: Teilnehmer (#${teilnehmer_id}) oder Aufgabe (${aufgabe_id}) nicht gefunden.`);
        }

        const sID = station.replace("Station ", "").trim();

        // 3. Status für den Admin-Monitor setzen
        stationsStatus[sID] = { 
            status: "BESETZT", 
            person: `${t.vorname} ${t.name}`, 
            abzeichen: t.abzeichen, 
            aufgabe: aufgabe.aufgabe_name 
        };

        // 4. Bewertung-Seite rendern
        // Wir geben t, aufgabe (inkl. min_punkte) und station weiter
        res.render('bewertung', { 
            t, 
            station: sID, 
            aufgabe, 
            pruefungsKonfig 
        });

    } catch (err) { 
        console.error("Fehler in start-aufgabe:", err);
        res.status(500).send("Server-Fehler: " + err.message); 
    }
});

app.post('/admin/add-teilnehmer-einzeln', async (req, res) => {
    try {
        const { id, name, vorname, abzeichen, ov, geburtsdatum } = req.body;
        const cleanID = id.toString().trim();
        
        // 1. Hol die Konfiguration für diese Stufe (z.B. Gold)
        const konfig = pruefungsKonfig[abzeichen];

        // 2. Sätze bestimmen (Logik: Objekt vorhanden? Dann nimm die Werte, sonst Standard 'A')
        let thSatz = 'A';
        let prSatz = 'A';

        if (konfig && typeof konfig === 'object') {
            thSatz = konfig.theorie || 'A';
            prSatz = konfig.praxis || 'A';
        } else if (typeof konfig === 'string') {
            // Rückfallebene, falls noch alte Datenreste im RAM sind
            thSatz = konfig;
            prSatz = konfig;
        }

        // 3. In die DB schreiben (Exakt 9 Werte für die 9 Spalten)
        // Spalten: id, name, vorname, abzeichen, theorie_satz, praxis_satz, satz, ov, geburtsdatum
        await db.run('INSERT OR REPLACE INTO teilnehmer VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [
                cleanID, 
                name, 
                vorname, 
                abzeichen, 
                thSatz, 
                prSatz, 
                prSatz,      // Der allgemeine 'satz'
                ov || '', 
                geburtsdatum || ''
            ]
        );
        
        // 4. QR-Code für den neuen Teilnehmer generieren
        await QRCode.toFile(`./public/qrcodes/${cleanID}.png`, cleanID);
        
        console.log(`✅ Nachzügler ${vorname} ${name} angelegt (Th: ${thSatz}, Pr: ${prSatz})`);
        res.redirect('/');

    } catch (err) {
        console.error("Fehler beim Einzel-Anlegen:", err);
        res.status(500).send("Fehler beim Speichern: " + err.message);
    }
});

app.get('/admin/delete-teilnehmer/:id', async (req, res) => {
    await db.run('DELETE FROM teilnehmer WHERE id = ?', [req.params.id.toString().trim()]);
    await db.run('DELETE FROM ergebnisse WHERE teilnehmer_id = ?', [req.params.id.toString().trim()]);
    res.redirect('/admin/teilnehmer');
});

app.get('/admin/pruefer-liste', async (req, res) => {
    try {
        await syncStationsStatus();
        const accounts = await db.all('SELECT * FROM pruefer_accounts ORDER BY CAST(station AS INTEGER) ASC');
        res.render('pruefer_liste', { accounts, host: req.headers.host }); 
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/admin/update-pruefer', async (req, res) => {
    await db.run(`UPDATE pruefer_accounts SET anzeigename = ?, passwort = ? WHERE station = ?`, 
                 [req.body.anzeigename, req.body.passwort, req.body.station]);
    res.redirect('/admin/pruefer-liste');
});

app.get('/admin/konfiguration', async (req, res) => {
    try {
        const alleA = await db.all(`SELECT * FROM aufgaben_katalog ORDER BY CAST(station AS INTEGER) ASC`);
        const stationsPlan = {};

        alleA.forEach(aufg => {
            if (!aufg.abzeichen) return;
            const stufenDerAufgabe = aufg.abzeichen.split(',').map(s => s.trim());

            const istAufgabeAktiv = stufenDerAufgabe.some(stufe => {
                if (!aktiveStufen.includes(stufe)) return false;
                const konfig = pruefungsKonfig[stufe];
                if (!konfig) return false;
                
                // Hier wird der gewählte Buchstabe (A, B, C, D...) geholt
                const gewaehlterSatz = (typeof konfig === 'object') ? konfig.praxis : konfig;
                // Und hier mit der Datenbank verglichen
                return gewaehlterSatz === aufg.satz;
            });

            if (istAufgabeAktiv) {
                if (!stationsPlan[aufg.station]) stationsPlan[aufg.station] = [];
                stationsPlan[aufg.station].push(aufg);
            }
        });
        res.render('admin_konfig_view', { stationsPlan, pruefungsKonfig, aktiveStufen });
    } catch (err) {
        res.status(500).send("Fehler: " + err.message);
    }
});

app.post('/admin/update-aufgabe-station', async (req, res) => {
    await db.run('UPDATE aufgaben_katalog SET station = ? WHERE id = ?', [req.body.neue_station, req.body.aufgabe_id]);
    await syncStationsStatus();
    res.sendStatus(200);
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
    const { id, passwort } = req.body;

    try {
        // 1. Fall: Admin
        if (id.toLowerCase() === 'admin' && passwort === 'admin') {
            // Wir setzen das Cookie ohne Schnickschnack, damit es überall greift
            res.cookie('station', 'admin', { maxAge: 24 * 60 * 60 * 1000 }); 
            console.log("✅ Admin-Cookie gesetzt");
            return res.redirect('/'); 
        }

        // 2. Fall: Prüfer (Station)
        const acc = await db.get('SELECT * FROM pruefer_accounts WHERE station = ? AND passwort = ?', [id, passwort]);
        
        if (acc) {
            // WICHTIG: Das Cookie muss den EXAKTEN Wert von 'id' haben (z.B. "1")
            res.cookie('station', String(id), { maxAge: 24 * 60 * 60 * 1000 });
            console.log(`✅ Station-Cookie für ${id} gesetzt`);
            
            // Wir nutzen einen Redirect, um die URL sauber zu wechseln
            return res.redirect(`/station/${id}`); 
        } else {
            console.log("❌ Login fehlgeschlagen: Falsche Daten");
            res.render('login', { error: "Zugangsdaten falsch." });
        }
    } catch (err) {
        console.error("🔥 Schwerer Login-Fehler:", err);
        res.status(500).send("Login-Fehler: " + err.message);
    }
});
// Diese Route fehlt und behebt das "Cannot GET /station/1"
app.get('/station/:id', async (req, res) => {
    const sID = req.params.id; // Das ist die "1" aus der URL

    // 1. Sicherheits-Check: Hat der User das richtige Cookie?
    const cookieStation = req.cookies ? String(req.cookies.station) : null;
    
    // Wir prüfen, ob das Cookie zur Station in der URL passt
    if (cookieStation !== sID && cookieStation !== 'admin') {
        console.warn(`🚨 Zugriff verweigert! URL-Station: ${sID}, Cookie: ${cookieStation}`);
        return res.redirect('/login');
    }

    // 2. Wenn alles okay ist: Scanner-Seite anzeigen
    // Der Wert 'station' wird an das EJS-Template übergeben
    res.render('scanner', { 
        station: sID 
    });
});

app.get('/pruefen/:station_id/:id', async (req, res) => {
    try {
        const tID = req.params.id.toString().trim();
        const sID_param = req.params.station_id; // "Station 1" oder "1"
        const sNum = sID_param.replace(/\D/g, "").trim(); // Extrahiert NUR die Zahl, z.B. "1"

        // --- 1. SICHERHEITS-CHECK ---
        // Wir vergleichen die nackte Zahl aus dem Cookie mit der nackten Zahl aus der URL
        const cookieStation = req.cookies ? String(req.cookies.station) : null;
        
        if (cookieStation !== sNum && cookieStation !== 'admin') {
            console.warn(`🚨 Zugriff verweigert! URL-Station: ${sNum}, Cookie-Station: ${cookieStation}`);
            return res.redirect('/login'); 
        }

        // --- 2. TEILNEHMER LADEN ---
        const t = await db.get('SELECT * FROM teilnehmer WHERE id = ?', [tID]);
        if (!t) return res.send("Teilnehmer ID unbekannt.");

        // --- 3. AUFGABEN FINDEN ---
        const aktuellerSatz = t.praxis_satz || 'A';
        
        // WICHTIG: Wir suchen in der DB nach der nackten Nummer ODER dem vollen Namen
        const aufgaben = await db.all(
            'SELECT * FROM aufgaben_katalog WHERE abzeichen LIKE ? AND satz = ? AND (station = ? OR station = ?)', 
            [`%${t.abzeichen}%`, aktuellerSatz, sNum, sID_param]
        );

        // --- 4. ERGEBNISSE PRÜFEN ---
        const erledigteErgebnisse = await db.all(
            'SELECT aufgabe_id FROM ergebnisse WHERE teilnehmer_id = ? AND station = ?', 
            [tID, sID_param]
        );
        const erledigteIds = erledigteErgebnisse.map(e => e.aufgabe_id ? e.aufgabe_id.toString() : "");

        const aufgabenMitStatus = aufgaben.map(a => ({
            ...a,
            erledigt: erledigteIds.includes(a.id.toString())
        }));

        // --- 5. LOGIK: AUSWAHL ODER DIREKT-BEWERTUNG ---
        if (aufgabenMitStatus.length > 1 || (aufgabenMitStatus.length === 1 && aufgabenMitStatus[0].erledigt)) {
            // Mehrere Aufgaben oder die einzige Aufgabe ist schon fertig -> Auswahl zeigen
            res.render('aufgaben_auswahl', { t, station: sID_param, aufgaben: aufgabenMitStatus });
        } else if (aufgabenMitStatus.length === 1) {
            // Genau eine offene Aufgabe -> Direkt zur Bewertung
            const a = aufgabenMitStatus[0];
            
            // Monitor-Status aktualisieren
            stationsStatus[sNum] = { 
                status: "BESETZT", 
                person: `${t.vorname} ${t.name}`, 
                abzeichen: t.abzeichen, 
                aufgabe: a.aufgabe_name 
            };
            
            res.render('bewertung', { t, station: sID_param, aufgabe: a });
        } else {
            res.send(`Keine Aufgaben für ${t.abzeichen} (Satz ${aktuellerSatz}) an Station ${sNum} gefunden.`);
        }

    } catch (err) { 
        console.error("Fehler in /pruefen:", err);
        res.status(500).send("Serverfehler: " + err.message); 
    }
});


app.post('/ergebnis-speichern', async (req, res) => {
    try {
        const { id, station, fehler, status, aufgabe_id } = req.body;
        
        // sID sauber extrahieren (falls "Station 1" oder nur "1" kommt)
        const sID = station.toString().replace("Station ", "").trim();
        
        // In die Datenbank schreiben
        // Zeitstempel: HH:MM:SS
        await db.run(
            `INSERT INTO ergebnisse (teilnehmer_id, station, aufgabe_id, fehler, status, zeit) 
             VALUES (?, ?, ?, ?, ?, ?)`, 
            [
                id.toString().trim(), 
                sID, 
                aufgabe_id, 
                parseInt(fehler) || 0, 
                status, 
                new Date().toLocaleTimeString('de-DE')
            ]
        );

        // Station auf dem Admin-Monitor wieder freigeben
        if (stationsStatus[sID]) {
            stationsStatus[sID] = { status: "FREI", person: "", abzeichen: "", aufgabe: "" };
        }

        // Zurück zum Scanner für den nächsten Teilnehmer
        // Wir nutzen das Cookie, falls vorhanden, sonst die sID
        const cookieStation = req.cookies.station || sID;
        res.render('scanner', { 
            station: cookieStation, 
            msg: `Ergebnis für ID ${id} erfolgreich gespeichert!` 
        });

    } catch (err) {
        console.error("Fehler beim Speichern des Ergebnisses:", err);
        res.status(500).send("Datenbankfehler beim Speichern.");
    }
});

app.get('/theorie-station', (req, res) => res.render('theorie_login'));

app.post('/theorie/anmelden', async (req, res) => {
    try {
        const tID = req.body.teilnehmer_id.toString().trim();
        const t = await db.get('SELECT * FROM teilnehmer WHERE id = ?', [tID]);
        
        if (!t) {
            return res.send("<script>alert('Teilnehmer-ID nicht gefunden!'); window.location.href='/theorie-station';</script>");
        }

        const bereitsAbgelegt = await db.get(
            'SELECT * FROM ergebnisse WHERE teilnehmer_id = ? AND station = ?', 
            [tID, 'Theorie']
        );

        if (bereitsAbgelegt) {
            return res.send(`
                <script>
                    alert('Fehler: Teilnehmer ${t.vorname} ${t.name} hat die Theorieprüfung bereits am ${bereitsAbgelegt.zeit} Uhr abgegeben!');
                    window.location.href='/theorie-station';
                </script>
            `);
        }

        const abzeichen = t.abzeichen.trim();
        
        // --- ÄNDERUNG HIER: Nutzt jetzt den individuellen Satz des Teilnehmers ---
        const thSatz = (t.theorie_satz || "A").toString().replace('Satz ', '').trim();

        const fragen = await db.all(
            'SELECT * FROM theorie_katalog WHERE abzeichen LIKE ? AND satz LIKE ?', 
            [`%${abzeichen}%`, `%${thSatz}%`]
        );

        if (fragen.length === 0) {
            return res.send(`<script>alert('Keine Fragen für ${abzeichen} Satz ${thSatz} im Katalog gefunden!'); window.location.href='/theorie-station';</script>`);
        }

        // Wir geben den thSatz auch an das Template weiter, falls dort "Serie X" stehen soll
        res.render('theorie_test', { t, fragen, thSatz });
    } catch (err) {
        console.error(err);
        res.status(500).send("Systemfehler beim Login.");
    }
});

app.post('/theorie-speichern', async (req, res) => {
    try {
        const { teilnehmer_id, punkte, details } = req.body; // 'details' kommt vom neuen Hidden-Input
        const tID = teilnehmer_id.toString().trim();
        
        const t = await db.get('SELECT abzeichen FROM teilnehmer WHERE id = ?', [tID]);
        if (!t) return res.send("Fehler: Teilnehmer nicht gefunden.");

        const abzeichenKey = t.abzeichen.toLowerCase();
        const regel = theorieRegeln[abzeichenKey] || { mindest: 1 };
        const status = (parseInt(punkte) >= regel.mindest) ? 'bestanden' : 'nicht_bestanden';

        // Wir speichern den JSON-String 'details' in die Spalte 'antwort_details'
        // Falls die Spalte noch nicht existiert, legt SQLite sie beim nächsten Start an (siehe Schritt 3)
        await db.run(
            `INSERT INTO ergebnisse (teilnehmer_id, station, fehler, status, zeit, antwort_details) VALUES (?, ?, ?, ?, ?, ?)`, 
            [tID, 'Theorie', punkte, status, new Date().toLocaleTimeString('de-DE'), details]
        );

        stationsStatus["Theorie"] = { status: "FREI", person: "", abzeichen: "", aufgabe: "" };

        res.send(`
            <script>
                alert('Vielen Dank! Deine Antworten wurden gespeichert.');
                window.location.href = '/theorie-station';
            </script>
        `);
    } catch (err) {
        console.error("Speicherfehler Theorie:", err);
        res.status(500).send("Fehler beim Speichern.");
    }
});

app.get('/dashboard', async (req, res) => {
    const aDB = await db.all('SELECT * FROM aufgaben_katalog');
    const vSet = new Set();
    
    aDB.forEach(a => {
        if (!a.abzeichen) return;
        const stufen = a.abzeichen.split(',').map(s => s.trim());
        
        if (stufen.some(s => {
            const konfig = pruefungsKonfig[s];
            if (!konfig || !aktiveStufen.includes(s)) return false;
            const gewaehlterSatz = (typeof konfig === 'object') ? konfig.praxis : konfig;
            return gewaehlterSatz === a.satz;
        })) {
            vSet.add(a.station.toString());
        }
    });
    
    const vList = Array.from(vSet);
    if (pruefungGestartet) vList.push("Theorie");
    const gefiltert = {};
    vList.forEach(id => { 
        gefiltert[id] = stationsStatus[id] || { status: "FREI", person: "", abzeichen: "", aufgabe: "" }; 
    });
    res.render('dashboard', { stationsStatus: gefiltert, pruefungGestartet });
});

app.get('/admin-monitor', async (req, res) => {
    try {
        const aDB = await db.all('SELECT * FROM aufgaben_katalog');
        const vSet = new Set();
        const mapping = {};

        aDB.forEach(a => {
            if (!a.abzeichen) return;
            const stufen = a.abzeichen.split(',').map(s => s.trim());

            // Überprüfung, ob die Aufgabe zur aktuellen Konfiguration passt
            if (stufen.some(s => {
                const konfig = pruefungsKonfig[s];
                // 1. Ist die Stufe aktiv?
                if (!aktiveStufen.includes(s) || !konfig) return false;

                // 2. Den gewählten Praxis-Satz extrahieren
                // Falls konfig ein Objekt ist, nimm .praxis, sonst (Fallback) den String selbst
                const gewaehlterSatz = (typeof konfig === 'object') ? konfig.praxis : konfig;

                // 3. Vergleich mit dem Satz der Aufgabe aus der Datenbank
                return gewaehlterSatz === a.satz;
            })) {
                vSet.add(a.station.toString());
                if (!mapping[a.station]) mapping[a.station] = [];
                mapping[a.station].push(a.aufgabe_name);
            }
        });

        const gefiltert = {};
        // Theorie-Station immer hinzufügen, den Rest aus dem vSet
        Array.from(vSet).concat("Theorie").forEach(id => {
            gefiltert[id] = { 
                ...(stationsStatus[id] || { status: "FREI", person: "", abzeichen: "", aufgabe: "" }), 
                moeglicheAufgaben: mapping[id] || [] 
            };
        });

        res.render('admin_monitor', { stationsStatus: gefiltert });
    } catch (err) {
        console.error("Fehler im Admin-Monitor:", err);
        res.status(500).send("Fehler beim Laden des Monitors.");
    }
});

app.get('/admin/delete-ergebnis/:id', async (req, res) => {
    await db.run('DELETE FROM ergebnisse WHERE id = ?', [req.params.id]);
    res.redirect('/');
});

const AdmZip = require('adm-zip');
const html_to_pdf = require('html-pdf-node');

// --- 1. Die Hilfsfunktion (Muss vor den Routen stehen) ---
async function generatePDFBuffer(tID, req, res) {
    return new Promise(async (resolve, reject) => {
        try {
            const tRow = await db.get('SELECT * FROM teilnehmer WHERE id = ?', [tID]);
            if (!tRow) return reject(new Error("Teilnehmer nicht gefunden"));

            const rohErgebnisse = await db.all('SELECT * FROM ergebnisse WHERE teilnehmer_id = ?', [tID]);
            const alleAufgaben = await db.all('SELECT * FROM aufgaben_katalog');
            
            const status = await berechneTeilnehmerStatus(db, tRow, rohErgebnisse, alleAufgaben);

            let templateName = 'pdf_vorlage_gold';
            const stufe = tRow.abzeichen.toLowerCase();
            if (stufe.includes('silber')) templateName = 'pdf_vorlage_silber';
            else if (stufe.includes('bronze')) templateName = 'pdf_vorlage_bronze';
            else if (stufe.includes('blau')) templateName = 'pdf_vorlage_blau';
            else if (stufe.includes('orange')) templateName = 'pdf_vorlage_orange';

            const options = { 
                format: 'A4', landscape: true, printBackground: true,
                executablePath: '/usr/bin/chromium-browser',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };

            // HTML rendern und abfangen
            res.render(templateName, { t: status }, (err, html) => {
                if (err) return reject(err);
                html_to_pdf.generatePdf({ content: html }, options)
                    .then(pdfBuffer => resolve(pdfBuffer))
                    .catch(e => reject(e));
            });
        } catch (err) {
            reject(err);
        }
    });
}

// --- 2. Die Routen ---

// Einzel-PDF Export
app.get('/admin/export-pdf/:id', async (req, res) => {
    try {
        const tID = req.params.id.trim();
        const buffer = await generatePDFBuffer(tID, req, res);
        const tRow = await db.get('SELECT name, vorname FROM teilnehmer WHERE id = ?', [tID]);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Auswertung_${tRow.name}_${tRow.vorname}.pdf`);
        res.send(buffer);
    } catch (err) {
        res.status(500).send("Fehler: " + err.message);
    }
});

// SAMMEL-EXPORT (ZIP)
app.get('/admin/export-alle-pdfs', async (req, res) => {
    try {
        const teilnehmer = await db.all('SELECT id, name, vorname FROM teilnehmer');
        const zip = new AdmZip();
        
        console.log(`📦 Starte ZIP-Export für ${teilnehmer.length} Personen...`);

        for (const t of teilnehmer) {
            try {
                // WICHTIG: Hier müssen t.id, req, res übergeben werden
                const pdfBuffer = await generatePDFBuffer(t.id, req, res); 
                const fileName = `Auswertung_${t.id}_${t.name}_${t.vorname}.pdf`.replace(/\s/g, '_');
                zip.addFile(fileName, pdfBuffer);
                console.log(`✅ PDF für ${t.name} erstellt.`);
            } catch (e) {
                console.error(`❌ Fehler bei ID ${t.id}:`, e.message);
            }
        }

        const zipBuffer = zip.toBuffer();
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', 'attachment; filename=Alle_Pruefungsprotokolle.zip');
        res.send(zipBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Erstellen des ZIP-Archivs.");
    }
});

// CSV Export
app.get('/export-ergebnisse', async (req, res) => {
    const rohE = await db.all('SELECT * FROM ergebnisse');
    const daten = rohE.map(e => ({ ...e, status: e.status || "unbekannt" }));
    res.header('Content-Type', 'text/csv').attachment('ergebnisse.csv').send(new Parser().parse(daten));
});

// Reset
app.post('/admin/reset-pruefung', async (req, res) => {
   try {
    await db.run('DELETE FROM ergebnisse');
     await db.run('DELETE FROM teilnehmer');
     await db.run('DELETE FROM pruefer_accounts');
     const qrDir = './public/qrcodes';
      if (fs.existsSync(qrDir)) {
        fs.readdirSync(qrDir).forEach(f => fs.unlinkSync(`${qrDir}/${f}`));
    }
     stationsStatus = {};
     pruefungGestartet = false;
    res.redirect('/');
    } catch (err) {
      res.status(500).send("Fehler beim Reset: " + err.message);
    }
});

app.get('/admin/delete-pruefer/:station', adminSchutz, async (req, res) => {
    try {
        const station = req.params.station;
        await db.run('DELETE FROM pruefer_accounts WHERE station = ?', [station]);
        console.log(`🗑️ Prüfer für Station ${station} gelöscht.`);
        res.redirect('/admin/pruefer-liste'); // Zurück zur Liste
    } catch (err) {
        res.status(500).send("Fehler beim Löschen: " + err.message);
    }
});

app.get('/admin/export-pruefer', adminSchutz, async (req, res) => {
    try {
        const accounts = await db.all('SELECT station, passwort FROM pruefer_accounts ORDER BY CAST(station AS INTEGER) ASC');
        
        // Header für die CSV
        let csvContent = "Station;Passwort;Login-Link\n";
        
        // Daten zeilenweise hinzufügen
        accounts.forEach(a => {
            csvContent += `${a.station};${a.passwort};https://thw-jugend-laz.de/login \n`;
        });

        // Datei an den Browser senden
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=pruefer_zugangsdaten.csv');
        res.status(200).send(csvContent);
    } catch (err) {
        res.status(500).send("Export fehlgeschlagen: " + err.message);
    }
});

app.get('/admin/drucken-status-view', adminSchutz, (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Druckvorgang läuft</title>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
            <style>
                body { font-family: sans-serif; background: #0f172a; color: white; padding: 40px; text-align: center; }
                #log-window { background: #1e293b; border: 1px solid #334155; height: 300px; overflow-y: auto; 
                              text-align: left; padding: 20px; border-radius: 8px; margin: 20px auto; max-width: 600px; font-family: monospace; }
                .success { color: #10b981; }
                .info { color: #3b82f6; }
                .btn { background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: none; }
                .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 2s linear infinite; display: inline-block; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <h2><i class="fas fa-print"></i> Sammel-PDF Erstellung</h2>
            <div id="loader-box"><div class="loader"></div> <p>Bitte warten, Dokumente werden generiert...</p></div>
            <div id="log-window"></div>
            <a id="download-btn" href="/admin/drucken-abholen" class="btn">PDF Öffnen</a>

            <script>
                const logWindow = document.getElementById('log-window');
                const eventSource = new EventSource('/admin/drucken-stream');
                
                eventSource.onmessage = function(event) {
                    const data = JSON.parse(event.data);
                    
                    if (data.msg) {
                        const line = document.createElement('div');
                        line.className = data.type || '';
                        line.innerHTML = "> " + data.msg;
                        logWindow.appendChild(line);
                        logWindow.scrollTop = logWindow.scrollHeight;
                    }

                    if (data.status === 'fertig') {
                        document.getElementById('loader-box').innerHTML = "<b class='success'>Fertig!</b>";
                        document.getElementById('download-btn').style.display = 'inline-block';
                        eventSource.close();
                    }
                };
            </script>
        </body>
        </html>
    `);
});

// Route 2: Der Stream für die Live-Logs
app.get('/admin/drucken-stream', adminSchutz, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendLog = (msg, status = "laufend", type = "info") => {
        res.write(`data: ${JSON.stringify({ msg, status, type })}\n\n`);
    };

    try {
        const teilnehmer = await db.all('SELECT id, name, vorname FROM teilnehmer ORDER BY CAST(id AS INTEGER) ASC');
        const mergedPdf = await PDFDocument.create();

        sendLog(`Starte PDF-Zusammenführung für \${teilnehmer.length} Teilnehmer...`);

        for (const t of teilnehmer) {
            sendLog(`Verarbeite \${t.vorname} \${t.name} (ID: \${t.id})...`);
            try {
                const pdfBuffer = await generatePDFBuffer(t.id, req, res);
                const donorPdf = await PDFDocument.load(pdfBuffer);
                const copiedPages = await mergedPdf.copyPages(donorPdf, donorPdf.getPageIndices());
                copiedPages.forEach(page => mergedPdf.addPage(page));
            } catch (e) {
                sendLog(`Fehler bei ID \${t.id}: \${e.message}`, "laufend", "danger");
            }
        }

sendLog("Finalisiere Dokument...", "laufend");
        
        // 1. Das zusammengefügte PDF speichern
        const mergedPdfBytes = await mergedPdf.save();

        // 2. Den Buffer direkt im globalen Objekt speichern (ohne Umwege über JS-Einschleusung)
        druckFortschritt.pdfBuffer = Buffer.from(mergedPdfBytes);
        
        sendLog("Sammel-PDF erfolgreich erstellt!", "fertig", "success");
        res.end();

    } catch (err) {
        console.error("Fehler beim Sammeldruck:", err);
        sendLog("Kritischer Fehler: " + err.message, "fertig", "danger");
        res.end();
    }
});

// Route 3: Das PDF tatsächlich ausliefern
app.get('/admin/drucken-abholen', adminSchutz, (req, res) => {
    if (!druckFortschritt.pdfBuffer) return res.send("Kein PDF gefunden. Bitte neu starten.");
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=Alle_Pruefungen.pdf');
    res.send(druckFortschritt.pdfBuffer);
    
    // Speicher danach leeren
    druckFortschritt.pdfBuffer = null;
});