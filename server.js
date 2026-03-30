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
            await db.run(`INSERT OR IGNORE INTO pruefer_accounts (station, anzeigename, passwort) 
                          VALUES (?, ?, ?)`, [sID, `Prüfer Station ${sID}`, '1234']);
        }
    } catch (err) { console.error("Sync Fehler:", err); }
}

async function berechneTeilnehmerStatus(db, t, alleErgebnisse, alleAufgaben) {
    try {
        if (!t) return { ...t, stationenDetails: [], fortschritt: 0, gesamtSoll: 0 };

        const tID = String(t.id).trim();
        const tAbzeichenRaw = t.abzeichen ? String(t.abzeichen).trim() : "";
        const tAbzeichenKey = tAbzeichenRaw.toLowerCase();

        // NEU: Wir nutzen die Sätze, die direkt beim Teilnehmer gespeichert sind
        // Falls leer (z.B. alter Datensatz), Fallback auf "A"
        const thSatz = (t.theorie_satz || "A").toString().toUpperCase();
        const prSatz = (t.praxis_satz || "A").toString().toUpperCase();

        // 1. Welche Aufgaben MUSS der Teilnehmer machen? (Nutzt prSatz für Praxis)
        const sollAufgaben = alleAufgaben.filter(a => {
            if (!a.abzeichen || !a.satz) return false;
            const stufenInCsv = a.abzeichen.toLowerCase().split(',').map(s => s.trim());
            const satzInCsv = String(a.satz).trim().toUpperCase();
            // Hier prüfen wir gegen den PRAXIS-Satz
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

                // Durchschnittsberechnung
    let gesamtProzent = 0;
    if (teilnehmer.length > 0) {
        const summe = teilnehmer.reduce((acc, t) => {
            let prozent = (t.gesamtSoll > 0) ? (t.fortschritt / t.gesamtSoll) * 100 : 0;
            return acc + prozent;
        }, 0);
        gesamtProzent = Math.round(summe / teilnehmer.length);
    }

    res.render('admin_management', { 
        teilnehmer, 
        gesamtFortschritt: gesamtProzent // Den Wert hier mitschicken
    });
        });

        // 3. Theorie prüfen
        const thErgebnis = hatErgebnisse.find(e => String(e.station).toLowerCase().includes('theorie'));
        const hatTheorie = !!thErgebnis;
        const theorieBestanden = thErgebnis?.status === 'bestanden' || thErgebnis?.status === true;
        const anzahlTheoriePunkte = thErgebnis ? thErgebnis.fehler : 0;

        const allePraxisAufgaben = stationenDetails.flatMap(s => s.details);
        const anzahlBestanden = allePraxisAufgaben.filter(d => d.status === 'bestanden').length;
        
        const regel = praxisRegeln[tAbzeichenKey] || { mindest: 0 };
        const praxisBestanden = anzahlBestanden >= regel.mindest;

        const erledigtePraxisCount = stationenDetails.filter(s => s.erledigt).length;
        const gesamtSoll = uniqueStations.length + 1;
        const fortschritt = erledigtePraxisCount + (hatTheorie ? 1 : 0);

        return {
            ...t,
            theorie_satz: thSatz, // Wichtig für das PDF Template
            praxis_satz: prSatz,   // Wichtig für das PDF Template
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
            gesamtBestanden: praxisBestanden && theorieBestanden
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
            CREATE TABLE IF NOT EXISTS teilnehmer (id TEXT PRIMARY KEY, name TEXT, vorname TEXT, abzeichen TEXT, theorie_satz TEXT, praxis_satz TEXT);
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

const authMiddleware = basicAuth({
    users: { 'THW': 'thw' }, // Dein Passwort
    challenge: true,
    realm: 'THW Interner Bereich',
    unauthorizedResponse: 'Zugriff verweigert.'
});

// --- SCHUTZ ANWENDEN ---

// 1. Schützt exakt die Startseite (/)
app.get('/', authMiddleware, (req, res, next) => {
    // Falls du eine normale Route für '/' hast, wird diese hier "abgefangen"
    // und nur nach Passwort-Eingabe weitergeleitet.
    next(); 
});

// 2. Schützt alles, was mit /admin beginnt
app.use('/admin', authMiddleware);

// --- OFFENE ROUTEN (WICHTIG) ---
// Alle anderen Routen (z.B. /start-aufgabe/:id) bleiben UNTERHALB 
// dieser Definitionen und ohne 'authMiddleware', damit sie frei bleiben.
// --- ROUTEN ---

app.get('/', async (req, res) => {
    try {
        const alleT = await db.all('SELECT * FROM teilnehmer ORDER BY CAST(id AS INTEGER) ASC');
        const tRows = alleT.filter(t => aktiveStufen.includes(t.abzeichen));
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
        const ergebnisse = ergebnisseRaw.filter(e => e.abzeichen === "N/A" || aktiveStufen.includes(e.abzeichen));

        res.render('index', { teilnehmer, ergebnisse, pruefungsKonfig, pruefungGestartet, aktiveStufen });
    } catch (err) { 
        res.status(500).send("Fehler im Dashboard: " + err.message); 
    }
});

app.get('/admin/teilnehmer', async (req, res) => {
    try {
        const tRows = await db.all('SELECT * FROM teilnehmer ORDER BY CAST(id AS INTEGER) ASC');
        const rohE = await db.all('SELECT * FROM ergebnisse');
        const aAll = await db.all('SELECT * FROM aufgaben_katalog');
        const teilnehmer = await Promise.all(tRows.map(t => berechneTeilnehmerStatus(db, t, rohE, aAll)));
        res.render('teilnehmer_management', { teilnehmer });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/admin/upload-teilnehmer', upload.single('csvfile'), (req, res) => {
    const results = [];
    const qrDir = './public/qrcodes';
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

    fs.createReadStream(req.file.path).pipe(csv({ separator: ';' }))
        .on('data', (data) => { if(data.id) results.push(data); })
        .on('end', async () => {
            for (let p of results) {
                // Hier sind jetzt 7 Fragezeichen für 7 Spalten
                await db.run('INSERT OR REPLACE INTO teilnehmer VALUES (?, ?, ?, ?, ?, ?, ?)', 
                    [p.id.toString().trim(), p.name, p.vorname, p.abzeichen, 'A', 'A', 'A']);
                await QRCode.toFile(`${qrDir}/${p.id.toString().trim()}.png`, p.id.toString().trim());
            }
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.redirect('/');
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
                // Holen der Werte aus dem Formular (z.B. Silber_theorie_satz)
                const thSatz = req.body[stufe + '_theorie_satz'] || 'A';
                const prSatz = req.body[stufe + '_praxis_satz'] || 'A';

                // WICHTIG: Hier schreiben wir die Auswahl fest in jeden Teilnehmer-Datensatz
                await db.run(
                    `UPDATE teilnehmer 
                     SET theorie_satz = ?, praxis_satz = ?, satz = ? 
                     WHERE abzeichen = ?`,
                    [thSatz, prSatz, prSatz, stufe]
                );

                // Auch die globale Konfig für andere Programmteile updaten
                pruefungsKonfig[stufe] = prSatz;
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
    const { id, name, vorname, abzeichen } = req.body;
    const cleanID = id.toString().trim();
    // Auch hier: 7 Werte für 7 Spalten
    await db.run('INSERT OR REPLACE INTO teilnehmer VALUES (?, ?, ?, ?, ?, ?, ?)', 
        [cleanID, name, vorname, abzeichen, 'A', 'A', 'A']);
    await QRCode.toFile(`./public/qrcodes/${cleanID}.png`, cleanID);
    res.redirect('/');
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
    const alleA = await db.all(`SELECT * FROM aufgaben_katalog ORDER BY CAST(station AS INTEGER) ASC`);
    const stationsPlan = {};
    alleA.forEach(aufg => {
        if (!aufg.abzeichen) return;
        const stufen = aufg.abzeichen.split(',').map(s => s.trim());
        if (stufen.some(s => aktiveStufen.includes(s) && pruefungsKonfig[s] === aufg.satz)) {
            if (!stationsPlan[aufg.station]) stationsPlan[aufg.station] = [];
            stationsPlan[aufg.station].push(aufg);
        }
    });
    res.render('admin_konfig_view', { stationsPlan, pruefungsKonfig, aktiveStufen });
});

app.post('/admin/update-aufgabe-station', async (req, res) => {
    await db.run('UPDATE aufgaben_katalog SET station = ? WHERE id = ?', [req.body.neue_station, req.body.aufgabe_id]);
    await syncStationsStatus();
    res.sendStatus(200);
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
    const { id, passwort } = req.body;
    const acc = await db.get('SELECT * FROM pruefer_accounts WHERE station = ? AND passwort = ?', [id, passwort]);
    if (acc || (id === 'admin' && passwort === 'admin')) {
        res.cookie('station', id);
        res.render('scanner', { station: id });
    } else res.send("Zugangsdaten falsch.");
});

app.get('/pruefen/:station_id/:id', async (req, res) => {
    try {
        const tID = req.params.id.toString().trim();
        const t = await db.get('SELECT * FROM teilnehmer WHERE id = ?', [tID]);
        if (!t) return res.send("ID unbekannt.");
        const sID = req.params.station_id.replace("Station ", "").trim();
        const aufgaben = await db.all('SELECT * FROM aufgaben_katalog WHERE abzeichen LIKE ? AND satz = ? AND station = ?', 
                                      [`%${t.abzeichen}%`, pruefungsKonfig[t.abzeichen], sID]);
        const erledigteErgebnisse = await db.all('SELECT aufgabe_id FROM ergebnisse WHERE teilnehmer_id = ? AND station = ?', [tID, req.params.station_id]);
        const erledigteIds = erledigteErgebnisse.map(e => e.aufgabe_id ? e.aufgabe_id.toString() : "");

        const aufgabenMitStatus = aufgaben.map(a => ({
            ...a,
            erledigt: erledigteIds.includes(a.id.toString())
        }));

        if (aufgabenMitStatus.length > 1 || (aufgabenMitStatus.length === 1 && aufgabenMitStatus[0].erledigt)) {
            res.render('aufgaben_auswahl', { t, station: req.params.station_id, aufgaben: aufgabenMitStatus });
        } else if (aufgabenMitStatus.length === 1) {
            const a = aufgabenMitStatus[0];
            stationsStatus[sID] = { status: "BESETZT", person: `${t.vorname} ${t.name}`, abzeichen: t.abzeichen, aufgabe: a.aufgabe_name };
            res.render('bewertung', { t, station: req.params.station_id, aufgabe: a });
        } else res.send("Keine Aufgabe gefunden.");
    } catch (err) { res.status(500).send(err.message); }
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
        if (stufen.some(s => aktiveStufen.includes(s) && pruefungsKonfig[s] === a.satz)) vSet.add(a.station.toString());
    });
    const vList = Array.from(vSet);
    if (pruefungGestartet) vList.push("Theorie");
    const gefiltert = {};
    vList.forEach(id => { gefiltert[id] = stationsStatus[id] || { status: "FREI", person: "", abzeichen: "", aufgabe: "" }; });
    res.render('dashboard', { stationsStatus: gefiltert, pruefungGestartet });
});

app.get('/admin-monitor', async (req, res) => {
    const aDB = await db.all('SELECT * FROM aufgaben_katalog');
    const vSet = new Set();
    const mapping = {};
    aDB.forEach(a => {
        if (!a.abzeichen) return;
        const stufen = a.abzeichen.split(',').map(s => s.trim());
        if (stufen.some(s => aktiveStufen.includes(s) && pruefungsKonfig[s] === a.satz)) {
            vSet.add(a.station.toString());
            if(!mapping[a.station]) mapping[a.station] = [];
            mapping[a.station].push(a.aufgabe_name);
        }
    });
    const gefiltert = {};
    Array.from(vSet).concat("Theorie").forEach(id => {
        gefiltert[id] = { 
            ...(stationsStatus[id] || { status: "FREI", person: "", abzeichen: "", aufgabe: "" }), 
            moeglicheAufgaben: mapping[id] || [] 
        };
    });
    res.render('admin_monitor', { stationsStatus: gefiltert });
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
        const tRow = await db.get('SELECT name FROM teilnehmer WHERE id = ?', [tID]);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Auswertung_${tRow.name}.pdf`);
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